/**
 * HTTP-layer tests for the Stories feature, run against the real Express app
 * (src/app.js) with the Mongoose models and Cloudinary mocked out.
 *
 * Why mocked rather than a real database: this sandbox's network proxy
 * blocks the binary download mongodb-memory-server needs, and we're not
 * running tests against anyone's real MongoDB/Cloudinary. That means this
 * suite proves the route wiring, auth/ownership checks, request validation,
 * and controller branching logic are correct — it does NOT prove MongoDB's
 * unique-index/upsert atomicity itself (that's a documented MongoDB
 * guarantee this code relies on, not something re-implemented here).
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

jest.mock("../../src/config/cloudinary");
jest.mock("../../src/models/User.model");
jest.mock("../../src/models/Story.model");
jest.mock("../../src/models/StoryView.model");

const cloudinaryMock = require("../../src/config/cloudinary");
const User = require("../../src/models/User.model");
const Story = require("../../src/models/Story.model");
const StoryView = require("../../src/models/StoryView.model");
const { makeQuery } = require("../helpers/mockQuery");

const app = require("../../src/app");

const AUTHOR_ID = new mongoose.Types.ObjectId().toString();
const OTHER_USER_ID = new mongoose.Types.ObjectId().toString();
const FOLLOWED_USER_ID = new mongoose.Types.ObjectId().toString();

const fakeMe = {
  _id: AUTHOR_ID,
  username: "me",
  fullName: "Test User",
  avatar: { url: "", publicId: "" },
  following: [FOLLOWED_USER_ID],
};

const authCookie = () => {
  const token = jwt.sign({ id: AUTHOR_ID }, process.env.JWT_SECRET, { expiresIn: "15m" });
  return `${process.env.JWT_COOKIE_NAME}=${token}`;
};

// Minimal valid signatures, same as tests/unit/detectMediaType.test.js
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const MP4_BUFFER = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from("ftyp", "ascii"),
  Buffer.from("isom", "ascii"),
]);

beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockReturnValue(makeQuery(fakeMe));
  cloudinaryMock.__nextUploadResult = {
    secure_url: "https://res.cloudinary.com/demo/image/upload/v1/social-media/stories/x.jpg",
    public_id: "social-media/stories/x",
  };
});

describe("POST /api/stories (create)", () => {
  test("401s with no auth cookie", async () => {
    const res = await request(app).post("/api/stories");
    expect(res.status).toBe(401);
  });

  test("400s when no file is attached", async () => {
    const res = await request(app)
      .post("/api/stories")
      .set("Cookie", authCookie())
      .field("caption", "hi");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no media file/i);
  });

  test("creates an image story and sets expiresAt ~24h out", async () => {
    Story.create.mockImplementation(async (doc) => ({
      ...doc,
      _id: new mongoose.Types.ObjectId(),
      viewsCount: 0,
      createdAt: new Date(),
      populate: jest.fn().mockResolvedValue(undefined),
    }));

    const before = Date.now();
    const res = await request(app)
      .post("/api/stories")
      .set("Cookie", authCookie())
      .attach("media", JPEG_BUFFER, { filename: "story.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(201);
    expect(Story.create).toHaveBeenCalledTimes(1);
    const created = Story.create.mock.calls[0][0];
    expect(created.author.toString()).toBe(AUTHOR_ID);
    expect(created.mediaType).toBe("image");
    const deltaMs = new Date(created.expiresAt).getTime() - before;
    expect(deltaMs).toBeGreaterThan(24 * 60 * 60 * 1000 - 5000);
    expect(deltaMs).toBeLessThan(24 * 60 * 60 * 1000 + 5000);
  });

  test("creates a video story, storing Cloudinary-reported duration and a derived thumbnail", async () => {
    cloudinaryMock.__nextUploadResult = {
      secure_url: "https://res.cloudinary.com/demo/video/upload/v1/social-media/stories/vid.mp4",
      public_id: "social-media/stories/vid",
      duration: 12.4,
    };
    Story.create.mockImplementation(async (doc) => ({
      ...doc,
      _id: new mongoose.Types.ObjectId(),
      viewsCount: 0,
      createdAt: new Date(),
      populate: jest.fn().mockResolvedValue(undefined),
    }));

    const res = await request(app)
      .post("/api/stories")
      .set("Cookie", authCookie())
      .attach("media", MP4_BUFFER, { filename: "story.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(201);
    const created = Story.create.mock.calls[0][0];
    expect(created.mediaType).toBe("video");
    expect(created.duration).toBe(12.4);
    expect(created.thumbnailUrl).toContain("social-media/stories/vid");
  });

  test("rejects a video over the configured duration cap and cleans up the uploaded asset", async () => {
    cloudinaryMock.__nextUploadResult = {
      secure_url: "https://res.cloudinary.com/demo/video/upload/v1/social-media/stories/toolong.mp4",
      public_id: "social-media/stories/toolong",
      duration: 120, // cap in tests/setup.js is 60s
    };

    const res = await request(app)
      .post("/api/stories")
      .set("Cookie", authCookie())
      .attach("media", MP4_BUFFER, { filename: "story.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/exceeds the maximum duration/i);
    expect(Story.create).not.toHaveBeenCalled();
    expect(cloudinaryMock.uploader.destroy).toHaveBeenCalledWith(
      "social-media/stories/toolong",
      expect.objectContaining({ resource_type: "video" })
    );
  });

  test("rejects a file whose real content doesn't match its declared mimetype", async () => {
    // A PNG's actual bytes, declared to Multer as a video — the magic-byte
    // sniff should catch this even though it passed the mimetype filter.
    const res = await request(app)
      .post("/api/stories")
      .set("Cookie", authCookie())
      .attach("media", PNG_BUFFER, { filename: "fake.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not match its declared type/i);
    expect(Story.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/stories/feed", () => {
  test("queries only the author's own id + followed ids, with an explicit expiresAt filter", async () => {
    Story.find.mockReturnValue(makeQuery([]));

    const res = await request(app).get("/api/stories/feed").set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.storyGroups).toEqual([]);

    const filter = Story.find.mock.calls[0][0];
    expect(filter.author.$in.map(String).sort()).toEqual([AUTHOR_ID, FOLLOWED_USER_ID].sort());
    expect(filter.expiresAt.$gt).toBeInstanceOf(Date);
  });

  test("groups stories by creator, marks own stories as always seen, and flags unseen for others", async () => {
    const myStoryId = new mongoose.Types.ObjectId();
    const theirStoryId = new mongoose.Types.ObjectId();

    Story.find.mockReturnValue(
      makeQuery([
        {
          _id: myStoryId,
          author: { _id: AUTHOR_ID, username: "me", fullName: "Test User", avatar: {} },
          mediaType: "image",
          mediaUrl: "https://example.com/mine.jpg",
          viewsCount: 0,
          caption: "",
          createdAt: new Date(Date.now() - 1000),
          expiresAt: new Date(Date.now() + 1000),
        },
        {
          _id: theirStoryId,
          author: {
            _id: FOLLOWED_USER_ID,
            username: "friend",
            fullName: "A Friend",
            avatar: {},
          },
          mediaType: "image",
          mediaUrl: "https://example.com/theirs.jpg",
          viewsCount: 3,
          caption: "hey",
          createdAt: new Date(Date.now() - 2000),
          expiresAt: new Date(Date.now() + 1000),
        },
      ])
    );
    StoryView.find.mockReturnValue(makeQuery([])); // I haven't viewed anything yet

    const res = await request(app).get("/api/stories/feed").set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.storyGroups).toHaveLength(2);

    const [mine, theirs] = res.body.storyGroups;
    expect(mine.user.id).toBe(AUTHOR_ID);
    expect(mine.stories[0].hasViewed).toBe(true); // own story — always "seen"
    expect(mine.hasUnseen).toBe(false);

    expect(theirs.user.id).toBe(FOLLOWED_USER_ID);
    expect(theirs.stories[0].hasViewed).toBe(false); // not in viewedSet
    expect(theirs.hasUnseen).toBe(true);
  });
});

describe("GET /api/stories/user/:userId", () => {
  test("404s when the user doesn't exist", async () => {
    User.findById.mockReturnValueOnce(makeQuery(fakeMe)); // for protect middleware
    User.findById.mockReturnValueOnce(makeQuery(null)); // for the controller's own lookup

    const res = await request(app)
      .get(`/api/stories/user/${OTHER_USER_ID}`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(404);
  });

  test("400s on a malformed userId", async () => {
    const res = await request(app)
      .get("/api/stories/user/not-a-valid-id")
      .set("Cookie", authCookie());
    expect(res.status).toBe(400);
  });
});

describe("POST /api/stories/:storyId/view", () => {
  const storyId = new mongoose.Types.ObjectId().toString();

  test("404s on an expired or nonexistent story", async () => {
    Story.findOne.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/stories/${storyId}/view`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(404);
  });

  test("first view from a non-owner increments viewsCount exactly once", async () => {
    Story.findOne.mockResolvedValue({ _id: storyId, author: OTHER_USER_ID });
    StoryView.findOneAndUpdate.mockResolvedValue(null); // null == "this call just inserted it"
    Story.findByIdAndUpdate.mockResolvedValue({});
    Story.findById.mockReturnValue(makeQuery({ viewsCount: 1 }));

    const res = await request(app)
      .post(`/api/stories/${storyId}/view`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.viewsCount).toBe(1);
    expect(Story.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    expect(Story.findByIdAndUpdate).toHaveBeenCalledWith(
      storyId,
      expect.objectContaining({ $inc: { viewsCount: 1 } })
    );
  });

  test("a repeat view does not increment viewsCount again", async () => {
    Story.findOne.mockResolvedValue({ _id: storyId, author: OTHER_USER_ID });
    StoryView.findOneAndUpdate.mockResolvedValue({ _id: "already-exists" }); // truthy == pre-existing row
    Story.findById.mockReturnValue(makeQuery({ viewsCount: 1 }));

    const res = await request(app)
      .post(`/api/stories/${storyId}/view`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(Story.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test("the owner viewing their own story never creates a view row or bumps the count", async () => {
    Story.findOne.mockResolvedValue({ _id: storyId, author: AUTHOR_ID }); // same as the cookie's user
    Story.findById.mockReturnValue(makeQuery({ viewsCount: 0 }));

    const res = await request(app)
      .post(`/api/stories/${storyId}/view`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(StoryView.findOneAndUpdate).not.toHaveBeenCalled();
    expect(Story.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test("a concurrent-insert race (duplicate key on the unique index) is treated as a normal repeat view, not an error", async () => {
    Story.findOne.mockResolvedValue({ _id: storyId, author: OTHER_USER_ID });
    const dupError = new Error("E11000 duplicate key");
    dupError.code = 11000;
    StoryView.findOneAndUpdate.mockRejectedValue(dupError);
    Story.findById.mockReturnValue(makeQuery({ viewsCount: 1 }));

    const res = await request(app)
      .post(`/api/stories/${storyId}/view`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(Story.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});

describe("GET /api/stories/:storyId/viewers", () => {
  const storyId = new mongoose.Types.ObjectId().toString();

  test("403s for a non-owner", async () => {
    Story.findById.mockResolvedValue({ _id: storyId, author: OTHER_USER_ID });

    const res = await request(app)
      .get(`/api/stories/${storyId}/viewers`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(403);
  });

  test("owner gets a paginated viewer list, with deleted-account rows filtered out", async () => {
    Story.findById.mockResolvedValue({ _id: storyId, author: AUTHOR_ID });
    StoryView.find.mockReturnValue(
      makeQuery([
        { viewer: { _id: OTHER_USER_ID, username: "bob", fullName: "Bob", avatar: {} }, viewedAt: new Date() },
        { viewer: null, viewedAt: new Date() }, // account since deleted
      ])
    );
    StoryView.countDocuments.mockResolvedValue(2);

    const res = await request(app)
      .get(`/api/stories/${storyId}/viewers`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.viewers).toHaveLength(1);
    expect(res.body.viewers[0].user.username).toBe("bob");
    expect(res.body.viewers[0].user).not.toHaveProperty("email");
  });
});

describe("DELETE /api/stories/:storyId", () => {
  const storyId = new mongoose.Types.ObjectId().toString();

  test("403s for a non-owner and does not touch Cloudinary", async () => {
    Story.findById.mockResolvedValue({ _id: storyId, author: OTHER_USER_ID });

    const res = await request(app).delete(`/api/stories/${storyId}`).set("Cookie", authCookie());

    expect(res.status).toBe(403);
    expect(cloudinaryMock.uploader.destroy).not.toHaveBeenCalled();
  });

  test("owner can delete: removes Cloudinary asset, StoryViews, and the story itself", async () => {
    const deleteOne = jest.fn().mockResolvedValue({});
    Story.findById.mockResolvedValue({
      _id: storyId,
      author: AUTHOR_ID,
      publicId: "social-media/stories/abc",
      mediaType: "video",
      deleteOne,
    });
    StoryView.deleteMany.mockResolvedValue({ deletedCount: 2 });

    const res = await request(app).delete(`/api/stories/${storyId}`).set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(cloudinaryMock.uploader.destroy).toHaveBeenCalledWith(
      "social-media/stories/abc",
      expect.objectContaining({ resource_type: "video" })
    );
    expect(StoryView.deleteMany).toHaveBeenCalledWith({ story: storyId });
    expect(deleteOne).toHaveBeenCalledTimes(1);
  });

  test("a Cloudinary failure during delete does not block the story from being removed", async () => {
    const deleteOne = jest.fn().mockResolvedValue({});
    Story.findById.mockResolvedValue({
      _id: storyId,
      author: AUTHOR_ID,
      publicId: "social-media/stories/abc",
      mediaType: "image",
      deleteOne,
    });
    cloudinaryMock.uploader.destroy.mockRejectedValueOnce(new Error("Cloudinary is down"));
    StoryView.deleteMany.mockResolvedValue({ deletedCount: 0 });

    const res = await request(app).delete(`/api/stories/${storyId}`).set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(deleteOne).toHaveBeenCalledTimes(1);
  });
});

describe("regression: unrelated existing routes are unaffected", () => {
  test("GET /api/posts still resolves (401 without auth, not a 404 route-not-found)", async () => {
    const res = await request(app).get("/api/posts");
    expect(res.status).toBe(401);
  });

  test("GET /api/health is untouched", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
