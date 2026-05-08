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
- `POST /posts/:id/like`
- `POST /posts/:id/comments`
- `POST /reports`

## Messaging

- `GET /conversations`
- `POST /conversations/:id/messages`

## Admin

Admin role required.

- `GET /admin/verifications`
- `POST /admin/verifications/:userId`
  - Body: `{ "decision": "approve" }` or `{ "decision": "reject" }`
- `GET /admin/reports`
- `POST /admin/reports/:reportId`
- `GET /admin/audit-logs`

## Production Gaps Remaining

- Multipart media uploads
- WebSocket events for messaging, typing, presence, and notifications
- PostgreSQL persistence
- Push notification provider integration
- Automated test suite
