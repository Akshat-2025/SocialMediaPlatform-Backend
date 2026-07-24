const express = require("express");
const {
  register,
  login,
  logout,
  getMe,
  updateProfile,
  uploadAvatar,
} = require("../controllers/auth.controller");
const { protect } = require("../middleware/auth.middleware");
const validate = require("../middleware/validate.middleware");
const upload = require("../middleware/upload.middleware");
const {
  registerSchema,
  loginSchema,
  updateProfileSchema,
} = require("../validations/auth.validation");

const router = express.Router();

// Public routes
router.post("/register", validate(registerSchema), register);
router.post("/login", validate(loginSchema), login);
router.post("/logout", logout);

// Protected routes
router.get("/me", protect, getMe);
router.patch("/profile", protect, validate(updateProfileSchema), updateProfile);
router.post("/avatar", protect, upload.single("avatar"), uploadAvatar);

module.exports = router;
