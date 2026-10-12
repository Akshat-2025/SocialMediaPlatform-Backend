const mongoose = require("mongoose");

const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours

const storySchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    mediaUrl: {
      type: String,
      required: true,
    },
    publicId: {
      type: String,
      required: true,
    },
    mediaType: {
      type: String,
      enum: ["image", "video"],
      required: true,
    },
    // Only set for videos — a Cloudinary-derived still frame, not a second upload
    thumbnailUrl: {
      type: String,
      default: "",
    },
    // Seconds; only set for videos. Comes from Cloudinary's own probe of the
    // uploaded file (upload result), never trusted from the client.
    duration: {
      type: Number,
      default: null,
    },
    caption: {
      type: String,
      trim: true,
      maxlength: 200,
      default: "",
    },
    // Denormalized counter, kept in sync via atomic $inc from StoryView creation —
    // mirrors the commentsCount pattern already used on Post.
    viewsCount: {
      type: Number,
      default: 0,
    },
    // Set server-side on creation (createdAt + 24h). Never accepted from the client.
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

// Feed/user-story queries always filter `expiresAt > now` explicitly (see
// story.controller.js) — this index just makes that filter fast. We never rely
// on the TTL index below for "is this story still active" logic, only for
// eventual physical cleanup of the document.
storySchema.index({ author: 1, expiresAt: -1 });
storySchema.index({ author: 1, createdAt: -1 });

// TTL index: MongoDB's background task removes documents once `expiresAt` is in
// the past (expireAfterSeconds: 0 means "expire exactly at the stored date").
// This runs on its own ~60s sweep and is a backstop, not the primary expiration
// mechanism — see src/scripts/cleanupExpiredStories.js for why Cloudinary
// cleanup can't wait on it.
storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

storySchema.statics.LIFETIME_MS = STORY_LIFETIME_MS;

module.exports = mongoose.model("Story", storySchema);
