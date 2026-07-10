# Deployment

## Static Frontend

This project has no frontend build step. Host these files as static assets:

- `index.html`
- `pages`
- `css`
- `js`
- `assets`

Any static host works. Keep `js/config.js` accurate for the deployed Supabase project.

## Supabase Backend

Deploy migrations and functions with the Supabase CLI. Edge Functions are written for Deno and use Supabase's official JavaScript client from ESM.

## Local Testing

You can serve the frontend locally:

```bash
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

Static module imports require an HTTP server; opening the files directly may fail in some browsers.

## SSO Session Timeout

The frontend enforces an 8-hour absolute Microsoft SSO session limit and a 60-minute idle timeout. When either limit is reached, the app signs out of Supabase, clears its local session marker, returns the user to the login page, and uses `prompt=login` on the next Microsoft OAuth request.

For stronger enforcement, also configure Supabase Auth JWT/session lifetime and Microsoft Entra Conditional Access sign-in frequency. The frontend timeout prevents the app from treating a refreshed browser session as permanent, but Microsoft controls whether the user must enter a password, complete MFA, or can satisfy SSO from an existing tenant session.
