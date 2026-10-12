const mongoose = require("mongoose");

// A separate collection rather than an embedded `viewers` array on Story: an
// active story can pick up an unbounded number of views, and embedding would
// mean loading (and growing) that array on every read of the story document.
// This also gives us a real place to put the atomic dedup guard below.
const storyViewSchema = new mongoose.Schema(
  {
    story: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Story",
      required: true,
    },
    viewer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    viewedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false } // viewedAt already serves this purpose
);

// The dedup mechanism: a viewer can have at most one StoryView per story.
// Combined with findOneAndUpdate({...}, {...}, { upsert: true, new: false })
// in the controller, this makes "record a view" atomic and race-safe — two
// concurrent requests from the same viewer can't both succeed in creating a
// row, and MongoDB itself rejects the loser with a duplicate-key error.
storyViewSchema.index({ story: 1, viewer: 1 }, { unique: true });

// Powers the owner-only, paginated viewer list, sorted newest-first.
storyViewSchema.index({ story: 1, viewedAt: -1 });

module.exports = mongoose.model("StoryView", storyViewSchema);
