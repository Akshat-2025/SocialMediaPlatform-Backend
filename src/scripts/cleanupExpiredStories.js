/**
 * One-shot cleanup pass for expired stories. Run this from an EXTERNAL
 * scheduler (a Render Cron Job, a GitHub Actions schedule, system cron,
 * etc.) — deliberately not an in-process setInterval(), which would silently
 * stop running on every deploy/restart and give no visibility into failures.
 *
 * Why this exists even though Story has a TTL index:
 * MongoDB's TTL monitor deletes the *document* once expiresAt has passed, but
 * it does nothing about the Cloudinary asset the document was pointing at —
 * and once the document is gone, its publicId (needed to delete that asset)
 * is gone too. This script runs proactively, ahead of the TTL sweep, so it
 * still has the publicId when it deletes the Cloudinary media. The TTL index
 * remains in place as a backstop: if this job doesn't run for a while, the
 * database doesn't accumulate expired docs forever even though the
 * Cloudinary assets in that gap would be left orphaned (a storage-cost leak,
 * not a correctness/security issue — see README "Known limitations").
 *
 * Idempotent: safe to run as often as you like, and safe to re-run if a
 * previous run was interrupted partway — each story is only ever deleted
 * once, and failures on one story don't stop the others from being cleaned.
 *
 * Usage:
 *   node src/scripts/cleanupExpiredStories.js
 *   npm run cleanup:stories
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Story = require("../models/Story.model");
const StoryView = require("../models/StoryView.model");
const { destroyStoryMedia } = require("../utils/cloudinaryStory");

const run = async () => {
  await connectDB();

  const now = new Date();
  const expired = await Story.find({ expiresAt: { $lte: now } }).select(
    "publicId mediaType"
  );

  console.log(`[cleanupExpiredStories] found ${expired.length} expired stories`);

  let cleaned = 0;
  let failed = 0;

  for (const story of expired) {
    try {
      await destroyStoryMedia(story.publicId, story.mediaType);
    } catch (err) {
      // Keep going — an orphaned Cloudinary asset is recoverable (re-run
      // this script later); losing track of the next story to clean up isn't.
      failed += 1;
      console.error(
        `[cleanupExpiredStories] Cloudinary cleanup failed for ${story.publicId}:`,
        err.message
      );
    }

    await StoryView.deleteMany({ story: story._id });
    await Story.deleteOne({ _id: story._id });
    cleaned += 1;
  }

  console.log(
    `[cleanupExpiredStories] done: ${cleaned} stories removed, ${failed} Cloudinary deletions failed`
  );

  await mongoose.connection.close();
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((err) => {
  console.error("[cleanupExpiredStories] fatal error:", err);
  process.exit(1);
});
