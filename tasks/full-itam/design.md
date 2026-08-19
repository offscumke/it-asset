# Full ITAM Design

## Architecture

Keep the deployment as one Node.js service with SQLite and static frontend assets. To preserve the existing executable and reduce migration risk, schema, security, audit, and domain helpers remain in focused sections of `server/index.js`.

- `server/index.js`: additive schema migration, authentication and role permissions, audit and domain helpers, HTTP routes, Agent/Ping behavior, file handling, and process lifecycle.
- `frontend/index.html`, `frontend/styles.css`, `frontend/app.js`: authenticated management shell and operational modules.

## Data Model

- `users`: local identities, role, department, active state, password hash, login timestamps.
- `assets`: existing columns plus owner user, purchase, warranty, supplier, useful life, residual value, retirement, and update timestamps.
- `asset_events`: asset-local history retained for quick detail display.
- `audit_logs`: system-wide immutable mutation evidence.
- `asset_transactions`: approval-backed lifecycle and assignment ledger.
- `attachments`: protected file metadata for assets and work orders.
- `work_orders`, `work_order_comments`: operations workflow and discussion.
- `notifications`: per-user in-app notices with deduplication keys.
- `inventory_expected`: immutable scope snapshot per inventory session.
- `inventory_records`: actual scan data and calculated difference type.
- `inventory_resolutions`: explicit reconciliation decisions.
- `asset_relations`: directional physical/logical asset relationships.
- `integrations`, `integration_runs`: adapter configuration and execution evidence.

## Security

- Bootstrap the environment admin only when it does not exist; subsequent authentication reads the database user.
- JWT includes user id, username, display name, and role, and active user state is rechecked on each authenticated request.
- Role permissions are enforced server-side; the frontend only mirrors them for ergonomics.
- Employee asset reads are scoped to `owner_user_id` or matching legacy owner name.
- Upload names are generated server-side, paths never use user input, downloads require authorization, and upload size/type is limited.
- Mobile inventory links use a random session scan token instead of anonymous write access.
- Connector secrets are represented by `secret_ref`; plaintext provider secrets are not returned by APIs or committed.

## Compatibility And Migration

- Use `CREATE TABLE IF NOT EXISTS` and `PRAGMA table_info` additive migrations.
- Map legacy `spare` lifecycle state to `in_stock` while accepting `spare` as an API alias.
- Snapshot all current assets when creating a new inventory session; historical sessions continue to derive expected assets when no snapshot exists.
- Existing public QR asset pages remain read-only.

## Rollback

- Before production upgrade, use `scripts/backup.sh` or copy a SQLite backup while the service is stopped.
- Code rollback is safe before new writes. Database rollback after new ITAM writes requires restoring the pre-upgrade backup because additive tables are not automatically removed.
- Uploaded files are stored outside the database; restore the attachment directory with the matching database backup.

## Stop Conditions

- Stop migration if an existing table has an incompatible column type or a required uniqueness constraint cannot be created without data loss.
- Stop live integration setup when target credentials, network reachability, or provider schema are unavailable; record the adapter as configuration-required.
