const express = require("express");
const {
  createPost,
  getFeed,
  getUserPosts,
  getPostById,
  deletePost,
  toggleLike,
  addComment,
  getComments,
  deleteComment,
} = require("../controllers/post.controller");
const { protect } = require("../middleware/auth.middleware");
const validate = require("../middleware/validate.middleware");
const upload = require("../middleware/upload.middleware");
const { createPostSchema, createCommentSchema } = require("../validations/post.validation");

const router = express.Router();

// All post routes require auth
router.use(protect);

router.post("/", upload.array("images", 4), validate(createPostSchema), createPost);
router.get("/", getFeed);
router.get("/user/:userId", getUserPosts);
router.get("/:id", getPostById);
router.delete("/:id", deletePost);

router.post("/:id/like", toggleLike);

router.get("/:id/comments", getComments);
router.post("/:id/comments", validate(createCommentSchema), addComment);
router.delete("/:postId/comments/:commentId", deleteComment);

module.exports = router;
