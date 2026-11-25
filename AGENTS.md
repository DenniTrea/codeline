# CodeLine working rules

- The migrated PostgreSQL schema is the source of truth. Inspect it with
  `npm run db:inspect -w backend`; do not recreate it or rerun migrations.
  Tables/columns use quoted camelCase. Preserve existing user data.
- Use validated Microsoft oid for users.id. Never add fake-login endpoints,
  invented runtime identities, first-user promotion, or a client-side role bypass.
- Backend authorization uses createApp.currentUser, including the restricted
  development preview. Recheck database roles and ownership for mutations.
  Local role testing requires explicit development opt-in and is disabled in prod.
- Keep .env, private keys, session files, credential exports and build output out
  of Git/releases. Do not print credential values. The connected DB is real.
- Follow the supplied Figma screens; inspect the relevant frame before changing
  a page. Functional starter layouts are not design completion. Use existing
  bundled fonts/colors. Preserve working admin/course flows when matching pages.
- No Docker. Prepare one Ubuntu VM with Nginx, Express on loopback 3002 in deployment (3001 locally) and the
  existing PostgreSQL 16. Ports 3000 and 3001 belong to separate private PostgREST on the VM.
- Scores start at 100, wrong attempts lose the exercise penalty, floor at 0.
  Unsolved and absent students finish with 0 (confirmed 25 November 2026).
  Keep hidden line positions off student responses. Rejoining preserves assignment.
- Do not add submissionAttempts/semester/section tables without a product decision.
  Saved scores/assignments are durable; detailed attempt activity and cosmetic
  waiting-room presence are temporary. Label that retention accurately in UI.
- Run type checks, relevant tests and the build. Use TEST_DATABASE=1 for the
  transaction-isolated integration suite. Do not claim skipped tests passed.
  Verify the real browser flow after API tests, including Socket.IO connectivity.
- The user authorized Azure deployment on 25 November. Follow deployment/DEPLOYMENT.txt;
  preserve the existing database and PostgREST, and verify public HTTPS/sign-in
  before calling the demo ready. Never print client secrets.
- The user requested merging progress/codeline-app into main on 25 November.
  Continue from main after that merge. No force-pushes to main.
  Commit/push only when requested. Do not send screenshots in final replies unless
  requested; use them internally to verify the UI.
