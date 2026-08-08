const User = require("../models/User.model");
const Post = require("../models/Post.model");

const USER_SELECT = "username fullName avatar bio";
const AUTHOR_SELECT = "username fullName avatar";

// Escapes regex special characters so user input can't break the query
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// @route  GET /api/search/users?q=&page=&limit=
const searchUsers = async (req, res, next) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) {
      return res.status(400).json({ success: false, message: "Query param 'q' is required" });
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const pattern = new RegExp(escapeRegex(q), "i");
    const filter = { $or: [{ username: pattern }, { fullName: pattern }] };

    const [users, total] = await Promise.all([
      User.find(filter).select(USER_SELECT).skip(skip).limit(limit),
      User.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      users,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/search/posts?q=&page=&limit=
const searchPosts = async (req, res, next) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) {
      return res.status(400).json({ success: false, message: "Query param 'q' is required" });
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const filter = { content: new RegExp(escapeRegex(q), "i") };

    const [posts, total] = await Promise.all([
      Post.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("author", AUTHOR_SELECT),
      Post.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      posts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { searchUsers, searchPosts };
