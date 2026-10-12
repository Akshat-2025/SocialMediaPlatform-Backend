const multer = require("multer");

// Separate Multer instance from middleware/upload.middleware.js (which is
// images-only, 5MB, used by posts/avatar) — stories need video support and
// different limits, and this keeps that change from touching existing,
// working upload paths at all.
const storage = multer.memoryStorage();

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

// Client-claimed MIME type is just the first, cheap filter (reject obviously
// wrong uploads before spending time buffering them). The real check is the
// magic-byte sniff in story.controller.js once we have the buffer in hand —
// see utils/detectMediaType.js.
const fileFilter = (req, file, cb) => {
  if (ALLOWED_IMAGE_TYPES.includes(file.mimetype) || ALLOWED_VIDEO_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only JPEG/PNG/WebP images or MP4/MOV/WebM videos are allowed"), false);
  }
};

const STORY_MAX_IMAGE_MB = parseInt(process.env.STORY_MAX_IMAGE_MB) || 10;
const STORY_MAX_VIDEO_MB = parseInt(process.env.STORY_MAX_VIDEO_MB) || 50;

// Multer can't apply a different limit per mimetype up front, so the limit here
// is the larger of the two (video); the smaller image cap is enforced
// explicitly in the controller once we know, from the sniffed bytes, which
// kind of file this actually is.
const uploadStory = multer({
  storage,
  fileFilter,
  limits: { fileSize: Math.max(STORY_MAX_IMAGE_MB, STORY_MAX_VIDEO_MB) * 1024 * 1024 },
});

module.exports = { uploadStory, STORY_MAX_IMAGE_MB, STORY_MAX_VIDEO_MB };
