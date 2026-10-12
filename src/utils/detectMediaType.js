/**
 * Sniffs a file buffer's actual magic bytes to determine its real media type,
 * independent of whatever MIME type the client claimed in the multipart
 * request (client-supplied MIME types are trivially spoofable).
 *
 * Returns { mediaType: 'image'|'video', format: string } or null if the
 * buffer doesn't match any supported signature.
 */
const detectMediaType = (buffer) => {
  if (!buffer || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mediaType: "image", format: "jpeg" };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { mediaType: "image", format: "png" };
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mediaType: "image", format: "webp" };
  }

  // MP4 / MOV / M4V (ISO base media file format): bytes 4-7 are "ftyp"
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12).trim().toLowerCase();
    // qt = QuickTime (.mov), everything else in this family we accept is mp4-ish
    const format = brand === "qt" ? "mov" : "mp4";
    return { mediaType: "video", format };
  }

  // WebM / Matroska (EBML header): 1A 45 DF A3
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return { mediaType: "video", format: "webm" };
  }

  return null;
};

module.exports = { detectMediaType };
