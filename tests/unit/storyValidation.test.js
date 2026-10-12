const { createStorySchema } = require("../../src/validations/story.validation");

describe("createStorySchema", () => {
  test("accepts a valid caption", () => {
    const result = createStorySchema.safeParse({ caption: "Good morning!" });
    expect(result.success).toBe(true);
    expect(result.data.caption).toBe("Good morning!");
  });

  test("defaults caption to empty string when omitted", () => {
    const result = createStorySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data.caption).toBe("");
  });

  test("rejects a caption over 200 characters", () => {
    const result = createStorySchema.safeParse({ caption: "x".repeat(201) });
    expect(result.success).toBe(false);
  });

  test("accepts exactly 200 characters", () => {
    const result = createStorySchema.safeParse({ caption: "x".repeat(200) });
    expect(result.success).toBe(true);
  });
});
