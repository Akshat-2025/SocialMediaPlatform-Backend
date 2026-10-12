const Story = require("../models/Story.model");
const StoryView = require("../models/StoryView.model");
const User = require("../models/User.model");
const { detectMediaType } = require("../utils/detectMediaType");
const {
  uploadStoryMedia,
  getVideoThumbnailUrl,
  destroyStoryMedia,
} = require("../utils/cloudinaryStory");
const { STORY_MAX_IMAGE_MB, STORY_MAX_VIDEO_MB } = require("../middleware/uploadStory.middleware");

const AUTHOR_SELECT = "username fullName avatar";
const LIST_SELECT = "username fullName avatar";

// Shared shape for a single story in any list/feed response
const formatStory = (story, hasViewed) => ({
  id: story._id,
  mediaUrl: story.mediaUrl,
  mediaType: story.mediaType,
  thumbnailUrl: story.thumbnailUrl || undefined,
  duration: story.duration,
  caption: story.caption,
  viewsCount: story.viewsCount,
  hasViewed,
  createdAt: story.createdAt,
  expiresAt: story.expiresAt,
});

// @route  POST /api/stories
const createStory = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No media file provided" });
    }

    // Real content check — never trust the client-supplied mimetype alone.
    const detected = detectMediaType(req.file.buffer);
    if (!detected) {
      return res
        .status(400)
        .json({ success: false, message: "Unsupported or unrecognized media file" });
    }

    const claimedIsVideo = req.file.mimetype.startsWith("video/");
    if (claimedIsVideo !== (detected.mediaType === "video")) {
      return res
        .status(400)
        .json({ success: false, message: "File content does not match its declared type" });
    }

    const maxBytes =
      (detected.mediaType === "video" ? STORY_MAX_VIDEO_MB : STORY_MAX_IMAGE_MB) * 1024 * 1024;
    if (req.file.buffer.length > maxBytes) {
      const limitMb = detected.mediaType === "video" ? STORY_MAX_VIDEO_MB : STORY_MAX_IMAGE_MB;
      return res.status(400).json({
        success: false,
        message: `${detected.mediaType === "video" ? "Video" : "Image"} exceeds the ${limitMb}MB limit`,
      });
    }

    let uploadResult;
    try {
      uploadResult = await uploadStoryMedia(req.file.buffer, detected.mediaType);
    } catch (err) {
      return res
        .status(502)
        .json({ success: false, message: "Failed to upload media, please try again" });
    }

    // Duration cap, checked AFTER upload using Cloudinary's own probe of the
    // file (uploadResult.duration) — never from client input. If it's too
    // long, clean up the asset we just created rather than leaving it orphaned.
    if (detected.mediaType === "video") {
      const maxDurationSec = parseInt(process.env.STORY_MAX_VIDEO_DURATION_SEC) || 60;
      if (uploadResult.duration && uploadResult.duration > maxDurationSec) {
        await destroyStoryMedia(uploadResult.public_id, "video").catch(() => {});
        return res.status(400).json({
          success: false,
          message: `Video exceeds the maximum duration of ${maxDurationSec} seconds`,
        });
      }
    }

    const expiresAt = new Date(Date.now() + Story.LIFETIME_MS);

    let story;
    try {
      story = await Story.create({
        author: req.user._id,
        mediaUrl: uploadResult.secure_url,
        publicId: uploadResult.public_id,
        mediaType: detected.mediaType,
        thumbnailUrl:
          detected.mediaType === "video" ? getVideoThumbnailUrl(uploadResult.public_id) : "",
        duration: detected.mediaType === "video" ? uploadResult.duration || null : null,
        caption: req.body.caption,
        expiresAt,
      });
    } catch (err) {
      // DB write failed after a successful upload — don't leave the asset orphaned
      await destroyStoryMedia(uploadResult.public_id, detected.mediaType).catch(() => {});
      return next(err);
    }

    await story.populate("author", AUTHOR_SELECT);

    res.status(201).json({
      success: true,
      message: "Story created",
      story: {
        ...formatStory(story, true),
        author: story.author,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/stories/feed
// Groups active stories by creator for the horizontal story tray: the
// authenticated user's own stories (if any) plus stories from everyone they
// follow. A single flat query + in-memory grouping, not an aggregation
// pipeline — the per-user active-story count is small (24h window) so this
// stays cheap while avoiding $group pipeline overhead.
const getFeed = async (req, res, next) => {
  try {
    const now = new Date();
    const relevantAuthorIds = [req.user._id, ...req.user.following];

    const stories = await Story.find({
      author: { $in: relevantAuthorIds },
      expiresAt: { $gt: now },
    })
      .sort({ createdAt: -1 })
      .populate("author", AUTHOR_SELECT);

    if (stories.length === 0) {
      return res.status(200).json({ success: true, storyGroups: [] });
    }

    const storyIds = stories.map((s) => s._id);
    const viewedRows = await StoryView.find({
      viewer: req.user._id,
      story: { $in: storyIds },
    }).select("story");
    const viewedSet = new Set(viewedRows.map((v) => v.story.toString()));

    const meId = req.user._id.toString();
    const groupsByAuthor = new Map();

    for (const story of stories) {
      const authorId = story.author._id.toString();
      if (!groupsByAuthor.has(authorId)) {
        groupsByAuthor.set(authorId, {
          user: {
            id: story.author._id,
            username: story.author.username,
            fullName: story.author.fullName,
            avatar: story.author.avatar,
          },
          stories: [],
        });
      }
      const isOwn = authorId === meId;
      const hasViewed = isOwn || viewedSet.has(story._id.toString());
      groupsByAuthor.get(authorId).stories.push(formatStory(story, hasViewed));
    }

    const storyGroups = Array.from(groupsByAuthor.values()).map((group) => {
      // Oldest-first within a group, for tap-through/auto-advance order
      group.stories.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      return { ...group, hasUnseen: group.stories.some((s) => !s.hasViewed) };
    });

    // Own stories first, then groups with unseen stories, then most-recent first
    storyGroups.sort((a, b) => {
      if (a.user.id.toString() === meId) return -1;
      if (b.user.id.toString() === meId) return 1;
      if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
      const aLatest = a.stories[a.stories.length - 1].createdAt;
      const bLatest = b.stories[b.stories.length - 1].createdAt;
      return new Date(bLatest) - new Date(aLatest);
    });

    res.status(200).json({ success: true, storyGroups });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/stories/user/:userId
const getUserStories = async (req, res, next) => {
  try {
    const { userId } = req.params;

    const author = await User.findById(userId).select(LIST_SELECT);
    if (!author) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const now = new Date();
    const stories = await Story.find({ author: userId, expiresAt: { $gt: now } }).sort({
      createdAt: 1,
    });

    const isOwn = userId === req.user._id.toString();
    let viewedSet = new Set();
    if (!isOwn && stories.length > 0) {
      const viewedRows = await StoryView.find({
        viewer: req.user._id,
        story: { $in: stories.map((s) => s._id) },
      }).select("story");
      viewedSet = new Set(viewedRows.map((v) => v.story.toString()));
    }

    res.status(200).json({
      success: true,
      user: { id: author._id, username: author.username, fullName: author.fullName, avatar: author.avatar },
      stories: stories.map((s) => formatStory(s, isOwn || viewedSet.has(s._id.toString()))),
    });
  } catch (error) {
    next(error);
  }
};

// @route  POST /api/stories/:storyId/view
const recordView = async (req, res, next) => {
  try {
    const now = new Date();
    const story = await Story.findOne({ _id: req.params.storyId, expiresAt: { $gt: now } });

    if (!story) {
      return res.status(404).json({ success: false, message: "Story not found or expired" });
    }

    const isOwner = story.author.toString() === req.user._id.toString();

    if (!isOwner) {
      try {
        // Atomic upsert: with `new: false`, a null result means this call is
        // what just created the row — i.e. this is genuinely the first view.
        // If a document already existed, it's returned (truthy) and we skip
        // the increment. The unique index on {story, viewer} is what makes
        // this safe under concurrent requests; the catch below handles the
        // rare case where two upserts race and one loses with a duplicate-key
        // error instead of matching the existing row.
        const existing = await StoryView.findOneAndUpdate(
          { story: story._id, viewer: req.user._id },
          { $setOnInsert: { viewedAt: new Date() } },
          { upsert: true, new: false }
        );

        if (existing === null) {
          await Story.findByIdAndUpdate(story._id, { $inc: { viewsCount: 1 } });
        }
      } catch (err) {
        if (err.code !== 11000) throw err; // duplicate key = lost a concurrent race, not an error
      }
    }

    const current = await Story.findById(story._id).select("viewsCount");

    res.status(200).json({
      success: true,
      viewed: true,
      viewsCount: current.viewsCount,
    });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/stories/:storyId/viewers?page=&limit=
// Owner-only. Not gated on the story still being "active" — an owner should
// be able to see who viewed a story that just expired, up until MongoDB's TTL
// sweep physically removes the document (see Story.model.js).
const getViewers = async (req, res, next) => {
  try {
    const story = await Story.findById(req.params.storyId);

    if (!story) {
      return res.status(404).json({ success: false, message: "Story not found" });
    }

    if (story.author.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ success: false, message: "Only the story owner can view this" });
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      StoryView.find({ story: story._id })
        .sort({ viewedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("viewer", LIST_SELECT),
      StoryView.countDocuments({ story: story._id }),
    ]);

    const viewers = rows
      .filter((row) => row.viewer) // excludes rows whose user account no longer exists
      .map((row) => ({
        user: {
          id: row.viewer._id,
          username: row.viewer.username,
          fullName: row.viewer.fullName,
          avatar: row.viewer.avatar,
        },
        viewedAt: row.viewedAt,
      }));

    res.status(200).json({
      success: true,
      viewers,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// @route  DELETE /api/stories/:storyId
const deleteStory = async (req, res, next) => {
  try {
    const story = await Story.findById(req.params.storyId);

    if (!story) {
      return res.status(404).json({ success: false, message: "Story not found" });
    }

    if (story.author.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized to delete this story" });
    }

    // Best-effort Cloudinary cleanup — logged, not thrown, so a transient
    // Cloudinary outage never blocks the user from deleting their story.
    await destroyStoryMedia(story.publicId, story.mediaType).catch((err) => {
      console.error(`Failed to delete Cloudinary asset ${story.publicId}:`, err.message);
    });

    await StoryView.deleteMany({ story: story._id });
    await story.deleteOne();

    res.status(200).json({ success: true, message: "Story deleted" });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createStory,
  getFeed,
  getUserStories,
  recordView,
  getViewers,
  deleteStory,
};
