const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const User = require("../models/User.model");
const Conversation = require("../models/Conversation.model");
const Message = require("../models/Message.model");

// ---------------------------------------------------------------------------
// In-memory presence registry
// ---------------------------------------------------------------------------
// Map<userId (string) → Set<socketId (string)>>
// Tracks every active socket for a user so we handle multiple tabs correctly:
//   - User goes online  → first socket added  → size goes from 0 to 1
//   - User stays online → subsequent sockets add to the Set
//   - User goes offline → last socket removed → size drops to 0
//
// Limitation (documented): this is process-local. In a horizontally-scaled
// deployment with multiple Node.js instances you would need a shared store
// (e.g. Redis with Socket.IO adapter). For a single-instance deployment this
// is correct and reliable.
const onlineUsers = new Map();

// ---------------------------------------------------------------------------
// In-memory typing registry
// ---------------------------------------------------------------------------
// Map<conversationId (string) → Map<userId (string) → timeoutId>>
// Stores the auto-cancel timeout for every (conversation, user) pair that is
// currently typing. This lets us:
//   1. Clear stale state when the client disconnects without sending typing:stop.
//   2. Reset the timer on rapid start events (debounce).
//   3. Guarantee we never keep a permanent record in MongoDB.
const typingTimers = new Map();

// How long (ms) before a typing indicator is auto-cleared if no new start
// event arrives. Exposed so tests can override it.
const TYPING_TIMEOUT_MS = parseInt(process.env.TYPING_TIMEOUT_MS, 10) || 8000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the Set of conversation IDs that userId participates in.
 * Used to notify only relevant users about presence changes.
 * Kept lightweight — queries only the participants array, not messages.
 *
 * @param {string} userId
 * @returns {Promise<string[]>}  array of partner userIds (excluding self)
 */
const getConversationPartners = async (userId) => {
  try {
    const conversations = await Conversation.find(
      { participants: userId },
      { participants: 1, _id: 0 }
    );

    const partnerSet = new Set();
    for (const conv of conversations) {
      for (const p of conv.participants) {
        const pid = p.toString();
        if (pid !== userId) partnerSet.add(pid);
      }
    }
    return [...partnerSet];
  } catch {
    return [];
  }
};

/**
 * Emit a presence:update event to every conversation partner of userId
 * who is currently online (i.e. has at least one connected socket).
 * We never broadcast to the whole server — only to people who share a
 * conversation with this user.
 *
 * @param {object} io           - Socket.IO server
 * @param {string} userId       - the user whose presence changed
 * @param {"online"|"offline"} status
 * @param {Date|null} lastSeen  - only relevant when status === "offline"
 */
const notifyPresence = async (io, userId, status, lastSeen = null) => {
  const partners = await getConversationPartners(userId);
  const payload = {
    userId,
    status,
    lastSeen: status === "offline" ? lastSeen : null,
  };
  for (const partnerId of partners) {
    // Only emit if the partner is actually online (has sockets in registry)
    if (onlineUsers.has(partnerId)) {
      io.to(`user:${partnerId}`).emit("presence:update", payload);
    }
  }
};

/**
 * Cancel and remove the typing timer for (conversationId, userId).
 * Optionally emits typing:stop to the other participants.
 *
 * @param {object} io
 * @param {string} conversationId
 * @param {string} userId
 * @param {object[]} participants - array of participant IDs from the conversation doc
 * @param {boolean} broadcast     - whether to emit typing:stop
 */
const clearTypingTimer = (io, conversationId, userId, participants = [], broadcast = true) => {
  const convTimers = typingTimers.get(conversationId);
  if (!convTimers) return;

  const timerId = convTimers.get(userId);
  if (timerId) {
    clearTimeout(timerId);
    convTimers.delete(userId);
    if (convTimers.size === 0) typingTimers.delete(conversationId);
  }

  if (broadcast && participants.length > 0) {
    const stopPayload = { conversationId, userId };
    participants
      .filter((id) => id.toString() !== userId)
      .forEach((recipientId) => {
        io.to(`user:${recipientId}`).emit("typing:stop", stopPayload);
      });
  }
};

