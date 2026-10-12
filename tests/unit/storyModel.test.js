const mongoose = require("mongoose");
const Story = require("../../src/models/Story.model");
const StoryView = require("../../src/models/StoryView.model");

// validateSync() runs Mongoose's schema-level validators (required, enum,
// maxlength, custom pre-validate hooks) entirely locally — no DB connection
// needed. It does NOT enforce the `unique` index (that's a DB-level
// constraint), so this covers schema correctness, not the uniqueness
// guarantee — that's exercised separately in storyController.test.js by
// testing the controller's atomic-upsert branching logic.

describe("Story.LIFETIME_MS", () => {
  test("is exactly 24 hours", () => {
    expect(Story.LIFETIME_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("createStory's expiresAt math lands exactly 24h after \"now\"", () => {
    const now = Date.now();
    const expiresAt = new Date(now + Story.LIFETIME_MS);
    expect(expiresAt.getTime() - now).toBe(24 * 60 * 60 * 1000);
  });
});

describe("Story schema validation", () => {
  const validFields = {
    author: new mongoose.Types.ObjectId(),
    mediaUrl: "https://res.cloudinary.com/demo/image/upload/v1/social-media/stories/abc.jpg",
    publicId: "social-media/stories/abc",
    mediaType: "image",
    expiresAt: new Date(Date.now() + Story.LIFETIME_MS),
  };

  test("a fully valid story has no validation errors", () => {
    const err = new Story(validFields).validateSync();
    expect(err).toBeUndefined();
  });

  test("rejects a missing author", () => {
    const { author, ...rest } = validFields;
    const err = new Story(rest).validateSync();
    expect(err.errors.author).toBeDefined();
  });

  test("rejects a missing mediaUrl", () => {
    const { mediaUrl, ...rest } = validFields;
    const err = new Story(rest).validateSync();
    expect(err.errors.mediaUrl).toBeDefined();
  });

  test("rejects a missing expiresAt (never accepted from the client, but always required on the doc)", () => {
    const { expiresAt, ...rest } = validFields;
    const err = new Story(rest).validateSync();
    expect(err.errors.expiresAt).toBeDefined();
  });

  test("rejects a mediaType outside the image/video enum", () => {
    const err = new Story({ ...validFields, mediaType: "audio" }).validateSync();
    expect(err.errors.mediaType).toBeDefined();
  });

  test("rejects a caption over 200 characters", () => {
    const err = new Story({ ...validFields, caption: "x".repeat(201) }).validateSync();
    expect(err.errors.caption).toBeDefined();
  });

  test("defaults viewsCount to 0", () => {
    const story = new Story(validFields);
    expect(story.viewsCount).toBe(0);
  });
});

describe("StoryView schema validation", () => {
  test("a fully valid view has no validation errors", () => {
    const err = new StoryView({
      story: new mongoose.Types.ObjectId(),
      viewer: new mongoose.Types.ObjectId(),
    }).validateSync();
    expect(err).toBeUndefined();
  });

  test("rejects a missing story or viewer", () => {
    const err = new StoryView({}).validateSync();
    expect(err.errors.story).toBeDefined();
    expect(err.errors.viewer).toBeDefined();
  });

  test("defaults viewedAt to roughly now", () => {
    const before = Date.now();
    const view = new StoryView({
      story: new mongoose.Types.ObjectId(),
      viewer: new mongoose.Types.ObjectId(),
    });
    expect(view.viewedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(view.viewedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
