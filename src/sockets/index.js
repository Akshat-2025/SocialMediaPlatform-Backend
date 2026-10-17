const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const User = require("../models/User.model");
const Conversation = require("../models/Conversation.model");

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
    socket.on("conversation:join", async ({ conversationId }) => {
      if (!conversationId) return;
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
    socket.on("conversation:leave", ({ conversationId }) => {
      if (conversationId) {
        socket.leave(`conv:${conversationId}`);
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
