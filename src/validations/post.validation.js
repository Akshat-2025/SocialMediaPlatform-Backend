const { z } = require("zod");

const createPostSchema = z.object({
  content: z.string().max(2000, "Post is too long").optional().default(""),
});

const createCommentSchema = z.object({
  content: z.string().min(1, "Comment cannot be empty").max(500, "Comment is too long"),
});

module.exports = { createPostSchema, createCommentSchema };
