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
});

module.exports = { sendMessageSchema };
