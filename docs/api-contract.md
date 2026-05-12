# API Contract

Base URL for local development:

```text
http://127.0.0.1:4174/api
```

Authentication uses:

```text
Authorization: Bearer <session token>
```

List endpoints accept:

```text
?limit=25&offset=0
```

Responses include `pagination.limit`, `pagination.offset`, `pagination.total`, and `pagination.nextOffset`.

User objects are privacy-filtered by viewer:

- Self and admins can see account fields such as email.
- Students cannot see other students' email addresses or verification video references.

## Auth

- `POST /auth/start`
  - Body: `{ "email": "student@example.com" }`
  - Sends a verification email in production when SMTP settings are configured. Local development falls back to `devCode` if `EMAIL_TRANSPORT=log` or no SMTP host is set.

- `POST /auth/register`
  - Body: `{ "email": "student@example.com", "code": "123456", "password": "strongpass" }`
  - Creates the official account before profile completion.

- `POST /auth/login`
  - Body: `{ "email": "YOUR_ADMIN_EMAIL", "password": "YOUR_ADMIN_PASSWORD" }`
  - Returns `{ user, session: { token, expiresAt } }`.

- `POST /auth/logout`
  - Auth required.
  - Revokes the current bearer session server-side.

- `POST /auth/complete-profile`
  - Auth required.
  - Body: `{ "englishName": "...", "chineseName": "...", "grade": 12, "classNo": 3, "verificationVideo": "object-key.mp4" }`
  - Enforces one account per real name.

- `GET /me`
  - Auth required.

## Social

- `GET /students`
- `GET /posts`
- `POST /posts`
  - Body: `{ "text": "...", "anonymous": false, "category": "school", "media": ["Photo"] }` — `media` is optional (prototype stores labels, not binary).
- `PATCH /posts/:id` (admin)
  - Body: `{ "sticky": true }`
- `DELETE /posts/:id` (admin)
  - Soft-deletes the post (`deletedAt` set).
- `POST /posts/:id/like`
- `POST /posts/:id/heart`
- `POST /posts/:id/save`
- `POST /posts/:id/comments`
  - Body: `{ "text": "...", "anonymous": false, "replyTo": "optional-comment-id" }`
- `POST /reports`
  - Body: `{ "targetType": "post", "targetId": "<id>", "reason": "..." }`

## Stories & reels

- `GET /stories`
- `POST /stories`
  - Body: `{ "text": "..." }` — stories expire after 24 hours server-side.
- `POST /stories/:id/view`
- `GET /reels`
- `POST /reels`
  - Body: `{ "title": "...", "category": "school", "videoUrl": "optional-or-pending-upload" }`
- `POST /reels/:id/like`

## Profiles & community

- `POST /users/:userId/follow`
  - Toggles follow; returns `{ user, following: string[] }` for the acting user.
- `GET /users/:userId/qna`
- `POST /users/:userId/qna`
  - Body: `{ "question": "...", "anonymous": false, "visibility": "public" | "private" }`

## Suggestions

- `GET /suggestions`
  - Lists the authenticated user’s submissions.
- `POST /suggestions`
  - Body: `{ "text": "..." }`
- `GET /admin/suggestions` (admin)
- `POST /admin/suggestions/:id` (admin)
  - Body: `{ "response": "..." }`

## Ads

- `GET /ads`
- `POST /admin/ads` (admin)
  - Body: `{ "slot": "top_banner|feed_inline|students_inline|popup", "title": "...", "body": "...", "url": "optional", "active": true }`
- `POST /admin/ads/:id/toggle` (admin)
- `DELETE /admin/ads/:id` (admin)

## Notifications

- `GET /notifications`
- `POST /notifications/read-all`

## Messaging

- `GET /conversations`
- `POST /conversations`
  - Body: `{ "memberIds": ["usr_..."], "group": false, "title": "optional" }` — the caller is always included in `members`.
- `GET /conversations/:id/messages`
- `POST /conversations/:id/messages`
  - Body: `{ "text": "...", "anonymous": false }`

## Admin

Admin role required.

- `GET /admin/verifications`
- `POST /admin/verifications/:userId`
  - Body: `{ "decision": "approve" }` or `{ "decision": "reject" }`
- `GET /admin/reports`
- `POST /admin/reports/:reportId`
  - Body: `{ "status": "resolved", "adminNotes": "optional" }`
- `GET /admin/audit-logs`

## Production Gaps Remaining

- Multipart media uploads (binary) end-to-end; prototype uses labels / separate Worker upload flow for objects.
- WebSocket events for messaging, typing, presence, and notifications
- PostgreSQL persistence (see `docs/database-schema.sql`)
- Hosting the Node `/api/*` app beside Cloudflare Pages (or porting logic to Workers + D1)
- Push notification provider integration
- Automated test suite
