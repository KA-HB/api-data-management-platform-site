# API Data Management Platform

A lightweight internal API platform using Supabase for auth, database, storage, row level security, user management, and Edge Functions. The frontend is plain HTML, CSS, and JavaScript.

## What Is Included

- Supabase SQL migrations for profiles, roles, datasets, records, API keys, logs, QuickBooks Time settings, and sync logs.
- Row Level Security policies for admin and user access.
- Static frontend under `pages`, `css`, `js`, and `assets`.
- Edge Functions for REST dataset APIs, API key management, admin user management, QuickBooks Time OAuth/sync, and scheduled sync entrypoint.
- CSV and Excel imports with local parsing, batch insert, header signatures, and duplicate row hashing.
- AI-friendly JSON endpoints and API documentation page.

## Folder Structure

```text
.
+-- assets
+-- css
+-- docs
+-- js
+-- pages
+-- supabase
    +-- functions
    +-- migrations
```

## Setup

1. Create a Supabase project.
2. Install the Supabase CLI.
3. Copy `.env.example` to your deployment environment and fill in the values.
4. Run SQL migrations from `supabase/migrations` in order.
5. Deploy Edge Functions:

```bash
supabase functions deploy api
supabase functions deploy api-keys
supabase functions deploy user-admin
supabase functions deploy qbtime
supabase functions deploy scheduled-sync
```

6. Set Edge Function secrets:

```bash
supabase secrets set SUPABASE_URL=...
supabase secrets set SUPABASE_ANON_KEY=...
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
supabase secrets set QB_TIME_ENCRYPTION_KEY=...
supabase secrets set SCHEDULE_SECRET=...
```

7. Update `js/config.js` with your Supabase URL and anon key.
8. Host the static files on Netlify, Cloudflare Pages, Vercel static hosting, Supabase Storage, or any inexpensive static web host.

## First Admin

Create the first user in Supabase Auth, then promote that user:

```sql
update public.profiles
set role = 'admin'
where email = 'you@example.com';
```

## API Usage

Generate an API key from the API Keys page. The raw key is displayed once.

```http
GET /functions/v1/api/datasets
Authorization: Bearer DATA_PLATFORM_API_KEY
```

Available endpoints:

- `GET /functions/v1/api/datasets`
- `GET /functions/v1/api/datasets/{id}`
- `GET /functions/v1/api/datasets/{id}/records?page=1&page_size=50&search=term`

## QuickBooks Time

Configure Client ID, Client Secret, and Redirect URI from the admin QuickBooks Time page. The sync module creates or updates datasets for employees, timesheets, PTO, job codes, customers, groups, and custom fields.

For scheduled sync, create a Supabase scheduled function or external cron that calls `scheduled-sync` with `x-schedule-secret`.

## Security Notes

- API keys are stored as SHA-256 hashes only.
- RLS protects datasets, records, API keys, profiles, and logs.
- Admin-only actions are performed through authenticated Edge Functions using the service role internally.
- QuickBooks Time secrets are encoded in the sample implementation. For production, replace the helper with a managed KMS or Supabase Vault before storing real client secrets.
