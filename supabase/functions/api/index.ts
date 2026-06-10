import { corsHeaders, jsonResponse, readBearer } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";

type ApiIdentity = { user_id: string; role: "admin" | "user" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const apiKey = readBearer(req);
  if (!apiKey) return jsonResponse({ error: "Missing Authorization bearer token" }, 401);

  const supabase = serviceClient();
  const { data: identityRows, error: verifyError } = await supabase.rpc("verify_api_key", { raw_key: apiKey });
  if (verifyError) return jsonResponse({ error: "API key validation failed" }, 500);
  const identity = identityRows?.[0] as ApiIdentity | undefined;
  if (!identity) return jsonResponse({ error: "Invalid or revoked API key" }, 401);

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const page = Math.max(parseInt(url.searchParams.get("page") || "1", 10), 1);
  const pageSize = Math.min(Math.max(parseInt(url.searchParams.get("page_size") || "50", 10), 1), 500);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  try {
    if (req.method !== "GET") return jsonResponse({ error: "Only GET is supported by the public data API" }, 405);

    if (parts.length === 0 || parts[0] !== "datasets") {
      return jsonResponse({
        service: "API Data Management Platform",
        endpoints: ["/api/datasets", "/api/datasets/{id}", "/api/datasets/{id}/records"],
      });
    }

    if (parts.length === 1) {
      let query = supabase.from("datasets").select("id,name,description,source_type,record_count,created_at,updated_at", { count: "exact" });
      if (identity.role !== "admin") {
        const { data: perms } = await supabase.from("dataset_permissions").select("dataset_id").eq("user_id", identity.user_id);
        const ids = (perms || []).map((p) => p.dataset_id);
        if (!ids.length) return jsonResponse({ data: [], meta: { page, page_size: pageSize, total: 0 } });
        query = query.in("id", ids);
      }
      const search = url.searchParams.get("search");
      if (search) query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
      const { data, count, error } = await query.order("created_at", { ascending: false }).range(from, to);
      if (error) throw error;
      return jsonResponse({ data, meta: { page, page_size: pageSize, total: count } });
    }

    const datasetId = parts[1];
    const allowed = identity.role === "admin" || await hasDatasetPermission(supabase, identity.user_id, datasetId);
    if (!allowed) return jsonResponse({ error: "Dataset not found or not authorized" }, 404);

    if (parts.length === 2) {
      const { data, error } = await supabase.from("datasets").select("*").eq("id", datasetId).single();
      if (error) throw error;
      return jsonResponse({ data, schema: await inferSchemaSample(data?.id, supabase) });
    }

    if (parts.length === 3 && parts[2] === "records") {
      const search = url.searchParams.get("search");
      const { data, error } = await supabase.rpc("search_dataset_records", {
        dataset_uuid: datasetId,
        search_term: search || "",
        limit_count: pageSize,
        offset_count: from,
      });
      if (error) throw error;
      return jsonResponse({ data, meta: { page, page_size: pageSize } });
    }

    return jsonResponse({ error: "Unknown endpoint" }, 404);
  } catch (error) {
    return jsonResponse({ error: error.message || "Unhandled API error" }, 500);
  }
});

async function hasDatasetPermission(supabase: ReturnType<typeof serviceClient>, userId: string, datasetId: string): Promise<boolean> {
  const { data } = await supabase.from("dataset_permissions").select("id").eq("user_id", userId).eq("dataset_id", datasetId).maybeSingle();
  return Boolean(data);
}

async function inferSchemaSample(datasetId: string, supabase: ReturnType<typeof serviceClient>) {
  const { data } = await supabase.from("records").select("json_data").eq("dataset_id", datasetId).limit(25);
  const keys = new Map<string, string>();
  for (const row of data || []) {
    for (const [key, value] of Object.entries(row.json_data || {})) {
      if (!keys.has(key)) keys.set(key, Array.isArray(value) ? "array" : value === null ? "null" : typeof value);
    }
  }
  return Object.fromEntries(keys);
}
