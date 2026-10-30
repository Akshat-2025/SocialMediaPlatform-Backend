const mongoose = require("mongoose");
const Conversation = require("../models/Conversation.model");
const Message = require("../models/Message.model");
const User = require("../models/User.model");

const PARTICIPANT_SELECT = "username fullName avatar";
// Fields exposed in lastMessage preview — includes deliveredTo so clients can
// derive message status without fetching the full message list.
const LAST_MSG_SELECT = "content sender createdAt readBy deliveredTo";
// Regex-escapes user input so it can't mutate our MongoDB regex
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

    // Verify the target user actually exists before creating a conversation
    const otherUser = await User.findById(otherUserId).select("_id");
    if (!otherUser) {
      return res.status(404).json({ success: false, message: "User not found" });
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
// Returns inbox with participants, lastMessage preview, and per-conversation unread count.
const getConversations = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;
    const userId = req.user._id;

    const [conversations, total] = await Promise.all([
      Conversation.find({ participants: userId })
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("participants", PARTICIPANT_SELECT)
        .populate("lastMessage", LAST_MSG_SELECT),
      Conversation.countDocuments({ participants: userId }),
    ]);

    // Compute unread counts for returned conversations in one aggregation
    const convIds = conversations.map((c) => c._id);
    const unreadAgg = await Message.aggregate([
      {
        $match: {
          conversation: { $in: convIds },
          sender: { $ne: userId },       // exclude messages the user sent
          readBy: { $ne: userId },        // only messages not yet read by user
        },
      },
      { $group: { _id: "$conversation", count: { $sum: 1 } } },
    ]);

    // Build a map for O(1) lookup
    const unreadMap = {};
    for (const row of unreadAgg) {
      unreadMap[row._id.toString()] = row.count;
    }

    const enriched = conversations.map((conv) => {
      const obj = conv.toObject();
      obj.unreadCount = unreadMap[obj._id.toString()] || 0;
      return obj;
    });

    res.status(200).json({
      success: true,
      conversations: enriched,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// Shared guard: confirms req.user is a participant, 404s/403s otherwise
const loadOwnedConversation = async (req, res) => {
  const { conversationId } = req.params;

  if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
    res.status(400).json({ success: false, message: "Invalid conversation id" });
    return null;
  }

  const conversation = await Conversation.findById(conversationId);

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

// @route  GET /api/messages/conversations/:conversationId
// Returns full details of a single conversation (membership required).
const getConversation = async (req, res, next) => {
  try {
    const conversation = await loadOwnedConversation(req, res);
    if (!conversation) return;

    // Populate participants and lastMessage preview
    await conversation.populate("participants", PARTICIPANT_SELECT);
    await conversation.populate("lastMessage", LAST_MSG_SELECT);

    // Unread count for this specific conversation
    const unreadCount = await Message.countDocuments({
      conversation: conversation._id,
      sender: { $ne: req.user._id },
      readBy: { $ne: req.user._id },
    });

    const obj = conversation.toObject();
    obj.unreadCount = unreadCount;

    res.status(200).json({ success: true, conversation: obj });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/messages/conversations/:conversationId/messages?page=&limit=
const getMessages = async (req, res, next) => {
  try {
    const conversation = await loadOwnedConversation(req, res);
    if (!conversation) return;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 30, 50));
    const skip = (page - 1) * limit;

    const [messages, total] = await Promise.all([
      Message.find({ conversation: conversation._id })
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .populate("sender", PARTICIPANT_SELECT)
        .populate({
          path: "replyTo",
          select: "content sender createdAt",
          populate: { path: "sender", select: PARTICIPANT_SELECT },
        })
        .populate("reactions.user", PARTICIPANT_SELECT),
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

    const senderId = req.user._id;
    const { content, replyTo } = req.body;
    let replyToMessageId = null;

    if (replyTo) {
      if (!mongoose.Types.ObjectId.isValid(replyTo)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid reply reference" });
      }

      const repliedMessage = await Message.findById(replyTo);
      if (!repliedMessage) {
        return res
          .status(404)
          .json({ success: false, message: "Replied-to message not found" });
      }

      if (repliedMessage.conversation.toString() !== conversation._id.toString()) {
        return res.status(400).json({
          success: false,
          message: "Cannot reply to a message from a different conversation",
        });
      }

      replyToMessageId = repliedMessage._id;
    }

    const messageData = {
      conversation: conversation._id,
      sender: senderId,
      content: content.trim(),
      // Sender has both sent and received their own message
      readBy: [senderId],
      deliveredTo: [senderId],
    };
    if (replyToMessageId) {
      messageData.replyTo = replyToMessageId;
    }

    const message = await Message.create(messageData);

    conversation.lastMessage = message._id;
    conversation.lastMessageAt = message.createdAt;
    await conversation.save();

    await message.populate("sender", PARTICIPANT_SELECT);
    if (replyToMessageId) {
      await message.populate({
        path: "replyTo",
        select: "content sender createdAt",
        populate: { path: "sender", select: PARTICIPANT_SELECT },
      });
    }

    // Push to the other participant(s) in real time
    const io = req.app.get("io");
    if (io) {
      const payload = {
        conversationId: conversation._id,
        message,
      };
      const inboxUpdatePayload = {
        conversationId: conversation._id,
        lastMessageAt: conversation.lastMessageAt,
      };

      conversation.participants
        .filter((id) => id.toString() !== senderId.toString())
        .forEach((id) => {
          io.to(`user:${id}`).emit("message:new", payload);
          io.to(`user:${id}`).emit("inbox:update", inboxUpdatePayload);
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

    const readerId = req.user._id;

    // Find messages not yet read by this user (exclude their own messages)
    const unreadMessages = await Message.find({
      conversation: conversation._id,
      sender: { $ne: readerId },
      readBy: { $ne: readerId },
    }).select("_id sender");

    if (unreadMessages.length === 0) {
      return res.status(200).json({ success: true, message: "Conversation marked as read" });
    }

    const unreadIds = unreadMessages.map((m) => m._id);

    // Mark as both delivered and read in one atomic operation
    await Message.updateMany(
      { _id: { $in: unreadIds } },
      { $addToSet: { readBy: readerId, deliveredTo: readerId } }
    );

    // Notify senders in real time via Socket.IO
    const io = req.app.get("io");
    if (io) {
      // Group by sender so we emit once per sender
      const bySender = {};
      for (const msg of unreadMessages) {
        const senderId = msg.sender.toString();
        if (!bySender[senderId]) bySender[senderId] = [];
        bySender[senderId].push(msg._id.toString());
      }

      for (const [senderId, messageIds] of Object.entries(bySender)) {
        io.to(`user:${senderId}`).emit("message:status", {
          conversationId: conversation._id.toString(),
          messageIds,
          status: "read",
          byUserId: readerId.toString(),
        });
      }
    }

    res.status(200).json({ success: true, message: "Conversation marked as read" });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/messages/conversations/search?q=&page=&limit=
// Searches the authenticated user's existing conversations by the other
// participant's username or fullName.  Also useful for finding users to
// start a new DM with (surface any matching users from the User collection).
const searchConversations = async (req, res, next) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) {
      return res.status(400).json({ success: false, message: "Query param 'q' is required" });
    }
    if (q.length > 100) {
      return res.status(400).json({ success: false, message: "Query is too long" });
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;
    const userId = req.user._id;

    const pattern = new RegExp(escapeRegex(q), "i");

    // --- 1. Find users whose conversations the current user already has ---
    //   We want conversations where at least one OTHER participant matches the query.
    //   Strategy: find matching user IDs first (cheap), then filter conversations.
    const matchingUsers = await User.find({
      _id: { $ne: userId },
      $or: [{ username: pattern }, { fullName: pattern }],
    })
      .select("_id")
      .limit(200); // safety cap

    const matchingUserIds = matchingUsers.map((u) => u._id);

    const filter = {
      participants: { $all: [userId], $in: matchingUserIds },
    };

    const [conversations, total] = await Promise.all([
      Conversation.find(filter)
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("participants", PARTICIPANT_SELECT)
        .populate("lastMessage", LAST_MSG_SELECT),
      Conversation.countDocuments(filter),
    ]);

    // --- 2. Also return matching users not yet in a conversation (to start new DMs) ---
    const existingPartnerIds = new Set();
    for (const conv of conversations) {
      for (const p of conv.participants) {
        const pid = p._id ? p._id.toString() : p.toString();
        if (pid !== userId.toString()) existingPartnerIds.add(pid);
      }
    }

    const newUsers = await User.find({
      _id: { $ne: userId, $nin: [...existingPartnerIds] },
      $or: [{ username: pattern }, { fullName: pattern }],
    })
      .select(PARTICIPANT_SELECT)
      .limit(10);

    // Compute unread counts for matched conversations
    const convIds = conversations.map((c) => c._id);
    const unreadAgg = await Message.aggregate([
      {
        $match: {
          conversation: { $in: convIds },
          sender: { $ne: userId },
          readBy: { $ne: userId },
        },
      },
      { $group: { _id: "$conversation", count: { $sum: 1 } } },
    ]);
    const unreadMap = {};
    for (const row of unreadAgg) unreadMap[row._id.toString()] = row.count;

    const enriched = conversations.map((conv) => {
      const obj = conv.toObject();
      obj.unreadCount = unreadMap[obj._id.toString()] || 0;
      return obj;
    });

    res.status(200).json({
      success: true,
      conversations: enriched,
      suggestedUsers: newUsers,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// @route  POST /api/messages/conversations/:conversationId/messages/:messageId/reactions
// @route  PUT  /api/messages/conversations/:conversationId/messages/:messageId/reactions
const addOrUpdateReaction = async (req, res, next) => {
  try {
    const conversation = await loadOwnedConversation(req, res);
    if (!conversation) return;

    const { messageId } = req.params;
    if (!messageId || !mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({ success: false, message: "Invalid message id" });
    }

    const { emoji } = req.body;
    if (!emoji || typeof emoji !== "string" || !emoji.trim()) {
      return res.status(400).json({ success: false, message: "Emoji is required" });
    }
    const trimmedEmoji = emoji.trim();
    if (trimmedEmoji.length > 16) {
      return res.status(400).json({ success: false, message: "Emoji is too long" });
    }

    const message = await Message.findOne({
      _id: messageId,
      conversation: conversation._id,
    });

    if (!message) {
      return res.status(404).json({ success: false, message: "Message not found" });
    }

    const userId = req.user._id.toString();
    const existingIndex = message.reactions.findIndex(
      (r) => r.user.toString() === userId
    );

    let action = "add";
    if (existingIndex !== -1) {
      message.reactions[existingIndex].emoji = trimmedEmoji;
      message.reactions[existingIndex].createdAt = new Date();
      action = "update";
    } else {
      message.reactions.push({
        user: req.user._id,
        emoji: trimmedEmoji,
        createdAt: new Date(),
      });
    }

    await message.save();
    await message.populate("reactions.user", PARTICIPANT_SELECT);

    const io = req.app.get("io");
    if (io) {
      const reactionPayload = {
        conversationId: conversation._id.toString(),
        messageId: message._id.toString(),
        reactions: message.reactions,
        userId,
        emoji: trimmedEmoji,
        action,
      };

      conversation.participants.forEach((pId) => {
        io.to(`user:${pId}`).emit("message:reaction", reactionPayload);
      });
    }

    res.status(200).json({
      success: true,
      reactions: message.reactions,
      action,
    });
  } catch (error) {
    next(error);
  }
};

// @route  DELETE /api/messages/conversations/:conversationId/messages/:messageId/reactions
const removeReaction = async (req, res, next) => {
  try {
    const conversation = await loadOwnedConversation(req, res);
    if (!conversation) return;

    const { messageId } = req.params;
    if (!messageId || !mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({ success: false, message: "Invalid message id" });
    }

    const message = await Message.findOne({
      _id: messageId,
      conversation: conversation._id,
    });

    if (!message) {
      return res.status(404).json({ success: false, message: "Message not found" });
    }

    const userId = req.user._id.toString();
    const existingIndex = message.reactions.findIndex(
      (r) => r.user.toString() === userId
    );

    if (existingIndex === -1) {
      return res.status(404).json({ success: false, message: "Reaction not found" });
    }

    message.reactions.splice(existingIndex, 1);
    await message.save();
    await message.populate("reactions.user", PARTICIPANT_SELECT);

    const io = req.app.get("io");
    if (io) {
      const reactionPayload = {
        conversationId: conversation._id.toString(),
        messageId: message._id.toString(),
        reactions: message.reactions,
        userId,
        emoji: null,
        action: "remove",
      };

      conversation.participants.forEach((pId) => {
        io.to(`user:${pId}`).emit("message:reaction", reactionPayload);
      });
    }

    res.status(200).json({
      success: true,
      reactions: message.reactions,
      action: "remove",
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getOrCreateConversation,
  getConversations,
  getConversation,
  getMessages,
  sendMessage,
  markConversationRead,
  searchConversations,
  addOrUpdateReaction,
  removeReaction,
};
