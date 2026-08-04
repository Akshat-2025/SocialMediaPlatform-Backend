const Notification = require("../models/Notification.model");

const SENDER_SELECT = "username fullName avatar";

/**
 * Creates a notification (skipping self-notifications) and emits it in real time
 * to the recipient's personal socket room, if they're connected.
 *
 * @param {import('express').Request} req - used to reach the Socket.io instance via req.app
 * @param {object} params
 * @param {string} params.recipientId
 * @param {string} params.senderId
 * @param {"like"|"comment"|"follow"} params.type
 * @param {string} [params.postId]
 * @param {string} [params.commentId]
 */
const notify = async (req, { recipientId, senderId, type, postId, commentId }) => {
  if (recipientId.toString() === senderId.toString()) return; // no self-notifications

  const notification = await Notification.create({
    recipient: recipientId,
    sender: senderId,
    type,
    post: postId,
    comment: commentId,
  });

  await notification.populate("sender", SENDER_SELECT);

  const io = req.app.get("io");
  if (io) {
    io.to(`user:${recipientId}`).emit("notification:new", notification);
  }

  return notification;
};

module.exports = { notify };
