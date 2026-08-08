# Social Media Backend

Node.js/Express backend, built MVC-style. Feature-complete: auth (with refresh tokens),
posts (+ likes/comments, edit), follow, notifications, direct messages, search, and
security hardening (rate limiting, NoSQL-injection/HPP protection).

## Stack
Express · MongoDB Atlas (Mongoose) · JWT access + refresh tokens (httpOnly cookies) · bcrypt ·
Multer + Cloudinary · Zod · Helmet · CORS · Morgan · Socket.io · express-rate-limit ·
express-mongo-sanitize · hpp

## Structure
```
src/
  config/       # db.js, cloudinary.js
  controllers/  # auth, post, user, notification, message, search controllers
  middleware/   # auth (protect + optionalAuth), validate, upload, rateLimit, error
  models/       # User, Post, Comment, Notification, Conversation, Message
  routes/       # auth, post, user, notification, message, search routes
  sockets/      # index.js (JWT-authenticated socket layer, per-user rooms, typing relay)
  validations/  # auth, post, message (Zod schemas)
  utils/        # generateToken.js (access+refresh), hashToken.js, notify.js
  app.js        # Express app (middleware + routes)
  server.js     # entry point (HTTP + Socket.io + DB connect)
```

## Setup
```bash
npm install
cp .env.example .env   # fill in MONGO_URI, JWT secrets, CLOUDINARY_* etc.
npm run dev             # nodemon
```

## Auth: access + refresh tokens
- **Access token** (`JWT_COOKIE_NAME`, default `token`) — short-lived (15m default), sent on
  every request, read by `protect`/`optionalAuth`.
- **Refresh token** (`JWT_REFRESH_COOKIE_NAME`, default `refreshToken`) — long-lived (30d
  default), scoped to `path: /api/auth` so it's never sent on regular API calls, and stored
  server-side as a SHA-256 hash on the user (`User.refreshTokens`, capped at 5 — roughly
  5 active devices).
- **`POST /api/auth/refresh`** — rotates the refresh token: the used one is deleted from the
  store and a new access+refresh pair is issued. A refresh token that isn't found in the
  store (already rotated, or logged out) is rejected — the frontend should call this
  endpoint when a request comes back 401, then retry once.
- **`POST /api/auth/logout`** — revokes the specific refresh token's hash and clears both
  cookies.

## API

| Method | Route                | Auth | Description                          |
|--------|-----------------------|------|---------------------------------------|
| POST   | /api/auth/register    | No   | Create account, sets access+refresh cookies |
| POST   | /api/auth/login       | No   | Login, sets access+refresh cookies    |
| POST   | /api/auth/refresh     | No   | Rotate refresh token, issue new pair  |
| POST   | /api/auth/logout      | No   | Revoke refresh token, clear cookies   |
| GET    | /api/auth/me          | Yes  | Get current logged-in user            |
| PATCH  | /api/auth/profile     | Yes  | Update `username` / `fullName` / `bio` |
| POST   | /api/auth/avatar      | Yes  | Upload avatar (`multipart/form-data`, field: `avatar`) → Cloudinary |
| DELETE | /api/auth/avatar      | Yes  | Remove current avatar                 |
| GET    | /api/health           | No   | Health check                          |

`register`/`login`/`refresh` are rate-limited (20 requests / 15 min per IP) via
`middleware/rateLimit.middleware.js`; the whole `/api` surface has a more generous limiter
(300 / 15 min) as a backstop.

### Posts & comments (all require auth)

| Method | Route                                  | Description                                  |
|--------|------------------------------------------|-----------------------------------------------|
| POST   | /api/posts                              | Create post (`content` + up to 4 `images`)    |
| GET    | /api/posts?page=&limit=                 | Paginated feed, newest first                  |
| GET    | /api/posts/user/:userId?page=&limit=    | Paginated posts by one user                   |
| GET    | /api/posts/:id                          | Get a single post                             |
| PATCH  | /api/posts/:id                          | Edit own post: `content`, `removeImageIds[]`, new `images` |
| DELETE | /api/posts/:id                          | Delete own post (cleans up Cloudinary images) |
| POST   | /api/posts/:id/like                     | Toggle like/unlike                            |
| GET    | /api/posts/:id/comments?page=&limit=    | Paginated comments, newest first              |
| POST   | /api/posts/:id/comments                 | Add a comment                                 |
| PATCH  | /api/posts/:postId/comments/:commentId  | Edit own comment                              |
| DELETE | /api/posts/:postId/comments/:commentId  | Delete own comment                            |

`POST`/`PATCH /api/posts` accept `multipart/form-data` when sending images (field name
`images`, max 4 total), or plain JSON with just `content` for text-only posts.

### Users & follow

