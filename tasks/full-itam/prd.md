# Full ITAM Product Requirements

## Goal

Upgrade the current asset register into a single-company internal IT asset management system that supports accountable ownership, controlled lifecycle changes, complete audit evidence, inventory reconciliation, operations work, reminders, costs, and configurable external integration adapters.

## Users And Roles

- `admin`: full system access, user management, integrations, audit, and all operational actions.
- `asset_manager`: manage assets, lifecycle requests, inventory, attachments, work orders, reports, and notifications.
- `auditor`: read assets, lifecycle history, inventory, reports, and global audit logs without mutation access.
- `employee`: view assigned assets, submit lifecycle/service requests, follow own work orders, and read own notifications.

## Functional Requirements

1. Asset master data includes unique identity, serial and asset tags, type, vendor/model, assignment, location, lifecycle state, purchase/warranty/cost/depreciation data, relationships, and attachments.
2. Lifecycle actions cover purchase, stock-in, assignment, return, loan, loan return, repair, repair completion, transfer, retirement, recycling, disable, and enable.
3. Lifecycle actions are durable requests with pending, approved, rejected, completed, or cancelled status. Approval applies the asset state change atomically.
4. All security-sensitive and business mutations are written to a global audit log with actor, action, entity, summary, metadata, IP, and timestamp.
5. Attachments support assets and work orders, enforce type/size limits, require authorization to download, and are deleted with their metadata.
6. Inventory sessions snapshot their expected asset scope, accept token-protected mobile scans, calculate missing/location/owner/unexpected differences, and require explicit reconciliation before final close.
7. Work orders support requests, incidents, and repair tasks with priority, assignment, status, comments, due dates, and linked assets.
8. Notifications are stored in-app and generated for approvals, work-order assignment/status, warranty expiry, overdue loans, and overdue work orders.
9. Reports include asset register, inventory differences, lifecycle ledger, costs/book values, work orders, and audit logs.
10. Integrations support AD, MDM, SNMP, AWS, Azure, GCP, and generic webhook/manual adapters through configuration records and sync-run history. Provider access is not claimed until credentials and a real environment are supplied.
11. Existing Agent check-in, Ping, QR asset detail, VNC links, CSV import, and current asset data remain compatible.

## Acceptance Criteria

- Existing databases migrate additively and retain current assets, software, inventory, and asset events.
- The environment admin can log in after migration and create additional users.
- API authorization rejects forbidden actions for auditor and employee roles.
- A lifecycle request can be created, approved, and observed on the asset and both audit timelines.
- An attachment can be uploaded, downloaded by an authorized user, and deleted.
- An inventory session exposes accurate snapshot counts and resolvable discrepancies.
- A work order can move from open to closed with comments and notifications.
- Dashboard and CSV reports expose lifecycle, warranty, and financial information.
- Integration configuration and sync-run status are visible without storing secrets in shared repository files.
- Automated server tests and browser workflow checks pass on a fresh temporary database.

## Out Of Scope

- Live provider-specific AD/MDM/SNMP/cloud synchronization without a target environment and credentials.
- Payroll, procurement payment, accounting journal entries, or tax calculations.
- Multi-company tenancy and external customer access.
- Email/SMS delivery infrastructure; notifications are in-app for this version.
