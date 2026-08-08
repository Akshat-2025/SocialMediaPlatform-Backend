const crypto = require("crypto");

// Refresh tokens are already high-entropy JWTs, so a fast deterministic hash
// (rather than bcrypt) is fine here and lets us look them up directly by hash.
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

module.exports = { hashToken };
