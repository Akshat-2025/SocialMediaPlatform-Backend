const jwt = require("jsonwebtoken");

const generateToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
};

const setTokenCookie = (res, token) => {
  const cookieName = process.env.JWT_COOKIE_NAME || "token";

  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
};

const clearTokenCookie = (res) => {
  const cookieName = process.env.JWT_COOKIE_NAME || "token";
  res.clearCookie(cookieName);
};

module.exports = { generateToken, setTokenCookie, clearTokenCookie };