| Method | Route                              | Auth      | Description                              |
|--------|--------------------------------------|-----------|-------------------------------------------|
| GET    | /api/users/:username                | Optional  | Public profile; includes `isFollowing` if logged in |
| POST   | /api/users/:id/follow                | Yes       | Toggle follow/unfollow (by user id)        |
| GET    | /api/users/:id/followers?page=&limit=| No        | Paginated followers list                   |
| GET    | /api/users/:id/following?page=&limit=| No        | Paginated following list                   |

### Search (all require auth)

| Method | Route                          | Description                                |
|--------|----------------------------------|------------------------------------------------|
| GET    | /api/search/users?q=&page=&limit= | Search by username / full name (case-insensitive) |
| GET    | /api/search/posts?q=&page=&limit= | Search post content (case-insensitive)     |

User input is regex-escaped before being used in the query, so special characters in `q`
can't break or hijack the search.

### Notifications (all require auth)

| Method | Route                        | Description                                    |
|--------|-------------------------------|--------------------------------------------------|
| GET    | /api/notifications?page=&limit= | Paginated list, newest first, includes `unreadCount` |
| PATCH  | /api/notifications/:id/read     | Mark one notification as read                  |
| PATCH  | /api/notifications/read-all     | Mark all as read                               |

Notifications are created for `like`, `comment`, and `follow` events (never for actions on
your own content) and pushed in real time over Socket.io to `user:<id>` as `notification:new`,
in addition to being saved for the REST endpoints above.

### Direct messages (all require auth)

| Method | Route                                                  | Description                                |
|--------|-----------------------------------------------------------|------------------------------------------------|
| GET    | /api/messages/conversations?page=&limit=                   | List your conversations, most recent first     |
| POST   | /api/messages/conversations/:userId                        | Get or create the 1:1 conversation with a user |
| GET    | /api/messages/conversations/:conversationId/messages       | Paginated message history, newest first        |
| POST   | /api/messages/conversations/:conversationId/messages       | Send a message                                 |
| PATCH  | /api/messages/conversations/:conversationId/read           | Mark all messages in it as read                |

### Socket.io events

Client connects with the JWT cookie already set (same-origin, `withCredentials: true`); the
server authenticates the handshake and joins the socket to a `user:<id>` room.

| Event               | Direction        | Payload                                      |
|----------------------|-------------------|-------------------------------------------------|
| `user:online` / `user:offline` | server → all      | `{ userId }`                                |
| `notification:new`  | server → recipient | a populated `Notification` document           |
| `message:new`        | server → recipient | `{ conversationId, message }`                 |
| `message:typing`     | client ↔ server    | client sends `{ conversationId, recipientId }`; server relays `{ conversationId, userId }` to the recipient |

Auth uses httpOnly cookies (see "Auth: access + refresh tokens" above), so the frontend must
call these with `credentials: "include"` (fetch) or `withCredentials: true` (Axios), and
`CLIENT_URL` in `.env` must match the frontend origin exactly for CORS + cookies to work.

## Status
All originally scoped backend modules are built and hardened: **auth (+ refresh tokens),
posts (+ likes/comments/edit), follow, notifications, direct messages, search, rate limiting
& injection protection.** This backend is feature-complete for the frontend build to start
against.

## Design notes
- `utils/notify.js` centralizes notification creation + real-time emit (skips self-notifications
  automatically) — reused for `like`, `comment`, `follow` events.
- `src/sockets/index.js` joins every connected socket to a `user:<id>` room on connect —
  any controller can emit directly to a specific user via `io.to(`user:${id}`).emit(...)`;
  the same room is used for `notification:new` and `message:new`.
- Refresh tokens are stored as SHA-256 hashes (`utils/hashToken.js`), never in plaintext, and
  rotated on every use — reusing an old (already-rotated) refresh token is rejected outright,
  which limits the blast radius of a leaked token to one request.
- Conversations are 1:1 only (`participants` array of exactly 2), looked up via
  `{ participants: { $all: [a, b], $size: 2 } }` so there's never more than one conversation
  per pair of users. Group chats would need a small schema change (drop the `$size: 2`, add
  a `name`/`isGroup` field).
- Follow/unfollow uses `$addToSet`/`$pull` on the existing `followers`/`following` arrays on
  `User` (atomic, avoids race conditions) rather than loading + mutating the array in JS.
- Posts store `likes` as a `User` ref array and `commentsCount` as a denormalized counter for
  fast feed rendering; comments live in their own collection (`Comment.model.js`), keyed by `post`.
- Search uses simple case-insensitive regex, fine at small-to-medium scale; a MongoDB Atlas
  Search index (or `$text` index) would be the next step if search volume/relevance matters.
- `app.set("trust proxy", 1)` is set for correct client IPs behind Render/Vercel-style proxies
  (needed for both `express-rate-limit` and `secure` cookies to behave correctly in production).
- Every list endpoint (`feed`, `comments`, `followers`, `notifications`, `conversations`,
  `messages`, `search`) follows the same `?page=&limit=` pagination shape, capped at 50 per page.
