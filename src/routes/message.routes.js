const express = require("express");
const {
  getOrCreateConversation,
  getConversations,
  getMessages,
  sendMessage,
  markConversationRead,
} = require("../controllers/message.controller");
const { protect } = require("../middleware/auth.middleware");
const validate = require("../middleware/validate.middleware");
const { sendMessageSchema } = require("../validations/message.validation");

const router = express.Router();

router.use(protect);

router.get("/conversations", getConversations);
router.post("/conversations/:userId", getOrCreateConversation);

router.get("/conversations/:conversationId/messages", getMessages);
router.post(
  "/conversations/:conversationId/messages",
  validate(sendMessageSchema),
  sendMessage
);
router.patch("/conversations/:conversationId/read", markConversationRead);

module.exports = router;
