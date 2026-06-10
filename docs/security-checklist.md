# Security Checklist

Run these checks after every production deployment.

1. Open a private/incognito browser window and visit each dashboard URL while logged out. Every protected page must redirect to the login page.
2. While logged out, call Supabase protected tables from the browser console. `profiles`, `datasets`, `records`, `api_keys`, `activity_logs`, `qbtime_settings`, and `sync_logs` must return no protected data.
3. Log in as a regular user and verify admin pages redirect away or show permission denied.
4. Log in as a regular user and verify only authorized datasets and records are visible.
5. Search the public frontend files for `service_role`, `SUPABASE_SERVICE_ROLE_KEY`, QuickBooks Time client secrets, access tokens, refresh tokens, and live API keys. None should be present.
6. Confirm QuickBooks Time settings and tokens are accessed only through Edge Functions. Browser Supabase queries against `qbtime_settings` should not return rows.
7. Confirm API keys are generated server-side, shown once, stored only as hashes, and revoked server-side.
8. Call the public data API with no bearer token and with an invalid token. Both should return `401`.
9. Run a manual QuickBooks Time sync and verify `sync_logs` records success, partial success, or failure with timestamps.
10. Check Supabase advisors after schema or policy changes and remediate any security warnings.
