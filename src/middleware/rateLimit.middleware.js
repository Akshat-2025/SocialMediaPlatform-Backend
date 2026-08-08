const rateLimit = require("express-rate-limit");

// Applied to login/register/refresh — brute-force / credential-stuffing protection
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts, please try again in a few minutes",
  },
});

// Applied to the whole API — generous, just a backstop against abuse/scraping
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests, please slow down",
  },
});

module.exports = { authLimiter, apiLimiter };
