# Optimization Notes

Implemented backend optimizations:

- Session lookup now uses top-level session records and SHA-256 token digests instead of scanning every user's password-style session hashes.
- Legacy local sessions are migrated on load.
- Store now maintains in-memory indexes for users by id, users by email, and active sessions by token digest.
- JSON persistence uses atomic temp-file writes before rename.
- Expired sessions are pruned when new sessions are created.
- List endpoints are paginated.
- Student-facing serializers hide other students' emails and verification video references.
- Common HTTP security headers are applied to API and static responses.
- CORS preflight is supported for future mobile clients.
- Smoke tests now verify API health, login, admin queues, posts, and student directory email privacy.

Next optimizations before beta:

- Replace JSON persistence with PostgreSQL and indexed tables.
- Add request-level rate limiting for login, OTP, posting, comments, and reports.
- Add cursor pagination for feeds and messages.
- Add background queues for media scanning, email delivery, and push notification fanout.
- Add WebSocket presence with bounded room membership and heartbeat cleanup.
- Add structured logs with request ids and moderation/audit correlation ids.
- Add load tests for feed read, message send, and verification queue review.
