export const SUPABASE_URL = "https://wtygvjmlhquzpunewpqb.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_ADLkfJjZJwW4fnbzKNDjng_EugXwZBD";
export const FUNCTIONS_BASE_URL = `${SUPABASE_URL}/functions/v1`;

export function assertConfigured() {
  return !SUPABASE_URL.includes("your-project") && !SUPABASE_ANON_KEY.includes("your_public");
}
