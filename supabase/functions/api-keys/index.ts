import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { randomApiKey, safeKeyPrefix, sha256 } from "../_shared/crypto.ts";
import { userClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const supabase = userClient(req);
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return jsonResponse({ error: "Authentication required" }, 401);

  if (req.method === "GET") {
    const { data, error } = await supabase.from("api_keys").select("id,key_name,prefix,revoked,last_used_at,created_at").order("created_at", { ascending: false });
    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ data });
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const rawKey = randomApiKey();
    const keyHash = await sha256(rawKey);
    const { data, error } = await supabase.from("api_keys").insert({
      user_id: auth.user.id,
      key_name: body.key_name || "Default key",
      key_hash: keyHash,
      prefix: safeKeyPrefix(rawKey),
    }).select("id,key_name,prefix,created_at").single();
    if (error) return jsonResponse({ error: error.message }, 400);
    await supabase.rpc("log_activity", { action_name: "api_key.created", details_json: { id: data.id, key_name: data.key_name } });
    return jsonResponse({ data: { ...data, raw_key: rawKey } }, 201);
  }

  if (req.method === "PATCH") {
    const body = await req.json().catch(() => ({}));
    if (!body.id) return jsonResponse({ error: "Missing key id" }, 400);
    const { error } = await supabase.from("api_keys").update({ revoked: true }).eq("id", body.id);
    if (error) return jsonResponse({ error: error.message }, 400);
    await supabase.rpc("log_activity", { action_name: "api_key.revoked", details_json: { id: body.id } });
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
});
