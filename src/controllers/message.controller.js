const mongoose = require("mongoose");
const Conversation = require("../models/Conversation.model");
const Message = require("../models/Message.model");

const PARTICIPANT_SELECT = "username fullName avatar";

// @route  POST /api/messages/conversations/:userId
// Finds an existing 1:1 conversation with :userId, or creates one.
const getOrCreateConversation = async (req, res, next) => {
  try {
    const otherUserId = req.params.userId;

    if (!mongoose.Types.ObjectId.isValid(otherUserId)) {
      return res.status(400).json({ success: false, message: "Invalid user id" });
    }

    if (otherUserId === req.user._id.toString()) {
      return res
        .status(400)
        .json({ success: false, message: "You cannot message yourself" });
    }

    let conversation = await Conversation.findOne({
      participants: { $all: [req.user._id, otherUserId], $size: 2 },
    }).populate("participants", PARTICIPANT_SELECT);

    if (!conversation) {
      conversation = await Conversation.create({
        participants: [req.user._id, otherUserId],
      });
      await conversation.populate("participants", PARTICIPANT_SELECT);
    }

    res.status(200).json({ success: true, conversation });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/messages/conversations?page=&limit=
const getConversations = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const [conversations, total] = await Promise.all([
      Conversation.find({ participants: req.user._id })
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("participants", PARTICIPANT_SELECT)
        .populate("lastMessage"),
      Conversation.countDocuments({ participants: req.user._id }),
    ]);

    res.status(200).json({
      success: true,
      conversations,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// Shared guard: confirms req.user is a participant, 404s/403s otherwise
const loadOwnedConversation = async (req, res) => {
  const conversation = await Conversation.findById(req.params.conversationId);

  if (!conversation) {
    res.status(404).json({ success: false, message: "Conversation not found" });
    return null;
  }

  const isParticipant = conversation.participants.some(
    (id) => id.toString() === req.user._id.toString()
  );

  if (!isParticipant) {
    res.status(403).json({ success: false, message: "Not part of this conversation" });
    return null;
  }

  return conversation;
};

// @route  GET /api/messages/conversations/:conversationId/messages?page=&limit=
const getMessages = async (req, res, next) => {
  try {
    const conversation = await loadOwnedConversation(req, res);
    if (!conversation) return;

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 30, 50);
    const skip = (page - 1) * limit;

    const [messages, total] = await Promise.all([
      Message.find({ conversation: conversation._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("sender", PARTICIPANT_SELECT),
      Message.countDocuments({ conversation: conversation._id }),
    ]);

    res.status(200).json({
      success: true,
      messages,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// @route  POST /api/messages/conversations/:conversationId/messages
const sendMessage = async (req, res, next) => {
  try {
    const conversation = await loadOwnedConversation(req, res);
    if (!conversation) return;

    const message = await Message.create({
      conversation: conversation._id,
      sender: req.user._id,
      content: req.body.content,
      readBy: [req.user._id],
    });

    conversation.lastMessage = message._id;
    conversation.lastMessageAt = message.createdAt;
    await conversation.save();

    await message.populate("sender", PARTICIPANT_SELECT);

    // Push to the other participant(s) in real time
    const io = req.app.get("io");
    if (io) {
      conversation.participants
        .filter((id) => id.toString() !== req.user._id.toString())
        .forEach((id) => {
          io.to(`user:${id}`).emit("message:new", {
            conversationId: conversation._id,
            message,
          });
        });
    }

    res.status(201).json({ success: true, message });
  } catch (error) {
    next(error);
  }
};

// @route  PATCH /api/messages/conversations/:conversationId/read
const markConversationRead = async (req, res, next) => {
  try {
    const conversation = await loadOwnedConversation(req, res);
    if (!conversation) return;

    await Message.updateMany(
      { conversation: conversation._id, readBy: { $ne: req.user._id } },
      { $addToSet: { readBy: req.user._id } }
    );

    res.status(200).json({ success: true, message: "Conversation marked as read" });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getOrCreateConversation,
  getConversations,
  getMessages,
  sendMessage,
  markConversationRead,
};
