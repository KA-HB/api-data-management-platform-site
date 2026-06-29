export const SUPABASE_URL = "https://wtygvjmlhquzpunewpqb.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_ADLkfJjZJwW4fnbzKNDjng_EugXwZBD";

const USE_VERCEL_FUNCTION_PROXY = typeof location !== "undefined" && /(^|\.)vercel\.app$/i.test(location.hostname);
export const FUNCTIONS_BASE_URL = USE_VERCEL_FUNCTION_PROXY ? `${location.origin}/api` : `${SUPABASE_URL}/functions/v1`;

export function assertConfigured() {
  return !SUPABASE_URL.includes("your-project") && !SUPABASE_ANON_KEY.includes("your_public");
}
