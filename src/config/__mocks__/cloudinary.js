const { Writable } = require("stream");

// Stand-in for config/cloudinary.js. upload_stream mimics the real
// streaming-upload API shape (pipe a Readable into it, get a callback) so
// src/utils/cloudinaryStory.js's real streaming code runs unmodified against
// this fake client — only the network call itself is replaced.
const mockCloudinary = {
  uploader: {
    upload_stream: jest.fn((options, callback) => {
      const sink = new Writable({
        write(chunk, enc, cb) {
          cb();
        },
      });
      sink.on("finish", () => {
        callback(null, mockCloudinary.__nextUploadResult);
      });
      return sink;
    }),
    destroy: jest.fn().mockResolvedValue({ result: "ok" }),
  },
  url: jest.fn((publicId) => `https://res.cloudinary.com/demo/video/upload/${publicId}.jpg`),
  config: jest.fn(),
  // Tests set this before making a request to control what the "upload" returns
  __nextUploadResult: {
    secure_url: "https://res.cloudinary.com/demo/image/upload/v1/social-media/stories/default.jpg",
    public_id: "social-media/stories/default",
  },
};

module.exports = mockCloudinary;
