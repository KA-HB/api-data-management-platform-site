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
    if (body.action === "grant_qbtime_access") {
      const result = await grantSharedQbtimeAccess(service);
      await userSupabase.rpc("log_activity", { action_name: "user.qbtime_access_granted", details_json: result });
      return jsonResponse({ data: result });
    }

    const password = body.password || crypto.randomUUID();
    const { data, error } = await service.auth.admin.createUser({
      email: body.email,
      password,
      email_confirm: true,
      user_metadata: { created_by_admin: auth.user.id },
    });
    if (error) return jsonResponse({ error: error.message }, 400);
    await service.from("profiles").upsert({ id: data.user.id, email: body.email, role: body.role || "user", active: true });
    await grantSharedQbtimeAccess(service, data.user.id);
    await userSupabase.rpc("log_activity", { action_name: "user.created", details_json: { user_id: data.user.id, email: body.email } });
    return jsonResponse({ data: { id: data.user.id, email: body.email, temporary_password: password } }, 201);
  }

  if (req.method === "PATCH") {
    if (!body.id) return jsonResponse({ error: "Missing user id" }, 400);
    const updates: Record<string, unknown> = {};
    let passwordUpdated = false;
    if (typeof body.active === "boolean") {
      updates.active = body.active;
      await service.auth.admin.updateUserById(body.id, { ban_duration: body.active ? "none" : "876000h" });
    }
    if (body.role) updates.role = body.role;
    if (typeof body.password === "string" && body.password.length) {
      if (body.password.length < 8) return jsonResponse({ error: "Password must be at least 8 characters." }, 400);
      const { error } = await service.auth.admin.updateUserById(body.id, { password: body.password });
      if (error) return jsonResponse({ error: error.message }, 400);
      passwordUpdated = true;
    }
    if (Object.keys(updates).length) {
      const { error } = await service.from("profiles").update(updates).eq("id", body.id);
      if (error) return jsonResponse({ error: error.message }, 400);
      if (updates.active === true) await grantSharedQbtimeAccess(service, body.id);
      await userSupabase.rpc("log_activity", { action_name: "user.updated", details_json: { user_id: body.id, updates } });
    }
    if (passwordUpdated) {
      await userSupabase.rpc("log_activity", { action_name: "user.password_updated", details_json: { user_id: body.id } });
    }
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

async function grantSharedQbtimeAccess(service: ReturnType<typeof serviceClient>, userId?: string) {
  const { data: datasets, error: datasetError } = await service
    .from("datasets")
    .select("id,name,source_type")
    .neq("name", "QuickBooks Time PTO");
  if (datasetError) throw datasetError;

  const sharedDatasets = (datasets || []).filter((dataset) =>
    dataset.source_type === "quickbooks_time" || String(dataset.name || "").startsWith("QuickBooks Time ")
  );
  if (!sharedDatasets.length) return { users: 0, datasets: 0, permissions_created: 0 };

  const userQuery = service
    .from("profiles")
    .select("id")
    .eq("active", true);
  const { data: users, error: userError } = userId ? await userQuery.eq("id", userId) : await userQuery;
  if (userError) throw userError;

  const permissions = (users || []).flatMap((user) =>
    sharedDatasets.map((dataset) => ({
      dataset_id: dataset.id,
      user_id: user.id,
      can_export: true,
    }))
  );
  if (!permissions.length) return { users: users?.length || 0, datasets: sharedDatasets.length, permissions_created: 0 };

  const { error: permissionError } = await service
    .from("dataset_permissions")
    .upsert(permissions, { onConflict: "dataset_id,user_id", ignoreDuplicates: false });
  if (permissionError) throw permissionError;

  return {
    users: users?.length || 0,
    datasets: sharedDatasets.length,
    permissions_created: permissions.length,
  };
}
