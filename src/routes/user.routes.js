const express = require("express");
const {
  getUserProfile,
  toggleFollow,
  getFollowers,
  getFollowing,
} = require("../controllers/user.controller");
const { protect, optionalAuth } = require("../middleware/auth.middleware");

const router = express.Router();

// Public (but adapts if the visitor is logged in, to include isFollowing)
router.get("/:username", optionalAuth, getUserProfile);

// Auth required
router.post("/:id/follow", protect, toggleFollow);
router.get("/:id/followers", getFollowers);
router.get("/:id/following", getFollowing);

module.exports = router;
