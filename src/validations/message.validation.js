const { z } = require("zod");

const sendMessageSchema = z.object({
  content: z.string().min(1, "Message cannot be empty").max(2000, "Message is too long"),
});

module.exports = { sendMessageSchema };
