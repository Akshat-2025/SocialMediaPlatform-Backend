const { z } = require("zod");

const createStorySchema = z.object({
  caption: z.string().max(200, "Caption is too long").optional().default(""),
});

module.exports = { createStorySchema };
