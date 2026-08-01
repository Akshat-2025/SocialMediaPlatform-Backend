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
  controllers/  # auth.controller.js, post.controller.js, user.controller.js
  middleware/   # auth (protect + optionalAuth), validate, upload, error
  models/       # User.model.js, Post.model.js, Comment.model.js
  routes/       # auth.routes.js, post.routes.js, user.routes.js
  sockets/      # index.js (JWT-authenticated socket layer)
  validations/  # auth.validation.js, post.validation.js (Zod schemas)
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

### Posts & comments (all require auth)

| Method | Route                                  | Description                                  |
|--------|------------------------------------------|-----------------------------------------------|
| POST   | /api/posts                              | Create post (`content` + up to 4 `images`)    |
| GET    | /api/posts?page=&limit=                 | Paginated feed, newest first                  |
| GET    | /api/posts/user/:userId?page=&limit=    | Paginated posts by one user                   |
| GET    | /api/posts/:id                          | Get a single post                             |
| DELETE | /api/posts/:id                          | Delete own post (cleans up Cloudinary images) |
| POST   | /api/posts/:id/like                     | Toggle like/unlike                            |
| GET    | /api/posts/:id/comments?page=&limit=    | Paginated comments, newest first              |
| POST   | /api/posts/:id/comments                 | Add a comment                                 |
| DELETE | /api/posts/:postId/comments/:commentId  | Delete own comment                            |

`POST /api/posts` accepts `multipart/form-data` when sending images (field name `images`,
max 4), or plain JSON with just `content` for text-only posts.

### Users & follow

| Method | Route                              | Auth      | Description                              |
|--------|--------------------------------------|-----------|-------------------------------------------|
| GET    | /api/users/:username                | Optional  | Public profile; includes `isFollowing` if logged in |
| POST   | /api/users/:id/follow                | Yes       | Toggle follow/unfollow (by user id)        |
| GET    | /api/users/:id/followers?page=&limit=| No        | Paginated followers list                   |
| GET    | /api/users/:id/following?page=&limit=| No        | Paginated following list                   |

Auth uses an httpOnly cookie (`JWT_COOKIE_NAME`, default `token`), so the frontend must call
these with `credentials: "include"` (fetch) or `withCredentials: true` (Axios), and `CLIENT_URL`
in `.env` must match the frontend origin exactly for CORS + cookies to work.

## Notes for next steps
- Direct Messages and Notifications aren't built yet — add them as new
  `models/`, `controllers/`, `routes/` following the same pattern as `auth`/`posts`/`users`.
- Follow/unfollow uses `$addToSet`/`$pull` on the existing `followers`/`following` arrays on
  `User` (atomic, avoids race conditions) rather than loading + mutating the array in JS.
- Posts store `likes` as a `User` ref array and `commentsCount` as a denormalized counter for
  fast feed rendering; comments live in their own collection (`Comment.model.js`), keyed by `post`.
- Socket.io is wired with JWT-cookie auth on connection (`src/sockets/index.js`) and tracks
  online users, ready to hang chat/notification events off of.
- `req.app.get("io")` gives any controller access to the Socket.io instance to emit events —
  e.g. emit a `user:followed` event from `toggleFollow` once real-time notifications are added.
