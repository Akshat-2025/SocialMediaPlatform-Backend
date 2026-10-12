const express = require("express");
const {
  createStory,
  getFeed,
  getUserStories,
  recordView,
  getViewers,
  deleteStory,
} = require("../controllers/story.controller");
const { protect } = require("../middleware/auth.middleware");
const validate = require("../middleware/validate.middleware");
const validateObjectId = require("../middleware/validateObjectId.middleware");
const { uploadStory } = require("../middleware/uploadStory.middleware");
const { createStorySchema } = require("../validations/story.validation");

const router = express.Router();

// All story routes require auth, matching posts/notifications/messages
router.use(protect);

router.post("/", uploadStory.single("media"), validate(createStorySchema), createStory);
router.get("/feed", getFeed);
router.get("/user/:userId", validateObjectId("userId"), getUserStories);

router.post("/:storyId/view", validateObjectId("storyId"), recordView);
router.get("/:storyId/viewers", validateObjectId("storyId"), getViewers);
router.delete("/:storyId", validateObjectId("storyId"), deleteStory);

module.exports = router;
