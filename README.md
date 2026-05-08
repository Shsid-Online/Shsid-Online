# SHSID Social Platform

This repository now has two layers:

- `index.html` and `src/`: interactive PWA prototype for validating the product surface.
- `server/`: production-path Node API with real auth boundaries, session tokens, password hashing, moderation actions, audit logs, and JSON persistence for local development.

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

## Next Production Steps

1. Replace JSON persistence with PostgreSQL using `docs/database-schema.sql`.
2. Move media uploads to private object storage with virus scanning and signed URLs.
3. Connect real email OTP delivery.
4. Build React Native/Expo mobile client against the same `/api/*` contract.
5. Add automated tests and CI before beta.
