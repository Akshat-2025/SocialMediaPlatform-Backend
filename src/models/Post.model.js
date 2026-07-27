const mongoose = require("mongoose");

const postSchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    content: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    images: [
      {
        url: { type: String, required: true },
        publicId: { type: String, required: true },
      },
    ],
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    commentsCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

// A post needs either text content or at least one image
postSchema.pre("validate", function (next) {
  if (!this.content && (!this.images || this.images.length === 0)) {
    return next(new Error("Post must have content or at least one image"));
  }
  next();
});

postSchema.index({ author: 1, createdAt: -1 });

module.exports = mongoose.model("Post", postSchema);
