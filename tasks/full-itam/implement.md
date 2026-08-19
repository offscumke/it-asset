# Full ITAM Implementation Plan

**Goal:** Deliver a production-usable, single-company internal ITAM on the existing Express, SQLite, and static frontend stack.

**Architecture:** Additive SQLite migrations and modular domain/security helpers behind the existing service entry point, with a multi-module management SPA.

**Tech Stack:** Node.js 24, Express 4, node:sqlite, bcryptjs, JWT, multer, vanilla HTML/CSS/JavaScript.

## Global Constraints

- Preserve existing data and Agent/QR/Ping/VNC behavior.
- Never write credentials or uploaded files to Git.
- Enforce permissions in API middleware, not only in the frontend.
- Record all business mutations in `audit_logs`.
- Run tests against temporary databases and upload directories.

## File Map

### Create

- `frontend/styles.css`
- `frontend/app.js`
- `server/test/itam.test.js`
- `tasks/full-itam/prd.md`
- `tasks/full-itam/design.md`
- `tasks/full-itam/implement.md`

### Modify

- `server/index.js`
- `server/package.json`
- `server/package-lock.json`
- `frontend/index.html`
- `frontend/scan.html`
- `frontend/qr.html`
- `docker-compose.yml`
- `Dockerfile`
- `.env.example`
- `.gitignore`
- `README.md`

### Verify And Extend Where Required

- `agent/agent.py`
- `server/test/smoke.test.js`
- `scripts/deploy.sh`
- `scripts/backup.sh`
- `scripts/import-db.sh`

## Task 1: Security And Core Schema

- [x] Add failing API checks for database users, role denial, audit rows, and legacy migration.
  - Run: `node --test server/test/itam.test.js`
  - Expected: non-zero with missing user and permission endpoints.
- [x] Implement additive schema, environment-admin bootstrap, JWT identity lookup, and permission middleware.
  - Run: `npm run check --prefix server && node --test server/test/itam.test.js`
  - Expected: syntax succeeds and security tests pass.

## Task 2: Asset Governance

- [x] Add failing checks for financial fields, lifecycle requests/approval, asset relationships, and protected attachments.
  - Run: `node --test server/test/itam.test.js`
  - Expected: non-zero on missing governance APIs.
- [x] Implement asset extensions, depreciation, transaction approval, relationships, upload/download/delete, and global audit logging.
  - Run: `npm test --prefix server`
  - Expected: all server tests pass with zero failures.

## Task 3: Work, Notifications, And Reminders

- [x] Add failing checks for work-order authorization, comments, state transitions, and generated notifications.
  - Run: `node --test server/test/itam.test.js`
  - Expected: non-zero on missing operations APIs.
- [x] Implement work orders, comments, notifications, read state, and idempotent reminder generation.
  - Run: `npm test --prefix server`
  - Expected: all server tests pass with zero failures.

## Task 4: Inventory Reconciliation And Integrations

- [x] Add failing checks for inventory snapshots, token-protected scans, differences/resolutions, and integration run history.
  - Run: `node --test server/test/itam.test.js`
  - Expected: non-zero on missing reconciliation and integration APIs.
- [x] Implement scoped inventory snapshots, secure scan tokens, discrepancy resolution/finalization, integration configuration, and sync evidence.
  - Run: `npm test --prefix server`
  - Expected: all server tests pass with zero failures.

## Task 5: Management Experience And Reports

- [x] Replace the two-tab page with role-aware dashboard, assets, lifecycle, inventory, work orders, notifications, reports/audit, users, and integrations modules.
  - Run: `npm run check --prefix server`
  - Expected: server and frontend JavaScript syntax checks pass.
- [x] Extend CSV exports and deployment configuration for attachments and reminder settings.
  - Run: `docker compose --env-file .env.example config --quiet`
  - Expected: exit code 0.
- [x] Verify desktop and mobile workflows in a real browser against the migrated local database and use temporary databases for API tests.
  - Run: Playwright smoke workflow at 1440x900 and 390x844.
  - Expected: login, role-aware navigation, lifecycle approval, inventory reconciliation, work order, audit, and no overlap/console errors.

## Task 6: Final Verification And Delivery

- [x] Run the complete current-state quality gate.
  - Run: `npm run check --prefix server && npm test --prefix server && npm audit --omit=dev --prefix server && python3 -m py_compile agent/agent.py && bash -n scripts/deploy.sh scripts/backup.sh scripts/import-db.sh && docker compose --env-file .env.example config --quiet && git diff --check`
  - Expected: exit code 0 and zero test failures.
- [x] Restart the local service on port 3001 and verify `/api/health` and `/` return success.
  - Expected: health JSON is `{"status":"ok"}` and homepage is HTTP 200.
