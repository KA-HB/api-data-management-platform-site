import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const userSupabase = userClient(req);
  const service = serviceClient();
  const { data: auth } = await userSupabase.auth.getUser();
  if (!auth.user) return jsonResponse({ error: "Authentication required" }, 401);

  const { data: adminProfile } = await userSupabase.from("profiles").select("role").eq("id", auth.user.id).single();
  if (adminProfile?.role !== "admin") return jsonResponse({ error: "Admin role required" }, 403);

  const body = await req.json().catch(() => ({}));

  if (req.method === "POST") {
    const password = body.password || crypto.randomUUID();
    const { data, error } = await service.auth.admin.createUser({
      email: body.email,
      password,
      email_confirm: true,
      user_metadata: { created_by_admin: auth.user.id },
    });
    if (error) return jsonResponse({ error: error.message }, 400);
    await service.from("profiles").upsert({ id: data.user.id, email: body.email, role: body.role || "user", active: true });
    await userSupabase.rpc("log_activity", { action_name: "user.created", details_json: { user_id: data.user.id, email: body.email } });
    return jsonResponse({ data: { id: data.user.id, email: body.email, temporary_password: password } }, 201);
  }

  if (req.method === "PATCH") {
    if (!body.id) return jsonResponse({ error: "Missing user id" }, 400);
    const updates: Record<string, unknown> = {};
    if (typeof body.active === "boolean") {
      updates.active = body.active;
      await service.auth.admin.updateUserById(body.id, { ban_duration: body.active ? "none" : "876000h" });
    }
    if (body.role) updates.role = body.role;
    const { error } = await service.from("profiles").update(updates).eq("id", body.id);
    if (error) return jsonResponse({ error: error.message }, 400);
    await userSupabase.rpc("log_activity", { action_name: "user.updated", details_json: { user_id: body.id, updates } });
    return jsonResponse({ ok: true });
  }

  if (req.method === "PUT") {
    if (!body.email) return jsonResponse({ error: "Missing email" }, 400);
    const { error } = await service.auth.resetPasswordForEmail(body.email);
    if (error) return jsonResponse({ error: error.message }, 400);
    await userSupabase.rpc("log_activity", { action_name: "user.password_reset", details_json: { email: body.email } });
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
});
