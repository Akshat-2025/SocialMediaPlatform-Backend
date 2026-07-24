# Social Media Backend

Node.js/Express backend — Auth module, built MVC-style, ready to expand with
Posts, Follow, Messaging, and Notifications later.

## Stack
Express · MongoDB Atlas (Mongoose) · JWT (httpOnly cookie) · bcrypt · Multer + Cloudinary ·
Zod · Helmet · CORS · Morgan · Socket.io (skeleton, auth-aware)

## Structure
```
src/
  config/       # db.js, cloudinary.js
  controllers/  # auth.controller.js
  middleware/   # auth, validate, upload, error
  models/       # User.model.js
  routes/       # auth.routes.js
  sockets/      # index.js (JWT-authenticated socket layer)
  validations/  # auth.validation.js (Zod schemas)
  utils/        # generateToken.js
  app.js        # Express app (middleware + routes)
  server.js     # entry point (HTTP + Socket.io + DB connect)
```

## Setup
```bash
npm install
cp .env.example .env   # fill in MONGO_URI, JWT_SECRET, CLOUDINARY_* etc.
npm run dev            # nodemon
```

## API

| Method | Route                | Auth | Description                          |
|--------|-----------------------|------|---------------------------------------|
| POST   | /api/auth/register    | No   | Create account, sets JWT cookie       |
| POST   | /api/auth/login       | No   | Login with email/username + password  |
| POST   | /api/auth/logout      | No   | Clears the auth cookie                |
| GET    | /api/auth/me          | Yes  | Get current logged-in user            |
| PATCH  | /api/auth/profile     | Yes  | Update fullName / bio                 |
| POST   | /api/auth/avatar      | Yes  | Upload avatar (`multipart/form-data`, field: `avatar`) → Cloudinary |
| GET    | /api/health           | No   | Health check                          |

Auth uses an httpOnly cookie (`JWT_COOKIE_NAME`, default `token`), so the frontend must call
these with `credentials: "include"` (fetch) or `withCredentials: true` (Axios), and `CLIENT_URL`
in `.env` must match the frontend origin exactly for CORS + cookies to work.

## Notes for next steps
- Posts/Follow/Messaging/Notifications modules aren't built yet — add them as new
  `models/`, `controllers/`, `routes/` following the same pattern as `auth`.
- Socket.io is wired with JWT-cookie auth on connection (`src/sockets/index.js`) and tracks
  online users, ready to hang chat/notification events off of.
- `req.app.get("io")` gives any controller access to the Socket.io instance to emit events.
