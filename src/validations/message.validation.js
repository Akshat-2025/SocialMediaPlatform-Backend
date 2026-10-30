const { z } = require("zod");

const sendMessageSchema = z.object({
  content: z
    .string({
      required_error: "Message cannot be empty",
      invalid_type_error: "Message cannot be empty",
    })
    .trim()
    .min(1, "Message cannot be empty")
    .max(2000, "Message is too long"),
  clientMessageId: z.string().optional(),
  replyTo: z.string().nullable().optional(),
});

const reactionSchema = z.object({
  emoji: z
    .string({
      required_error: "Emoji is required",
      invalid_type_error: "Emoji is required",
    })
    .trim()
    .min(1, "Emoji cannot be empty")
    .max(16, "Emoji is too long"),
});

module.exports = { sendMessageSchema, reactionSchema };
