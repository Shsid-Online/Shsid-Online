# SHSID Social Platform

This repository now has two layers:

- `public/`: interactive PWA prototype for validating the product surface.
- `server/`: production-path Node API with real auth boundaries, session tokens, password hashing, moderation actions, audit logs, and JSON persistence for local development.
- `worker/`: Cloudflare Worker API for production edge deploys with R2 uploads.

## Run

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:4174/
```

## Initial Admin

The local seed creates one admin account. Override it with:

```bash
INITIAL_ADMIN_EMAIL="admin@example.com" INITIAL_ADMIN_PASSWORD="change-this" npm run dev
```

## Email Verification

Set SMTP env vars to send real verification emails:

```bash
SMTP_HOST="smtp.example.com" \
SMTP_PORT=587 \
SMTP_STARTTLS=true \
SMTP_USER="no-reply@example.com" \
SMTP_PASS="app-password" \
SMTP_FROM="no-reply@example.com" \
EMAIL_TRANSPORT=smtp \
npm run dev
```

For local testing without a mail server, keep `EMAIL_TRANSPORT=log` or leave SMTP vars unset. The server will return a dev OTP instead of sending mail.

## API Smoke Test

```bash
curl -s http://127.0.0.1:4174/api/health
```

Login:

```bash
curl -s -X POST http://127.0.0.1:4174/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"YOUR_ADMIN_EMAIL","password":"YOUR_ADMIN_PASSWORD"}'
```

Use the returned token:

```bash
curl -s http://127.0.0.1:4174/api/me \
  -H 'authorization: Bearer YOUR_TOKEN'
```

## Cloudflare Deployment (Pages + Worker + R2)

Frontend (Pages):

- Build command: empty
- Output directory: `public`
- Do not use `npx wrangler deploy` as the Pages deploy command.

Worker API:

```bash
npm run cf:deploy
```

Then set Worker secrets and bindings:

```bash
wrangler secret put UPLOAD_SIGNING_SECRET
```

`wrangler.toml` already binds:

- Worker name: `shsid-online-api`
- R2 binding: `R2_BUCKET`
- Bucket name: `shsid-media`

Routes exposed by Worker:

- `GET /health`
- `POST /upload-url` (returns short-lived signed upload URL)
- `PUT /upload/:key?exp=...&token=...`
- `GET /files?prefix=uploads/`

## Next Production Steps

1. Replace JSON persistence with PostgreSQL using `docs/database-schema.sql`.
2. Move media uploads to private object storage with virus scanning and signed URLs.
3. Connect real email OTP delivery.
4. Build React Native/Expo mobile client against the same `/api/*` contract.
5. Add automated tests and CI before beta.
