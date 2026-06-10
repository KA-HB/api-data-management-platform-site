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
