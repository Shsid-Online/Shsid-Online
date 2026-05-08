# SHSID Social Platform Launch Plan

## Product Stages

1. Prototype validation, 1-2 weeks
   - Use the current PWA prototype to test navigation, student flows, admin moderation, reports, verification, and messaging expectations.
   - Collect policy feedback from school leadership before storing real student data.

2. Production web MVP, 8-12 weeks
   - Frontend: Next.js or React Native Web.
   - Backend: Node.js/NestJS or Django with PostgreSQL.
   - Storage: S3-compatible private media buckets with virus scanning and signed URLs.
   - Real time: WebSocket gateway for messaging, typing, presence, notifications, and admin safety events.
   - Auth: SHSID email OTP, bcrypt/argon2id password hashing, session rotation, rate limiting, device/session management.
   - Moderation: admin queues, audit logs, anonymous author reveal for admins, content retention, report SLA tracking.

3. Closed school beta, 2-4 weeks
   - Start with one grade or selected classes.
   - Require parent/school consent if the user population includes minors.
   - Test verification review load, report volume, upload abuse cases, and emergency removal procedures.

4. Full web launch, 1 week
   - Deploy behind a school-approved domain.
   - Enable backups, monitoring, incident alerts, WAF rules, and admin on-call process.
   - Publish student community rules before opening registration.

5. Mobile launch, 6-10 weeks after web MVP
   - Recommended path: React Native/Expo using the same API.
   - Alternative path: wrap the PWA with Capacitor for faster first release, then replace high-use areas with native screens.
   - Implement push notifications through APNs and Firebase Cloud Messaging.

## Website Release Checklist

- Buy or assign production domain, for example `social.shsid.org`.
- Host frontend on Vercel, Netlify, Cloudflare Pages, or school infrastructure.
- Host backend on AWS, Azure, GCP, Fly.io, Render, or a managed school server.
- Use managed PostgreSQL with daily backups and point-in-time recovery.
- Configure private object storage for videos/photos.
- Add CDN with signed media URLs.
- Add observability: uptime checks, error tracking, structured logs, audit log export.
- Create admin roles: super admin, verifier, moderator, auditor.
- Create legal pages: terms, privacy policy, community guidelines, data deletion request process.
- Complete security review: OWASP ASVS basics, password policy, rate limits, file scanning, SSRF protections, XSS/CSRF protections.

## App Store Plan

### Apple App Store

- Enroll in the Apple Developer Program.
- Create bundle id, app record, certificates, and provisioning profiles.
- Add Sign in policy review notes explaining school-only access and manual verification.
- Provide a demo admin/student account for App Review.
- Complete App Privacy labels accurately, including identifiers, user content, contact info, diagnostics, and moderation/audit data.
- If users are minors, review Apple's child safety and privacy requirements carefully before submission.
- Submit TestFlight beta first, then production review.

### Google Play

- Create Google Play Developer account.
- Configure package name, signing key, data safety form, content rating, and target audience.
- If minors can use the app, complete Families/target audience declarations accurately.
- Provide reviewer credentials and school-only access explanation.
- Launch as internal testing, then closed testing, then production.

## Critical Policy Decisions Before Real Launch

- Minimum age and whether parental consent is required.
- Who can access admin tools and anonymous author reveal.
- Retention period for deleted posts, messages, videos, stories, and audit logs.
- Emergency escalation process for self-harm, threats, bullying, or illegal content.
- Whether admins can monitor all DMs proactively or only after reports.
- Data export/deletion process for students who graduate or leave SHSID.
- School disciplinary policy connection: what actions lead to warnings, bans, parent contact, or school intervention.
