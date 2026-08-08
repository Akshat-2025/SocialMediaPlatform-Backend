const { z } = require("zod");

const createPostSchema = z.object({
  content: z.string().max(2000, "Post is too long").optional().default(""),
});

const updatePostSchema = z.object({
  content: z.string().max(2000, "Post is too long").optional(),
  removeImageIds: z.union([z.string(), z.array(z.string())]).optional(),
});

const createCommentSchema = z.object({
  content: z.string().min(1, "Comment cannot be empty").max(500, "Comment is too long"),
});

const updateCommentSchema = z.object({
  content: z.string().min(1, "Comment cannot be empty").max(500, "Comment is too long"),
});

module.exports = {
  createPostSchema,
  updatePostSchema,
  createCommentSchema,
  updateCommentSchema,
};
