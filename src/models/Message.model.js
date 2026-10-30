const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    // Phase 5: tracks which participants have received (downloaded) the message.
    // Status derivation (per-recipient, never stored as an enum to avoid races):
    //   sent      = in neither deliveredTo nor readBy for that recipient
    //   delivered = in deliveredTo but NOT yet in readBy
    //   read      = in readBy (readBy implies delivered)
    //
    // Both arrays use $addToSet for idempotent writes — duplicate acks are safe.
    deliveredTo: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    // Phase 6: Reply-to-Message reference
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    // Phase 6: Message Reactions
    reactions: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        emoji: {
          type: String,
          required: true,
          trim: true,
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: -1 });
// Efficiently find messages not yet delivered/read for a given conversation
messageSchema.index({ conversation: 1, deliveredTo: 1 });
messageSchema.index({ conversation: 1, readBy: 1 });
messageSchema.index({ replyTo: 1 });

module.exports = mongoose.model("Message", messageSchema);
