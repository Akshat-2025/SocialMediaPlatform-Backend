const express = require("express");
const {
  register,
  login,
  logout,
  refresh,
  getMe,
  updateProfile,
  uploadAvatar,
  removeAvatar,
} = require("../controllers/auth.controller");
const { protect } = require("../middleware/auth.middleware");
const validate = require("../middleware/validate.middleware");
const upload = require("../middleware/upload.middleware");
const { authLimiter } = require("../middleware/rateLimit.middleware");
const {
  registerSchema,
  loginSchema,
  updateProfileSchema,
} = require("../validations/auth.validation");

const router = express.Router();

// Public routes — login/register/refresh are rate-limited to slow down credential
// stuffing and brute-force attempts
router.post("/register", authLimiter, validate(registerSchema), register);
router.post("/login", authLimiter, validate(loginSchema), login);
router.post("/refresh", authLimiter, refresh);
router.post("/logout", logout);

// Protected routes
router.get("/me", protect, getMe);
router.patch("/profile", protect, validate(updateProfileSchema), updateProfile);
router.post("/avatar", protect, upload.single("avatar"), uploadAvatar);
router.delete("/avatar", protect, removeAvatar);

module.exports = router;
