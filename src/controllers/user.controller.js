const mongoose = require("mongoose");
const User = require("../models/User.model");
const { notify } = require("../utils/notify");

const PUBLIC_SELECT = "username fullName bio avatar followers following createdAt";
const LIST_SELECT = "username fullName avatar";

// @route  GET /api/users/:username
const getUserProfile = async (req, res, next) => {
  try {
    const user = await User.findOne({ username: req.params.username.toLowerCase() }).select(
      PUBLIC_SELECT
    );

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        fullName: user.fullName,
        bio: user.bio,
        avatar: user.avatar,
        followersCount: user.followers.length,
        followingCount: user.following.length,
        isFollowing: req.user
          ? user.followers.some((id) => id.toString() === req.user._id.toString())
          : false,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @route  POST /api/users/:id/follow  (toggles follow/unfollow)
const toggleFollow = async (req, res, next) => {
  try {
    const targetId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ success: false, message: "Invalid user id" });
    }

    if (targetId === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: "You cannot follow yourself" });
    }

    const targetUser = await User.findById(targetId);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const alreadyFollowing = targetUser.followers.some(
      (id) => id.toString() === req.user._id.toString()
    );

    if (alreadyFollowing) {
      await User.findByIdAndUpdate(targetId, { $pull: { followers: req.user._id } });
      await User.findByIdAndUpdate(req.user._id, { $pull: { following: targetId } });
    } else {
      await User.findByIdAndUpdate(targetId, { $addToSet: { followers: req.user._id } });
      await User.findByIdAndUpdate(req.user._id, { $addToSet: { following: targetId } });
    }

    const updatedTarget = await User.findById(targetId).select("followers");

    if (!alreadyFollowing) {
      await notify(req, {
        recipientId: targetId,
        senderId: req.user._id,
        type: "follow",
      });
    }

    res.status(200).json({
      success: true,
      following: !alreadyFollowing,
      followersCount: updatedTarget.followers.length,
    });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/users/:id/followers?page=&limit=
const getFollowers = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const user = await User.findById(req.params.id).select("followers");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const total = user.followers.length;
    const pageIds = user.followers.slice(skip, skip + limit);

    const followers = await User.find({ _id: { $in: pageIds } }).select(LIST_SELECT);

    res.status(200).json({
      success: true,
      followers,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/users/:id/following?page=&limit=
const getFollowing = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const user = await User.findById(req.params.id).select("following");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const total = user.following.length;
    const pageIds = user.following.slice(skip, skip + limit);

    const following = await User.find({ _id: { $in: pageIds } }).select(LIST_SELECT);

    res.status(200).json({
      success: true,
      following,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getUserProfile, toggleFollow, getFollowers, getFollowing };
