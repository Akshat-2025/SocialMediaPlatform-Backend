const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
      lowercase: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
      select: false, // never return password by default
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
    },
    bio: {
      type: String,
      default: "",
      maxlength: 160,
    },
    avatar: {
      url: { type: String, default: "" },
      publicId: { type: String, default: "" },
    },
    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    following: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    refreshTokens: [{ type: String, select: false }],
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
