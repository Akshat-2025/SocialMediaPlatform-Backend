const { Readable } = require("stream");
const cloudinary = require("../config/cloudinary");

const STORY_FOLDER = "social-media/stories";

/**
 * Uploads a story's media buffer to Cloudinary under the correct resource_type.
 * Mirrors post.controller.js's uploadImageBuffer, extended to cover video.
 *
 * For video, Cloudinary probes the actual file and returns `duration` in the
 * result — that's where Story.duration comes from, never from client input.
 */
const uploadStoryMedia = (buffer, mediaType) =>
  new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: STORY_FOLDER,
        resource_type: mediaType === "video" ? "video" : "image",
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    Readable.from(buffer).pipe(uploadStream);
  });

/**
 * Derives a thumbnail (poster-frame) URL for a video story without a second
 * upload — Cloudinary can render a still frame of an already-uploaded video
 * by requesting the same public_id as an image.
 */
const getVideoThumbnailUrl = (publicId) =>
  cloudinary.url(publicId, {
    resource_type: "video",
    format: "jpg",
  });

const destroyStoryMedia = (publicId, mediaType) =>
  cloudinary.uploader.destroy(publicId, {
    resource_type: mediaType === "video" ? "video" : "image",
  });

module.exports = { uploadStoryMedia, getVideoThumbnailUrl, destroyStoryMedia, STORY_FOLDER };
