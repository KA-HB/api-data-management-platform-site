# Hayat Brown IT Service Desk

## Separate Vercel deployment

Import the existing `KA-HB/api-data-management-platform-site` GitHub repository as a **new Vercel project** named `hayatbrown-it-support`. Set **Root Directory** to `outputs/site`. Leave the existing Data Tools Vercel project and its root directory unchanged. Vercel should serve this static site from `index.html` with no build command.

## Microsoft sign-in

The portal reuses the existing Data Tools Supabase Azure OAuth provider. In Supabase Auth, add the new Vercel site's exact HTTPS origin to the redirect URL allow-list after Vercel assigns its domain. The existing `@hayatbrown.com` activation policy remains in force.

## Ticket storage and permissions

Tickets are stored in the shared Supabase database, not in browser storage. Apply `supabase/migrations/062_it_support.sql` in the Supabase SQL editor. The migration creates a separate IT support admin allow-list, ticket table, and row-level policies: employees read only their own tickets; IT support admins can read and update the queue. It does not grant Data Tools administrator privileges.

Add authorized administrators to `public.it_support_admins` from the private Supabase SQL editor after applying the migration. Do not put the administrator email list in this public repository.

