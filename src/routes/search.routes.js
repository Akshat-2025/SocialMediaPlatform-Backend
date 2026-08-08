const express = require("express");
const { searchUsers, searchPosts } = require("../controllers/search.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(protect);

router.get("/users", searchUsers);
router.get("/posts", searchPosts);

module.exports = router;
