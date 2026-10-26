const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const User = require("../models/User.model");
const Conversation = require("../models/Conversation.model");
const Message = require("../models/Message.model");

// Map of userId -> Set of socket ids (supports multiple tabs/devices per user)
const onlineUsers = new Map();

const initSocket = (io) => {
  // Authenticate each socket connection using the same JWT cookie as the REST API,
  // with fallback to auth handshake token or Bearer authorization header.
  io.use(async (socket, next) => {
    try {
      let token = null;

      // 1. Try cookie
      const rawCookie = socket.handshake.headers?.cookie;
      if (rawCookie) {
        const parsed = cookie.parse(rawCookie);
        const cookieName = process.env.JWT_COOKIE_NAME || "token";
        token = parsed[cookieName];
      }

      // 2. Fallback to handshake auth payload (e.g. mobile/custom clients or testing)
      if (!token && socket.handshake.auth?.token) {
        token = socket.handshake.auth.token;
      }

      // 3. Fallback to Authorization header
      if (!token && socket.handshake.headers?.authorization?.startsWith("Bearer ")) {
        token = socket.handshake.headers.authorization.split(" ")[1];
      }

      if (!token) {
        return next(new Error("Authentication required"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select("-password");
      if (!user) {
        return next(new Error("User no longer exists"));
      }

      socket.userId = user._id.toString();
      socket.user = user;
      next();
    } catch (err) {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    const { userId } = socket;

    // Track online user sockets
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);

    // Personal room so any controller can do io.to(`user:${id}`).emit(...)
    socket.join(`user:${userId}`);

    // Broadcast user online status
    io.emit("user:online", { userId });

    // Join a conversation room (only if user is a verified participant)
    socket.on("conversation:join", async ({ conversationId } = {}) => {
      if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) return;
      try {
        const conversation = await Conversation.findOne({
          _id: conversationId,
          participants: userId,
        });
        if (conversation) {
          socket.join(`conv:${conversationId}`);
        }
      } catch (_) {}
    });

    // Leave a conversation room
    socket.on("conversation:leave", ({ conversationId } = {}) => {
      if (conversationId) {
        socket.leave(`conv:${conversationId}`);
      }
    });

    // Real-time message sending via socket
    socket.on("message:send", async (data, callback) => {
      const ack = typeof callback === "function" ? callback : () => {};

      try {
        if (!data || typeof data !== "object") {
          return ack({ success: false, message: "Invalid payload" });
        }

        const { conversationId, content } = data;

        // 1. Validate conversationId
        if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
          return ack({ success: false, message: "Invalid conversation id" });
        }

        // 2. Validate content
        if (typeof content !== "string" || content.trim().length === 0) {
          return ack({ success: false, message: "Message cannot be empty" });
        }

        const trimmedContent = content.trim();
        if (trimmedContent.length > 2000) {
          return ack({ success: false, message: "Message is too long" });
        }

        // 3. Find conversation and verify membership
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          return ack({ success: false, message: "Conversation not found" });
        }

        const isParticipant = conversation.participants.some(
          (id) => id.toString() === userId
        );
        if (!isParticipant) {
          return ack({
            success: false,
            message: "Not part of this conversation",
          });
        }

        // 4. Persist message in MongoDB
        const message = await Message.create({
          conversation: conversation._id,
          sender: userId,
          content: trimmedContent,
          readBy: [userId],
        });

        // 5. Update conversation metadata
        conversation.lastMessage = message._id;
        conversation.lastMessageAt = message.createdAt;
        await conversation.save();

        // 6. Populate sender info
        await message.populate("sender", "username fullName avatar");

        // 7. Deliver message in real time
        const payload = {
          conversationId: conversation._id,
          message,
        };

        // Emit to all OTHER participants in the conversation
        conversation.participants
          .filter((id) => id.toString() !== userId)
          .forEach((recipientId) => {
            io.to(`user:${recipientId}`).emit("message:new", payload);
          });

        // Emit to sender's OTHER connected sockets (excluding current socket)
        socket.to(`user:${userId}`).emit("message:new", payload);

        // 8. Return acknowledgement to sender
        return ack({
          success: true,
          message,
        });
      } catch (err) {
        return ack({
          success: false,
          message: "Failed to send message",
        });
      }
    });

    // Typing indicator relay for DMs: client emits with recipientId,
    // we relay it straight to that user's personal room.
    socket.on("message:typing", ({ conversationId, recipientId }) => {
      if (!recipientId) return;
      io.to(`user:${recipientId}`).emit("message:typing", {
        conversationId,
        userId,
      });
    });

    // Handle socket-level connection errors
    socket.on("error", (err) => {
      // Prevent uncaught socket errors from bubbling
    });

    // Handle disconnect
    socket.on("disconnect", () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          io.emit("user:offline", { userId });
        }
      }
    });
  });
};

module.exports = { initSocket, onlineUsers };
