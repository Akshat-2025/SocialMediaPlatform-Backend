// Runs before the test framework is installed, before any test file or app
// module is required. Deliberately uses dummy values rather than the real
// .env — tests never touch real credentials or a real database.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-in-production";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret-do-not-use-in-production";
process.env.JWT_COOKIE_NAME = "token";
process.env.CLIENT_URL = "http://localhost:3000";
process.env.STORY_MAX_IMAGE_MB = "10";
process.env.STORY_MAX_VIDEO_MB = "50";
process.env.STORY_MAX_VIDEO_DURATION_SEC = "60";
