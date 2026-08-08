const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Readable } = require("stream");
const User = require("../models/User.model");
const cloudinary = require("../config/cloudinary");
// const { generateToken, setTokenCookie, clearTokenCookie } = require("../utils/generateToken");
const {
  issueAuthCookies,
  clearAuthCookies,
  REFRESH_COOKIE,
} = require("../utils/generateToken");
const { hashToken } = require("../utils/hashToken");

const MAX_REFRESH_TOKENS_PER_USER = 5; // roughly "5 active devices"

// Stores a new refresh token hash for the user, pruning the oldest if over the cap
const storeRefreshToken = async (userId, refreshToken) => {
  const tokenHash = hashToken(refreshToken);
  const user = await User.findById(userId).select("+refreshTokens");
  user.refreshTokens.push(tokenHash);
  if (user.refreshTokens.length > MAX_REFRESH_TOKENS_PER_USER) {
    user.refreshTokens = user.refreshTokens.slice(-MAX_REFRESH_TOKENS_PER_USER);
  }
  await user.save();
};
// Helper: strip sensitive fields before sending user back to client
const sanitizeUser = (user) => ({
  id: user._id,
  username: user.username,
  email: user.email,
  fullName: user.fullName,
  bio: user.bio,
  avatar: user.avatar,
  followers: user.followers,
  following: user.following,
  createdAt: user.createdAt,
});

// @route  POST /api/auth/register
const register = async (req, res, next) => {
  try {
    const { username, email, password, fullName } = req.body;

    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message:
          existingUser.email === email ? "Email already in use" : "Username already taken",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      username,
      email,
      password: hashedPassword,
      fullName,
    });

    const token = generateToken(user._id);
    setTokenCookie(res, token);

    res.status(201).json({
      success: true,
      message: "Registered successfully",
      user: sanitizeUser(user),
    }); 
  } catch (error) {
    next(error);
  }
};

// @route  POST /api/auth/login
const login = async (req, res, next) => {
  try {
    const { emailOrUsername, password } = req.body;

    const user = await User.findOne({
      $or: [{ email: emailOrUsername }, { username: emailOrUsername }],
    }).select("+password");

    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const token = generateToken(user._id);
    setTokenCookie(res, token);

    res.status(200).json({
      success: true,
      message: "Logged in successfully",
      user: sanitizeUser(user),
    });
  } catch (error) {
    next(error);
  }
};

// @route  POST /api/auth/logout
const logout = async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];

    if (refreshToken) {
      try {
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
        const tokenHash = hashToken(refreshToken);
        await User.findByIdAndUpdate(decoded.id, { $pull: { refreshTokens: tokenHash } });
      } catch {
        // Token already invalid/expired — nothing to revoke, just clear cookies below
      }
    }

    clearAuthCookies(res);
    res.status(200).json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    next(error);
  }
};

// @route  POST /api/auth/refresh
// Rotates the refresh token: the old one is invalidated and a new pair is issued.
// This limits the damage of a leaked refresh token to a single use.
const refresh = async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];

    if (!refreshToken) {
      return res.status(401).json({ success: false, message: "No refresh token provided" });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      clearAuthCookies(res);
      return res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
    }

    const tokenHash = hashToken(refreshToken);
    const user = await User.findOne({ _id: decoded.id, refreshTokens: tokenHash }).select(
      "+refreshTokens"
    );

    if (!user) {
      // Token not found in the store: either already rotated/logged-out, or reuse of a
      // stolen token. Clear cookies and force a fresh login either way.
      clearAuthCookies(res);
      return res.status(401).json({ success: false, message: "Refresh token not recognized" });
    }

    // Rotate: drop the used hash, issue + store a new pair
    user.refreshTokens = user.refreshTokens.filter((h) => h !== tokenHash);
    await user.save();

    const newTokens = issueAuthCookies(res, user._id);
    await storeRefreshToken(user._id, newTokens.refreshToken);

    res.status(200).json({ success: true, message: "Token refreshed" });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/auth/me
const getMe = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, user: sanitizeUser(req.user) });
  } catch (error) {
    next(error);
  }
};

// @route  PATCH /api/auth/profile
const updateProfile = async (req, res, next) => {
  try {
    const { fullName, bio, username } = req.body;

    if (username !== undefined && username !== req.user.username) {
      const taken = await User.findOne({ username, _id: { $ne: req.user._id } });
      if (taken) {
        return res.status(409).json({ success: false, message: "Username already taken" });
      }
      req.user.username = username;
    }

    if (fullName !== undefined) req.user.fullName = fullName;
    if (bio !== undefined) req.user.bio = bio;

    await req.user.save();

    res.status(200).json({
      success: true,
      message: "Profile updated",
      user: sanitizeUser(req.user),
    });
  } catch (error) {
    next(error);
  }
};

// @route  DELETE /api/auth/avatar
const removeAvatar = async (req, res, next) => {
  try {
    if (req.user.avatar?.publicId) {
      await cloudinary.uploader.destroy(req.user.avatar.publicId).catch(() => {});
    }

    req.user.avatar = { url: "", publicId: "" };
    await req.user.save();

    res.status(200).json({ success: true, message: "Avatar removed", avatar: req.user.avatar });
  } catch (error) {
    next(error);
  }
};

// @route  POST /api/auth/avatar
const uploadAvatar = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file provided" });
    }

    // Remove old avatar from Cloudinary if it exists
    if (req.user.avatar?.publicId) {
      await cloudinary.uploader.destroy(req.user.avatar.publicId).catch(() => {});
    }

    const uploadFromBuffer = () =>
      new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { folder: "social-media/avatars", resource_type: "image" },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        Readable.from(req.file.buffer).pipe(uploadStream);
      });

    const result = await uploadFromBuffer();

    req.user.avatar = { url: result.secure_url, publicId: result.public_id };
    await req.user.save();

    res.status(200).json({
      success: true,
      message: "Avatar updated",
      avatar: req.user.avatar,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { 
  register, 
  login, 
  logout, 
  refresh,
  getMe, 
  updateProfile, 
  uploadAvatar,
  removeAvatar,
};
