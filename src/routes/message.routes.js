const express = require("express");
const {
  getOrCreateConversation,
  getConversations,
  getConversation,
  getMessages,
  sendMessage,
  markConversationRead,
  searchConversations,
  addOrUpdateReaction,
  removeReaction,
} = require("../controllers/message.controller");
const { protect } = require("../middleware/auth.middleware");
const validate = require("../middleware/validate.middleware");
const { sendMessageSchema, reactionSchema } = require("../validations/message.validation");

const router = express.Router();

router.use(protect);

// Conversation-level routes
router.get("/conversations", getConversations);
// IMPORTANT: /search must be declared before /:conversationId to avoid
// Express matching the literal "search" string as a conversationId.
router.get("/conversations/search", searchConversations);
router.post("/conversations/:userId", getOrCreateConversation);

// Single-conversation detail
router.get("/conversations/:conversationId", getConversation);

// Message-level routes within a conversation
router.get("/conversations/:conversationId/messages", getMessages);
router.post(
  "/conversations/:conversationId/messages",
  validate(sendMessageSchema),
  sendMessage
);
router.patch("/conversations/:conversationId/read", markConversationRead);

// Reaction routes within a conversation message
router.post(
  "/conversations/:conversationId/messages/:messageId/reactions",
  validate(reactionSchema),
  addOrUpdateReaction
);
router.put(
  "/conversations/:conversationId/messages/:messageId/reactions",
  validate(reactionSchema),
  addOrUpdateReaction
);
router.delete(
  "/conversations/:conversationId/messages/:messageId/reactions",
  removeReaction
);

module.exports = router;