/**
 * Cancel all active typing timers for a given socket/user across ALL
 * conversations. Called on disconnect so stale indicators don't linger.
 *
 * @param {object} io
 * @param {string} userId
 */
const clearAllTypingForUser = async (io, userId) => {
  // We need participant lists to emit typing:stop to the right rooms.
  // Only fetch conversations where this user has an active timer.
  const activeConvIds = [];
  for (const [convId, convTimers] of typingTimers) {
    if (convTimers.has(userId)) activeConvIds.push(convId);
  }

  if (activeConvIds.length === 0) return;

  const conversations = await Conversation.find(
    { _id: { $in: activeConvIds }, participants: userId },
    { participants: 1 }
  );

  for (const conv of conversations) {
    clearTypingTimer(io, conv._id.toString(), userId, conv.participants, true);
  }
};

// ---------------------------------------------------------------------------
// Socket.IO initialization
// ---------------------------------------------------------------------------
const initSocket = (io) => {
  // ── Authentication middleware ────────────────────────────────────────────
  // Identical three-step fallback from Phase 1:
  //   1. HTTP-only JWT cookie  (primary, used by browsers)
  //   2. socket.handshake.auth.token  (mobile / testing fallback)
  //   3. Authorization: Bearer <token>  (API clients)
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

      // 2. Fallback to handshake auth payload
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

      // Attach verified identity — never trust client-supplied userId in events
      socket.userId = user._id.toString();
      socket.user = user;
      next();
    } catch (err) {
      next(new Error("Invalid or expired token"));
    }
  });

  // ── Connection handler ───────────────────────────────────────────────────
  io.on("connection", (socket) => {
    const { userId } = socket;

    // ── Presence: register this socket ──────────────────────────────────
    const isFirstConnection = !onlineUsers.has(userId);
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);

    // Join the personal room so controllers can do:
    //   io.to(`user:${id}`).emit(...)
    socket.join(`user:${userId}`);

    // ── IMPORTANT: register ALL socket.on() handlers synchronously first ─
    // The async presence notification happens below, but Socket.IO (and test
    // mocks) call this connection handler without awaiting it. Registering
    // handlers here ensures they're always available regardless of when the
    // async work resolves.

    // ── Conversation room management (Phase 2 / 3, unchanged) ───────────

    // Join a conversation room — verifies DB membership before joining
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

    // ── Real-time message sending (Phase 2, unchanged) ───────────────────
    socket.on("message:send", async (data, callback) => {
      const ack = typeof callback === "function" ? callback : () => {};

      try {
        if (!data || typeof data !== "object") {
          return ack({ success: false, message: "Invalid payload" });
        }

        const { conversationId, content, replyTo } = data;

        if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
          return ack({ success: false, message: "Invalid conversation id" });
        }

        if (typeof content !== "string" || content.trim().length === 0) {
          return ack({ success: false, message: "Message cannot be empty" });
        }

        const trimmedContent = content.trim();
        if (trimmedContent.length > 2000) {
          return ack({ success: false, message: "Message is too long" });
        }

        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          return ack({ success: false, message: "Conversation not found" });
        }

        const isParticipant = conversation.participants.some(
          (id) => id.toString() === userId
        );
        if (!isParticipant) {
          return ack({ success: false, message: "Not part of this conversation" });
        }

        let replyToMessageId = null;
        if (replyTo) {
          if (!mongoose.Types.ObjectId.isValid(replyTo)) {
            return ack({ success: false, message: "Invalid reply reference" });
          }

          const repliedMessage = await Message.findById(replyTo);
          if (!repliedMessage) {
            return ack({ success: false, message: "Replied-to message not found" });
          }

          if (repliedMessage.conversation.toString() !== conversationId) {
            return ack({
              success: false,
              message: "Cannot reply to a message from a different conversation",
            });
          }

          replyToMessageId = repliedMessage._id;
        }

        const messageData = {
          conversation: conversation._id,
          sender: userId,
          content: trimmedContent,
          // Sender is considered to have both sent and received their own message
          readBy: [userId],
          deliveredTo: [userId],
        };
        if (replyToMessageId) {
          messageData.replyTo = replyToMessageId;
        }

        const message = await Message.create(messageData);

        conversation.lastMessage = message._id;
        conversation.lastMessageAt = message.createdAt;
        await conversation.save();

        await message.populate("sender", "username fullName avatar");
        if (replyToMessageId) {
          await message.populate({
            path: "replyTo",
            select: "content sender createdAt",
            populate: { path: "sender", select: "username fullName avatar" },
          });
        }

        const payload = { conversationId: conversation._id, message };
        const inboxUpdatePayload = {
          conversationId: conversation._id,
          lastMessageAt: conversation.lastMessageAt,
        };

        conversation.participants
          .filter((id) => id.toString() !== userId)
          .forEach((recipientId) => {
            io.to(`user:${recipientId}`).emit("message:new", payload);
            io.to(`user:${recipientId}`).emit("inbox:update", inboxUpdatePayload);
          });

        socket.to(`user:${userId}`).emit("message:new", payload);
        socket.to(`user:${userId}`).emit("inbox:update", inboxUpdatePayload);

        return ack({ success: true, message });
      } catch (err) {
        return ack({ success: false, message: "Failed to send message" });
      }
    });

    // ── Phase 5: Delivery acknowledgement ────────────────────────────────
    //
    // Flow:
    //   1. Recipient receives `message:new` → client emits `message:delivered`
    //   2. Server verifies: messageId is valid, message exists, caller is
    //      a participant but NOT the sender (senders can't ack their own messages)
    //   3. $addToSet deliveredTo (idempotent — duplicate acks are no-ops)
    //   4. Emit `message:status` to the sender's personal room
    //
    // Payload in:  { messageId: string }
    // Payload out (to sender): { conversationId, messageIds: [string], status: "delivered", byUserId }

    socket.on("message:delivered", async (data, callback) => {
      const ack = typeof callback === "function" ? callback : () => {};

      if (!data || typeof data !== "object") {
        return ack({ success: false, message: "Invalid payload" });
      }

      const { messageId } = data;

      if (!messageId || !mongoose.Types.ObjectId.isValid(messageId)) {
        return ack({ success: false, message: "Invalid message id" });
      }

      try {
        const message = await Message.findById(messageId).select(
          "conversation sender deliveredTo"
        );

        if (!message) {
          return ack({ success: false, message: "Message not found" });
        }

        // Verify the ack-sender is a participant of the conversation
        const conversation = await Conversation.findOne({
          _id: message.conversation,
          participants: userId,
        });

        if (!conversation) {
          return ack({ success: false, message: "Not part of this conversation" });
        }

        const senderId = message.sender.toString();

        // The message sender cannot ack their own message as delivered
        if (senderId === userId) {
          return ack({ success: false, message: "Cannot acknowledge your own message" });
        }

        // Idempotency check — skip the DB write if already delivered
        const alreadyDelivered = message.deliveredTo.some(
          (id) => id.toString() === userId
        );

        if (!alreadyDelivered) {
          await Message.updateOne(
            { _id: message._id },
            { $addToSet: { deliveredTo: userId } }
          );
        }

        // Always notify the sender (even for duplicate acks, the UI may need it)
        io.to(`user:${senderId}`).emit("message:status", {
          conversationId: message.conversation.toString(),
          messageIds: [messageId],
          status: "delivered",
          byUserId: userId,
        });

        return ack({ success: true });
      } catch (err) {
        return ack({ success: false, message: "Failed to acknowledge delivery" });
      }
    });

    // ── Phase 6: Message Reactions ───────────────────────────────────────
    //
    // Events:
    //   `message:react`: { conversationId, messageId, emoji }
    //     - Adds or changes user's own reaction if non-empty emoji string provided.
    //     - Removes reaction if emoji is null or empty.
    //   `message:reaction:remove`: { conversationId, messageId }
    //     - Explicitly removes user's own reaction.
    //
    // Real-time broadcast:
    //   `message:reaction`: { conversationId, messageId, reactions, userId, emoji, action }

    socket.on("message:react", async (data, callback) => {
      const ack = typeof callback === "function" ? callback : () => {};

      if (!data || typeof data !== "object") {
        return ack({ success: false, message: "Invalid payload" });
      }

      const { conversationId, messageId, emoji } = data;

      if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
        return ack({ success: false, message: "Invalid conversation id" });
      }

      if (!messageId || !mongoose.Types.ObjectId.isValid(messageId)) {
        return ack({ success: false, message: "Invalid message id" });
      }

      try {
        const conversation = await Conversation.findOne({
          _id: conversationId,
          participants: userId,
        });

        if (!conversation) {
          return ack({ success: false, message: "Not part of this conversation" });
        }

        const message = await Message.findOne({
          _id: messageId,
          conversation: conversation._id,
        });

        if (!message) {
          return ack({ success: false, message: "Message not found" });
        }

        const hasEmoji = typeof emoji === "string" && emoji.trim().length > 0;
        const trimmedEmoji = hasEmoji ? emoji.trim() : null;

        if (hasEmoji && trimmedEmoji.length > 16) {
          return ack({ success: false, message: "Emoji is too long" });
        }

        const existingIndex = message.reactions.findIndex(
          (r) => r.user.toString() === userId
        );

        let action = "add";

        if (hasEmoji) {
          if (existingIndex !== -1) {
            message.reactions[existingIndex].emoji = trimmedEmoji;
            message.reactions[existingIndex].createdAt = new Date();
            action = "update";
          } else {
            message.reactions.push({
              user: userId,
              emoji: trimmedEmoji,
              createdAt: new Date(),
            });
          }
        } else {
          // Remove reaction if no emoji was provided
          if (existingIndex === -1) {
            return ack({ success: false, message: "Reaction not found" });
          }
          message.reactions.splice(existingIndex, 1);
          action = "remove";
        }

        await message.save();
        await message.populate("reactions.user", "username fullName avatar");

        const reactionPayload = {
          conversationId: conversation._id.toString(),
          messageId: message._id.toString(),
          reactions: message.reactions,
          userId,
          emoji: hasEmoji ? trimmedEmoji : null,
          action,
        };

        conversation.participants.forEach((pId) => {
          io.to(`user:${pId}`).emit("message:reaction", reactionPayload);
        });

        return ack({
          success: true,
          reactions: message.reactions,
          action,
        });
      } catch (err) {
        return ack({ success: false, message: "Failed to react to message" });
      }
    });

    socket.on("message:reaction:remove", async (data, callback) => {
      const ack = typeof callback === "function" ? callback : () => {};

      if (!data || typeof data !== "object") {
        return ack({ success: false, message: "Invalid payload" });
      }

      const { conversationId, messageId } = data;

      if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
        return ack({ success: false, message: "Invalid conversation id" });
      }

      if (!messageId || !mongoose.Types.ObjectId.isValid(messageId)) {
        return ack({ success: false, message: "Invalid message id" });
      }

      try {
        const conversation = await Conversation.findOne({
          _id: conversationId,
          participants: userId,
        });

        if (!conversation) {
          return ack({ success: false, message: "Not part of this conversation" });
        }

        const message = await Message.findOne({
          _id: messageId,
          conversation: conversation._id,
        });

        if (!message) {
          return ack({ success: false, message: "Message not found" });
        }

        const existingIndex = message.reactions.findIndex(
          (r) => r.user.toString() === userId
        );

        if (existingIndex === -1) {
          return ack({ success: false, message: "Reaction not found" });
        }

        message.reactions.splice(existingIndex, 1);
        await message.save();
        await message.populate("reactions.user", "username fullName avatar");

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

        return ack({
          success: true,
          reactions: message.reactions,
          action: "remove",
        });
      } catch (err) {
        return ack({ success: false, message: "Failed to remove reaction" });
      }
    });

    // ── Typing indicators (Phase 4) ──────────────────────────────────────
    //
    // Design notes:
    //   - Identity is always taken from socket.userId (server-verified JWT),
    //     never from the client payload.
    //   - We verify conversation membership before broadcasting anything.
    //   - A server-side timer clears stale state after TYPING_TIMEOUT_MS.
    //   - Repeated typing:start events reset the timer (debounce) without
    //     creating duplicate broadcasts or unbounded timers.
    //   - On disconnect, all active typing timers are cancelled and
    //     typing:stop is sent to affected conversations.

    /**
     * typing:start  {conversationId: string}
     *
     * Client sends this when the user starts (or continues) typing.
     * Server verifies membership, then emits to all OTHER participants:
     *   typing:start  {conversationId, userId}
     */
    socket.on("typing:start", async (data) => {
      if (!data || typeof data !== "object") return;
      const { conversationId } = data;

      if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) return;

      try {
        const conversation = await Conversation.findOne({
          _id: conversationId,
          participants: userId,
        });
        if (!conversation) return; // not a participant — silently drop

        const convIdStr = conversation._id.toString();
        const startPayload = { conversationId: convIdStr, userId };

        // Emit typing:start to other participants
        conversation.participants
          .filter((id) => id.toString() !== userId)
          .forEach((recipientId) => {
            io.to(`user:${recipientId}`).emit("typing:start", startPayload);
          });

        // Reset the auto-clear timeout (debounce: rapid starts don't pile up)
        if (!typingTimers.has(convIdStr)) typingTimers.set(convIdStr, new Map());
        const convTimers = typingTimers.get(convIdStr);

        const existing = convTimers.get(userId);
        if (existing) clearTimeout(existing);

        const timerId = setTimeout(() => {
          clearTypingTimer(io, convIdStr, userId, conversation.participants, true);
        }, TYPING_TIMEOUT_MS);

        convTimers.set(userId, timerId);
      } catch (_) {}
    });

    /**
     * typing:stop  {conversationId: string}
     *
     * Client sends this when the user stops typing (sent message, blurred
     * input, or explicitly stopped). Server verifies membership, cancels
     * the timeout, then emits to all OTHER participants:
     *   typing:stop  {conversationId, userId}
     */
    socket.on("typing:stop", async (data) => {
      if (!data || typeof data !== "object") return;
      const { conversationId } = data;

      if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) return;

      try {
        const conversation = await Conversation.findOne({
          _id: conversationId,
          participants: userId,
        });
        if (!conversation) return;

        clearTypingTimer(
          io,
          conversation._id.toString(),
          userId,
          conversation.participants,
          true
        );
      } catch (_) {}
    });

    // ── Error handling (unchanged) ───────────────────────────────────────
    socket.on("error", (_err) => {
      // Prevent uncaught socket errors from bubbling to the process
    });

    // ── Disconnect handler ───────────────────────────────────────────────
    socket.on("disconnect", async () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);

        if (sockets.size === 0) {
          // This was the user's final connection — genuine offline transition
          onlineUsers.delete(userId);

          // Persist lastSeen. Fire-and-forget — don't block anything on this.
          // We use updateOne rather than findById+save to avoid a round-trip.
          const lastSeen = new Date();
          User.updateOne({ _id: userId }, { lastSeen }).catch(() => {});

          // Clear any stale typing state before notifying presence
          await clearAllTypingForUser(io, userId);

          // Notify conversation partners
          await notifyPresence(io, userId, "offline", lastSeen);
        }
        // If the user still has other sockets open, do nothing — they remain online
      }
    });

    // ── Async work: notify partners of online presence ───────────────────
    // Done AFTER registering all handlers so sockets are always ready
    // even if this async notification is still in-flight.
    if (isFirstConnection) {
      notifyPresence(io, userId, "online").catch(() => {});
    }
  });
};

module.exports = { initSocket, onlineUsers, typingTimers, TYPING_TIMEOUT_MS };
