# Supabase Setup

## Authentication

Enable Microsoft Azure authentication in Supabase Auth and set the Azure application to the Hayat Brown tenant. Disable the Email provider in Supabase Auth so users cannot create password-based accounts.

Supabase Auth redirect allow-list URLs should include the hosted `pages/auth-callback.html` URL. The Azure OAuth request must include the `email` scope, because Supabase Auth requires Azure to return a valid email address. The app redirects authenticated users to the correct dashboard based on their `profiles.role`.

## Database

Run:

1. `supabase/migrations/001_schema.sql`
2. `supabase/migrations/002_storage.sql`

Confirm RLS is enabled on all public tables.

## Storage

The `imports` bucket is private and admin-only. The current frontend parses files in the browser before inserting records, but the bucket is ready for future server-side import processing.

## Edge Function Environment

Required:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `QB_TIME_ENCRYPTION_KEY`
- `SCHEDULE_SECRET`

Optional overrides:

- `QB_TIME_AUTH_URL`
- `QB_TIME_TOKEN_URL`
- `QB_TIME_API_URL`
- `QB_TIME_PAGE_SIZE` defaults to `200`
- `QB_TIME_MAX_PAGES` defaults to `250` so large timesheet syncs do not stop after the first 2,000 rows
- `QB_TIME_SYNC_START_DATE` in `YYYY-MM-DD` format for full historical backfills
- `QB_TIME_SYNC_END_DATE` in `YYYY-MM-DD` format for bounded backfills

## Recommended Production Hardening

- Replace sample QuickBooks secret encoding with Supabase Vault or external KMS encryption.
- Add domain-specific CORS allowlists in `_shared/cors.ts`.
- Move very large imports to a background Edge Function or queue.
- Add retention policies for activity and sync logs.
- Add dataset permission management UI if users should receive partial rather than admin-managed access.
