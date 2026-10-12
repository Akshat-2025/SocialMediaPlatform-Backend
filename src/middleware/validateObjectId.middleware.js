const mongoose = require("mongoose");

// user.controller.js inlines this same check once (toggleFollow); Stories
// needs it on several params (storyId, userId), so it's pulled out here rather
// than duplicated. Scoped to Stories routes only — nothing elsewhere changes.
const validateObjectId = (paramName) => (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params[paramName])) {
    return res.status(400).json({ success: false, message: `Invalid ${paramName}` });
  }
  next();
};

module.exports = validateObjectId;
