const jwt = require("jsonwebtoken");

const ACCESS_COOKIE = process.env.JWT_COOKIE_NAME || "token";
const REFRESH_COOKIE = process.env.JWT_REFRESH_COOKIE_NAME || "refreshToken";

const generateAccessToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
  });
};

const generateRefreshToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "30d",
  });
};

const cookieBase = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
});

const setAccessCookie = (res, token) => {
  res.cookie(ACCESS_COOKIE, token, {
    ...cookieBase(),
    maxAge: 15 * 60 * 1000, // 15 minutes
  });
};

const setRefreshCookie = (res, token) => {
  res.cookie(REFRESH_COOKIE, token, {
    ...cookieBase(),
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: "/api/auth", // only sent to auth routes (refresh/logout)
  });
};

// Issues + sets both cookies for a login/register/refresh response
const issueAuthCookies = (res, userId) => {
  const accessToken = generateAccessToken(userId);
  const refreshToken = generateRefreshToken(userId);
  setAccessCookie(res, accessToken);
  setRefreshCookie(res, refreshToken);
  return { accessToken, refreshToken };
};

const clearAuthCookies = (res) => {
  res.clearCookie(ACCESS_COOKIE);
  res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
};

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  generateAccessToken,
  generateRefreshToken,
  issueAuthCookies,
  clearAuthCookies,
};
