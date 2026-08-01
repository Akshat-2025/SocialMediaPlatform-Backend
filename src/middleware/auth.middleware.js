const jwt = require("jsonwebtoken");
const User = require("../models/User.model");

const protect = async (req, res, next) => {
  try {
    const cookieName = process.env.JWT_COOKIE_NAME || "token";
    let token = req.cookies?.[cookieName];

    // Fallback: allow Bearer token in Authorization header
    if (!token && req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ success: false, message: "User no longer exists" });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    const cookieName = process.env.JWT_COOKIE_NAME || "token";
    let token = req.cookies?.[cookieName];

    if (!token && req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      req.user = null;
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    req.user = user || null;
    next();
  } catch (error) {
    req.user = null;
    next();
  }
}; 

module.exports = { protect, optionalAuth };
