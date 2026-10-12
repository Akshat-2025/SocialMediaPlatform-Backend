const { detectMediaType } = require("../../src/utils/detectMediaType");

// Minimal real signatures — enough bytes to pass the sniff, not full valid files.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP", "ascii"),
]);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from("ftyp", "ascii"),
  Buffer.from("isom", "ascii"),
]);
const MOV = Buffer.concat([
  Buffer.from([0, 0, 0, 0x14]),
  Buffer.from("ftyp", "ascii"),
  Buffer.from("qt  ", "ascii"),
]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
const GARBAGE = Buffer.from("not a real media file, just text padding here", "ascii");

describe("detectMediaType", () => {
  test("recognizes JPEG by magic bytes", () => {
    expect(detectMediaType(JPEG)).toEqual({ mediaType: "image", format: "jpeg" });
  });

  test("recognizes PNG by magic bytes", () => {
    expect(detectMediaType(PNG)).toEqual({ mediaType: "image", format: "png" });
  });

  test("recognizes WebP (RIFF/WEBP container)", () => {
    expect(detectMediaType(WEBP)).toEqual({ mediaType: "image", format: "webp" });
  });

  test("recognizes MP4 (ftyp box)", () => {
    expect(detectMediaType(MP4)).toEqual({ mediaType: "video", format: "mp4" });
  });

  test("recognizes MOV (ftyp box, qt brand)", () => {
    expect(detectMediaType(MOV)).toEqual({ mediaType: "video", format: "mov" });
  });

  test("recognizes WebM (EBML header)", () => {
    expect(detectMediaType(WEBM)).toEqual({ mediaType: "video", format: "webm" });
  });

  test("rejects unrecognized content — this is what stops a relabeled .exe", () => {
    expect(detectMediaType(GARBAGE)).toBeNull();
  });

  test("rejects an empty/tiny buffer rather than throwing", () => {
    expect(detectMediaType(Buffer.alloc(2))).toBeNull();
    expect(detectMediaType(null)).toBeNull();
    expect(detectMediaType(undefined)).toBeNull();
  });

  test("a PNG relabeled with a video mimetype is still sniffed as an image — proves the check doesn't trust the label", () => {
    const sniffed = detectMediaType(PNG);
    expect(sniffed.mediaType).toBe("image"); // controller compares this against req.file.mimetype and rejects on mismatch
  });
});
