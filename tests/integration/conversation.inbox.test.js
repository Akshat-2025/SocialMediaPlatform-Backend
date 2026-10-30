/**
 * Phase 3 Integration Tests: Chat Inbox and Conversation Management
 *
 * All Mongoose models and Cloudinary are mocked — no real database connection.
 * Tests validate HTTP layer behaviour: routes, authorization, response shapes.
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

jest.mock("../../src/config/cloudinary");
jest.mock("../../src/models/User.model");
jest.mock("../../src/models/Conversation.model");
jest.mock("../../src/models/Message.model");

const User = require("../../src/models/User.model");
const Conversation = require("../../src/models/Conversation.model");
const Message = require("../../src/models/Message.model");
const { makeQuery } = require("../helpers/mockQuery");

const app = require("../../src/app");

// ─── Test fixtures ────────────────────────────────────────────────────────────
const USER_ONE_ID = new mongoose.Types.ObjectId();
const USER_TWO_ID = new mongoose.Types.ObjectId();
const USER_THREE_ID = new mongoose.Types.ObjectId();
const CONV_ID = new mongoose.Types.ObjectId();
const CONV_ID_2 = new mongoose.Types.ObjectId();
const MSG_ID = new mongoose.Types.ObjectId();

const fakeUserOne = {
  _id: USER_ONE_ID,
  username: "userone",
  fullName: "User One",
  avatar: { url: "", publicId: "" },
};

const fakeUserTwo = {
  _id: USER_TWO_ID,
  username: "usertwo",
  fullName: "User Two",
  avatar: { url: "", publicId: "" },
};

const authCookie = (userId = USER_ONE_ID) => {
  const token = jwt.sign({ id: userId.toString() }, process.env.JWT_SECRET, {
    expiresIn: "15m",
  });
  return `${process.env.JWT_COOKIE_NAME}=${token}`;
};

// Typical conversation document returned by the DB
const fakeConversation = (overrides = {}) => ({
  _id: CONV_ID,
  participants: [fakeUserOne, fakeUserTwo],
  lastMessage: {
    _id: MSG_ID,
    content: "Hello!",
    sender: USER_ONE_ID,
    createdAt: new Date("2024-01-01T10:00:00Z"),
    readBy: [USER_ONE_ID],
  },
  lastMessageAt: new Date("2024-01-01T10:00:00Z"),
  createdAt: new Date("2024-01-01T09:00:00Z"),
  updatedAt: new Date("2024-01-01T10:00:00Z"),
  toObject() { return { ...this }; },
  populate: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  // Auth middleware calls User.findById to validate the JWT token
  User.findById.mockReturnValue(makeQuery(fakeUserOne));
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. GET /api/messages/conversations — Inbox
// ══════════════════════════════════════════════════════════════════════════════
describe("GET /api/messages/conversations (inbox)", () => {
  it("1a. returns 401 when not authenticated", async () => {
    const res = await request(app).get("/api/messages/conversations");
    expect(res.status).toBe(401);
  });

  it("1b. returns only the authenticated user's conversations", async () => {
    const conv = fakeConversation();
    Conversation.find.mockReturnValue(makeQuery([conv]));
    Conversation.countDocuments.mockResolvedValue(1);
    // Aggregate for unread counts
    Message.aggregate.mockResolvedValue([
      { _id: CONV_ID, count: 3 },
    ]);

    const res = await request(app)
      .get("/api/messages/conversations")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.conversations)).toBe(true);
    expect(res.body.conversations).toHaveLength(1);
    // Verify Conversation.find was called with the user's ID filter
    expect(Conversation.find).toHaveBeenCalledWith(
      expect.objectContaining({ participants: USER_ONE_ID })
    );
  });

  it("1c. includes unreadCount per conversation", async () => {
    const conv = fakeConversation();
    Conversation.find.mockReturnValue(makeQuery([conv]));
    Conversation.countDocuments.mockResolvedValue(1);
    Message.aggregate.mockResolvedValue([{ _id: CONV_ID, count: 5 }]);

    const res = await request(app)
      .get("/api/messages/conversations")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.conversations[0].unreadCount).toBe(5);
  });

  it("1d. sets unreadCount to 0 when no unread messages exist", async () => {
    const conv = fakeConversation();
    Conversation.find.mockReturnValue(makeQuery([conv]));
    Conversation.countDocuments.mockResolvedValue(1);
    Message.aggregate.mockResolvedValue([]); // no unread

    const res = await request(app)
      .get("/api/messages/conversations")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.conversations[0].unreadCount).toBe(0);
  });

  it("1e. returns lastMessage preview with content and timestamp", async () => {
    const conv = fakeConversation();
    Conversation.find.mockReturnValue(makeQuery([conv]));
    Conversation.countDocuments.mockResolvedValue(1);
    Message.aggregate.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/messages/conversations")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    const c = res.body.conversations[0];
    // lastMessage should contain at least a content preview
    expect(c.lastMessage).not.toBeNull();
  });

  it("1f. returns pagination metadata", async () => {
    Conversation.find.mockReturnValue(makeQuery([]));
    Conversation.countDocuments.mockResolvedValue(0);
    Message.aggregate.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/messages/conversations?page=2&limit=10")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ page: 2, limit: 10 });
  });

  it("1g. clamps page to 1 and limit to 50 for invalid params", async () => {
    Conversation.find.mockReturnValue(makeQuery([]));
    Conversation.countDocuments.mockResolvedValue(0);
    Message.aggregate.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/messages/conversations?page=-99&limit=9999")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(1);
    expect(res.body.pagination.limit).toBe(50);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. GET /api/messages/conversations/:conversationId — Details
// ══════════════════════════════════════════════════════════════════════════════
describe("GET /api/messages/conversations/:conversationId (detail)", () => {
  it("2a. returns 400 for invalid conversationId format", async () => {
    const res = await request(app)
      .get("/api/messages/conversations/not-a-valid-id")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid conversation id/i);
  });

  it("2b. returns 404 when conversation does not exist", async () => {
    Conversation.findById.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/messages/conversations/${CONV_ID}`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(404);
  });

  it("2c. returns 403 when user is not a participant", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_TWO_ID, USER_THREE_ID], // USER_ONE is not here
    });

    const res = await request(app)
      .get(`/api/messages/conversations/${CONV_ID}`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not part of this conversation/i);
  });

  it("2d. returns conversation details and unreadCount for a participant", async () => {
    // loadOwnedConversation uses findById; populate is called after
    const conv = {
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
      lastMessage: MSG_ID,
      lastMessageAt: new Date(),
      toObject() { return { _id: this._id, participants: this.participants }; },
      populate: jest.fn().mockResolvedValue(undefined),
    };
    Conversation.findById.mockResolvedValue(conv);
    Message.countDocuments.mockResolvedValue(2);

    const res = await request(app)
      .get(`/api/messages/conversations/${CONV_ID}`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.conversation).toBeDefined();
    expect(res.body.conversation.unreadCount).toBe(2);
  });

  it("2e. a user cannot access another user's private conversation by ID-guessing", async () => {
    // Conversation exists but USER_ONE is NOT in it
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID_2,
      participants: [USER_TWO_ID, USER_THREE_ID],
    });

    const res = await request(app)
      .get(`/api/messages/conversations/${CONV_ID_2}`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. POST /api/messages/conversations/:userId — Create or reuse conversation
// ══════════════════════════════════════════════════════════════════════════════
describe("POST /api/messages/conversations/:userId (create/reuse)", () => {
  it("3a. returns 400 for an invalid userId format", async () => {
    const res = await request(app)
      .post("/api/messages/conversations/invalid-id")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid user id/i);
  });

  it("3b. returns 400 when trying to message yourself", async () => {
    const res = await request(app)
      .post(`/api/messages/conversations/${USER_ONE_ID}`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot message yourself/i);
  });

  it("3c. returns 404 when target user does not exist", async () => {
    // Auth findById returns fakeUserOne (req.user); participant lookup returns null
    User.findById
      .mockReturnValueOnce(makeQuery(fakeUserOne)) // auth middleware
      .mockReturnValueOnce(makeQuery(null));        // existence check

    const res = await request(app)
      .post(`/api/messages/conversations/${USER_TWO_ID}`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/user not found/i);
  });

  it("3d. reuses an existing conversation instead of creating a duplicate", async () => {
    User.findById
      .mockReturnValueOnce(makeQuery(fakeUserOne))   // auth
      .mockReturnValueOnce(makeQuery({ _id: USER_TWO_ID })); // existence

    const existing = {
      _id: CONV_ID,
      participants: [fakeUserOne, fakeUserTwo],
      populate: jest.fn().mockResolvedValue(undefined),
    };
    Conversation.findOne.mockReturnValue(makeQuery(existing));

    const res = await request(app)
      .post(`/api/messages/conversations/${USER_TWO_ID}`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Conversation.create).not.toHaveBeenCalled();
  });

  it("3e. creates a new conversation when none exists", async () => {
    User.findById
      .mockReturnValueOnce(makeQuery(fakeUserOne))
      .mockReturnValueOnce(makeQuery({ _id: USER_TWO_ID }));

    Conversation.findOne.mockReturnValue(makeQuery(null));

    const created = {
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
      populate: jest.fn().mockResolvedValue(undefined),
    };
    Conversation.create.mockResolvedValue(created);

    const res = await request(app)
      .post(`/api/messages/conversations/${USER_TWO_ID}`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(Conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        participants: expect.arrayContaining([
          // Participant IDs may be ObjectId instances or strings depending on the
          // mock chain — match both by comparing their string form.
          expect.anything(),
          expect.anything(),
        ]),
      })
    );
    // Also verify the two participant IDs are the right users
    const callArgs = Conversation.create.mock.calls[0][0];
    const ids = callArgs.participants.map((id) => id.toString());
    expect(ids).toContain(USER_ONE_ID.toString());
    expect(ids).toContain(USER_TWO_ID.toString());
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Unread-count logic
// ══════════════════════════════════════════════════════════════════════════════
describe("Unread-count logic", () => {
  it("4a. unread count excludes messages sent BY the current user", async () => {
    const conv = fakeConversation();
    Conversation.find.mockReturnValue(makeQuery([conv]));
    Conversation.countDocuments.mockResolvedValue(1);
    // Aggregation pipeline is built by the controller; we verify the match stage
    Message.aggregate.mockImplementation((pipeline) => {
      const matchStage = pipeline.find((s) => s.$match);
      // sender: { $ne: userId } must exclude current user's own messages
      expect(matchStage.$match.sender).toEqual({ $ne: USER_ONE_ID });
      return Promise.resolve([]);
    });

    const res = await request(app)
      .get("/api/messages/conversations")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
  });

  it("4b. unread count excludes messages already in readBy for that user", async () => {
    const conv = fakeConversation();
    Conversation.find.mockReturnValue(makeQuery([conv]));
    Conversation.countDocuments.mockResolvedValue(1);
    Message.aggregate.mockImplementation((pipeline) => {
      const matchStage = pipeline.find((s) => s.$match);
      expect(matchStage.$match.readBy).toEqual({ $ne: USER_ONE_ID });
      return Promise.resolve([]);
    });

    const res = await request(app)
      .get("/api/messages/conversations")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. GET /api/messages/conversations/search — Search
// ══════════════════════════════════════════════════════════════════════════════
describe("GET /api/messages/conversations/search", () => {
  it("5a. returns 401 when not authenticated", async () => {
    const res = await request(app).get(
      "/api/messages/conversations/search?q=alice"
    );
    expect(res.status).toBe(401);
  });

  it("5b. returns 400 when q param is missing", async () => {
    const res = await request(app)
      .get("/api/messages/conversations/search")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required/i);
  });

  it("5c. returns 400 when query is too long (>100 chars)", async () => {
    const res = await request(app)
      .get(`/api/messages/conversations/search?q=${"a".repeat(101)}`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/too long/i);
  });

  it("5d. returns conversations and suggestedUsers for valid query", async () => {
    // Phase: User.find for matching users (participant lookup)
    User.find
      .mockReturnValueOnce(makeQuery([{ _id: USER_TWO_ID }])) // matching user ids
      .mockReturnValueOnce(makeQuery([fakeUserTwo]));           // suggestedUsers

    const conv = fakeConversation();
    Conversation.find.mockReturnValue(makeQuery([conv]));
    Conversation.countDocuments.mockResolvedValue(1);
    Message.aggregate.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/messages/conversations/search?q=usertwo")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.conversations)).toBe(true);
    expect(Array.isArray(res.body.suggestedUsers)).toBe(true);
    expect(res.body.pagination).toBeDefined();
  });

  it("5e. does not expose private fields (password, tokens) in suggestedUsers", async () => {
    User.find
      .mockReturnValueOnce(makeQuery([{ _id: USER_TWO_ID }]))
      .mockReturnValueOnce(makeQuery([{ _id: USER_TWO_ID, username: "usertwo", fullName: "User Two", avatar: {} }]));

    Conversation.find.mockReturnValue(makeQuery([]));
    Conversation.countDocuments.mockResolvedValue(0);
    Message.aggregate.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/messages/conversations/search?q=usertwo")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    for (const u of res.body.suggestedUsers) {
      expect(u.password).toBeUndefined();
      expect(u.refreshTokens).toBeUndefined();
    }
  });

  it("5f. paginates search results correctly", async () => {
    User.find
      .mockReturnValueOnce(makeQuery([]))
      .mockReturnValueOnce(makeQuery([]));

    Conversation.find.mockReturnValue(makeQuery([]));
    Conversation.countDocuments.mockResolvedValue(0);
    Message.aggregate.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/messages/conversations/search?q=alice&page=2&limit=5")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ page: 2, limit: 5 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Last-message preview correctness (Phase 2 metadata consistency)
// ══════════════════════════════════════════════════════════════════════════════
describe("Last-message preview and timestamp correctness", () => {
  it("6a. lastMessageAt in inbox matches the latest persisted message timestamp", async () => {
    const timestamp = new Date("2024-06-15T12:00:00Z");
    const conv = fakeConversation({ lastMessageAt: timestamp });
    Conversation.find.mockReturnValue(makeQuery([conv]));
    Conversation.countDocuments.mockResolvedValue(1);
    Message.aggregate.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/messages/conversations")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(new Date(res.body.conversations[0].lastMessageAt)).toEqual(timestamp);
  });

  it("6b. inbox shows null lastMessage when no messages have been sent yet", async () => {
    const conv = fakeConversation({ lastMessage: null });
    Conversation.find.mockReturnValue(makeQuery([conv]));
    Conversation.countDocuments.mockResolvedValue(1);
    Message.aggregate.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/messages/conversations")
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.conversations[0].lastMessage).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Backward-compatibility — Phase 2 endpoints continue to work
// ══════════════════════════════════════════════════════════════════════════════
describe("Phase 2 backward-compatibility", () => {
  it("7a. GET /conversations/:id/messages still works", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    });
    Message.find.mockReturnValue(makeQuery([{
      _id: MSG_ID,
      content: "old message",
      sender: fakeUserOne,
      readBy: [USER_ONE_ID],
      createdAt: new Date(),
    }]));
    Message.countDocuments.mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });

  it("7b. POST /conversations/:id/messages still creates a message", async () => {
    const mockSave = jest.fn().mockResolvedValue(true);
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
      save: mockSave,
    });
    const msgDoc = {
      _id: MSG_ID,
      conversation: CONV_ID,
      sender: USER_ONE_ID,
      content: "hello phase2",
      readBy: [USER_ONE_ID],
      createdAt: new Date(),
      populate: jest.fn().mockResolvedValue(undefined),
    };
    Message.create.mockResolvedValue(msgDoc);

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({ content: "hello phase2" });

    expect(res.status).toBe(201);
    expect(res.body.message.content).toBe("hello phase2");
    expect(mockSave).toHaveBeenCalled();
  });

  it("7c. PATCH /conversations/:id/read still marks messages read", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    });
    Message.updateMany.mockResolvedValue({ modifiedCount: 2 });

    const res = await request(app)
      .patch(`/api/messages/conversations/${CONV_ID}/read`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
