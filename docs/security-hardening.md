# Security hardening, 14 October 2026

## Fixed

- Worker request limits run before body parsing, sessions, or D1. Native per-IP limits are supplemented by one SQLite-backed Durable Object across regions: 180 dynamic requests/minute, 12,000/day UTC, 60 writes/minute and 20 content submissions/minute. Fixed persisted counters contain no IPs or account identifiers. Public upload reads bypass this database-protection budget. Failures fail closed.
- The exposed moderator account is quarantined: login/registration and existing sessions are denied in both backends. The scheduled migration clears its database password when D1 recovers. Administrator-assisted recovery is required before re-enabling it; this is revocation, not a completed replacement-password workflow.
- Feed queries no longer count all posts on every page; post-number allocation uses indexed equality lookups. Raw database reads coalesce for five seconds without sharing viewer permissions. Additive indexes install when D1 recovers.
- Anonymous board responses omit author IDs and admin-specific number fields for non-admin viewers. Reaction arrays retain counts and the viewer's own reaction, without exposing other users' IDs. Admin profile details are masked for other users.
- Board attachments hide supplied filenames and exclude outside tracking URLs and verification-video links. New upload keys use random names.
- Verification media requires admin authorization and is served with private/no-store headers. Consumers must supply the administrator's bearer authorization; unauthenticated direct video links intentionally no longer work.
- New SVG uploads are rejected. Existing active formats download with a sandbox policy and nosniff. Raster images and videos retain inline rendering.
- Worker passwords use salted PBKDF2-SHA256 at the runtime-supported 100,000 iterations. This is below OWASP's 600,000 SHA256 recommendation: moving to a stronger supported KDF or managed authentication remains advisable. Local passwords use scrypt N=32768, r=8, p=3.
- Legacy passwords upgrade on login; the Worker installs indexes then migrates one per scheduled tick when D1 is available. A durable completion marker stops repeated migration scans after completion. The local store upgrades on load. Conditional updates prevent overwriting concurrent password changes.
- Registration checks OTP attempts directly. The local server no longer trusts client-provided firebaseVerified flags. The production Worker cannot return/log development OTP codes.
- Stateless legacy Meta callbacks and connection entry points are rejected; the admin queue's cookie/state-protected connection remains available.

## Outstanding limitations

- The daily D1 quota is already exhausted. All three indexes were confirmed in production through sqlite_master on 14 October. The aggregate password-migration check still fails with the daily-read-limit error, so password migration and full feed/login behavior remain unverified pending recovery.
- A development database was tracked in Git with a readable credential. Removing tracking does not remove old commits. The affected board account is disabled, but rotate that credential wherever reused. No Git history rewrite has been performed: coordinate this with collaborators; existing clones/copies cannot be recalled.
- Global circuit breakers protect database access but are not a D1 row-budget guarantee: query cost varies, scheduled work is separate, and attackers can exhaust the shared budget and temporarily deny legitimate traffic. Challenge/WAF rules and monitoring remain advisable. The new object also has its own Cloudflare quotas.
- Old posts, screenshots, old upload filenames, downloaded verification files, image metadata, domain-registration records, Git history, and third-party account records may still disclose information. The changes cannot retract copies already obtained.
- Image metadata stripping is not implemented in this pass. Do not upload identifying originals until metadata is removed.
- This is a scoped hardening pass, not a guarantee of anonymity or an exhaustive penetration test. MFA, stronger authentication, distributed-abuse defenses and private-media signed playback remain further work.
