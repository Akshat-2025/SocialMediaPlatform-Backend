const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const User = require("../models/User.model");

// Map of userId -> Set of socket ids (supports multiple tabs/devices per user)
const onlineUsers = new Map();

const initSocket = (io) => {
  // Authenticate each socket connection using the same JWT cookie as the REST API
  io.use(async (socket, next) => {
    try {
      const rawCookie = socket.handshake.headers.cookie;
      if (!rawCookie) return next(new Error("Authentication required"));

      const parsed = cookie.parse(rawCookie);
      const cookieName = process.env.JWT_COOKIE_NAME || "token";
      const token = parsed[cookieName];
      if (!token) return next(new Error("Authentication required"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (!user) return next(new Error("User no longer exists"));

      socket.userId = user._id.toString();
      next();
    } catch (err) {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    const { userId } = socket;

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);

    // Personal room so any controller can do io.to(`user:${id}`).emit(...)
    socket.join(`user:${userId}`);
    
    io.emit("user:online", { userId });

    // Typing indicator relay for DMs: client emits with the other user's id,
    // we relay it straight to that user's personal room.
    socket.on("message:typing", ({ conversationId, recipientId }) => {
      if (!recipientId) return;
      io.to(`user:${recipientId}`).emit("message:typing", {
        conversationId,
        userId,
      });
    });
    
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
