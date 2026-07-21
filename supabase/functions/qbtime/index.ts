import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";

type SyncResource = { endpoint: string; dataset: string; useDateRange?: boolean; optional?: boolean };
type DatasetRecord = { dataset_id: string; json_data: unknown; source_hash: string };

const RECORD_UPSERT_BATCH_SIZE = 100;
const MIN_RECORD_UPSERT_BATCH_SIZE = 25;

const resources: SyncResource[] = [
  { endpoint: "users", dataset: "Employees" },
  { endpoint: "timesheets", dataset: "Timesheets", useDateRange: true },
  { endpoint: "jobcodes", dataset: "Job Codes" },
  { endpoint: "clients", dataset: "Customers", optional: true },
  { endpoint: "groups", dataset: "Groups" },
  { endpoint: "customfields", dataset: "Custom Fields" },
];

Deno.serve(async (req) => {
  try {
    return await handleRequest(req);
  } catch (error) {
    const message = syncErrorMessage(error);
    console.error("QuickBooks Time function failed", message);
    return jsonResponse({ error: message || "QuickBooks Time request failed" }, 500);
  }
});

async function handleRequest(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "settings";
  const forceFullTimesheets = fullSyncRequested(url);
  const scheduleSecret = Deno.env.get("SCHEDULE_SECRET");
  if (req.method === "POST" && action === "sync" && scheduleSecret && req.headers.get("x-schedule-secret") === scheduleSecret) {
    return jsonResponse({ data: await runSync(serviceClient(), { forceFullTimesheets }) });
  }

  if (req.method === "GET" && action === "callback") {
    const code = url.searchParams.get("code");
    if (!code) return htmlResponse("QuickBooks Time connection failed: missing authorization code.", 400);

    try {
      const service = serviceClient();
      const { data: settings } = await service.from("qbtime_settings").select("*").order("created_at", { ascending: false }).limit(1).single();
      const token = await exchangeCode(settings, code);
      const { error } = await service.from("qbtime_settings").update({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        token_expires_at: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
        tenant_info: token.company || {},
      }).eq("id", settings.id);
      if (error) throw error;
      return htmlResponse("QuickBooks Time is connected. You can close this tab and return to the data platform.");
    } catch (error) {
      return htmlResponse(`QuickBooks Time connection failed: ${escapeHtml(error.message || "Unexpected error")}`, 500);
    }
  }

  const userSupabase = userClient(req);
  const { data: auth } = await userSupabase.auth.getUser();
  if (!auth.user) return jsonResponse({ error: "Authentication required" }, 401);

  const { data: profile } = await userSupabase.from("profiles").select("role,active").eq("id", auth.user.id).single();
  if (!profile?.active) return jsonResponse({ error: "Active user profile required" }, 403);
  const isAdmin = profile.role === "admin";
  const isManualSync = req.method === "POST" && action === "sync";
  if (!isAdmin && !isManualSync) return jsonResponse({ error: "Admin role required" }, 403);

  const service = serviceClient();

  if (req.method === "GET" && action === "authorize-url") {
    const { data: settings } = await service.from("qbtime_settings").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!settings) return jsonResponse({ error: "QuickBooks Time settings are not configured" }, 400);
    const authUrl = new URL(Deno.env.get("QB_TIME_AUTH_URL") || "https://rest.tsheets.com/api/v1/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", settings.client_id);
    authUrl.searchParams.set("redirect_uri", settings.redirect_uri);
    authUrl.searchParams.set("state", crypto.randomUUID());
    return jsonResponse({ data: { url: authUrl.toString() } });
  }

  if (req.method === "POST" && action === "settings") {
    const body = await req.json();
    const encryptedSecret = btoa(`${body.client_secret}:${Deno.env.get("QB_TIME_ENCRYPTION_KEY") || "local"}`);
    const { data: existing } = await service.from("qbtime_settings").select("id").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const values = {
      client_id: body.client_id,
      encrypted_secret: encryptedSecret,
      redirect_uri: body.redirect_uri,
    };
    const insertValues = {
      ...values,
      tenant_info: {},
    };
    const query = existing
      ? service.from("qbtime_settings").update(values).eq("id", existing.id)
      : service.from("qbtime_settings").insert(insertValues);
    const { data, error } = await query.select("id,client_id,redirect_uri,tenant_info,last_sync,created_at").single();
    if (error) return jsonResponse({ error: error.message }, 400);
    await userSupabase.rpc("log_activity", { action_name: "qbtime.settings_saved", details_json: { id: data.id } });
    return jsonResponse({ data }, 201);
  }

  if (req.method === "POST" && action === "callback") {
    const body = await req.json();
    const { data: settings } = await service.from("qbtime_settings").select("*").order("created_at", { ascending: false }).limit(1).single();
    const token = await exchangeCode(settings, body.code);
    const { error } = await service.from("qbtime_settings").update({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_expires_at: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
      tenant_info: token.company || {},
    }).eq("id", settings.id);
    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ ok: true });
  }

  if (req.method === "POST" && action === "sync") {
    const syncOptions = { forceFullTimesheets };
    const runningSync = await findRecentRunningSync(service);
    if (runningSync) {
      const queuedResult = {
        status: "running",
        queued: true,
        stats: { mode: forceFullTimesheets ? "full" : "incremental", started_at: runningSync.started_at },
        errors: [],
        warnings: [{ dataset: "Sync", message: "A QuickBooks Time sync is already running." }],
      };
      await logUserActivity(userSupabase, "qbtime.manual_sync_already_running", queuedResult);
      return jsonResponse({ data: queuedResult }, 202);
    }

    if (queueBackgroundSync(service, syncOptions)) {
      const queuedResult = {
        status: "running",
        queued: true,
        stats: { mode: forceFullTimesheets ? "full" : "incremental" },
        errors: [],
        warnings: [{ dataset: "Sync", message: "QuickBooks Time sync is running in the background." }],
      };
      await logUserActivity(userSupabase, "qbtime.manual_sync_started", queuedResult);
      return jsonResponse({ data: queuedResult }, 202);
    }

    const result = await runSync(service, syncOptions);
    await logUserActivity(userSupabase, "qbtime.manual_sync", result);
    return jsonResponse({ data: result });
  }

  const { data, error } = await service.from("qbtime_settings").select("id,client_id,redirect_uri,tenant_info,last_sync,created_at,updated_at").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) return jsonResponse({ error: error.message }, 400);
  return jsonResponse({ data });
}
async function exchangeCode(settings: Record<string, string>, code: string) {
  const response = await fetch(Deno.env.get("QB_TIME_TOKEN_URL") || "https://rest.tsheets.com/api/v1/grant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: settings.client_id,
      client_secret: atob(settings.encrypted_secret).split(":")[0],
      code,
      redirect_uri: settings.redirect_uri,
    }),
  });
  if (!response.ok) throw new Error(`QuickBooks Time token exchange failed: ${response.status}`);
  return response.json();
}

function fullSyncRequested(url: URL) {
  const mode = String(url.searchParams.get("mode") || "").toLowerCase();
  const full = String(url.searchParams.get("full") || "").toLowerCase();
  return mode === "full" || full === "true" || full === "1" || Deno.env.get("QB_TIME_FORCE_FULL_SYNC") === "true";
}

type SyncOptions = { forceFullTimesheets?: boolean };

async function findRecentRunningSync(supabase: ReturnType<typeof serviceClient>) {
  const recentThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("sync_logs")
    .select("id,started_at")
    .eq("status", "running")
    .is("finished_at", null)
    .gte("started_at", recentThreshold)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("QuickBooks Time running-sync check failed", syncErrorMessage(error));
    return null;
  }
  return data;
}

function queueBackgroundSync(supabase: ReturnType<typeof serviceClient>, options: SyncOptions) {
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (typeof runtime?.waitUntil !== "function") return false;
  runtime.waitUntil(runSync(supabase, options).catch((error) => {
    console.error("QuickBooks Time background sync failed", syncErrorMessage(error));
  }));
  return true;
}

function queueDashboardRebuild(supabase: ReturnType<typeof serviceClient>) {
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (typeof runtime?.waitUntil !== "function") return false;
  runtime.waitUntil(supabase.rpc("rebuild_dashboard_experience_records").then(({ error }) => {
    if (error) console.error("QuickBooks Time dashboard rebuild failed", syncErrorMessage(error));
  }).catch((error) => {
    console.error("QuickBooks Time dashboard rebuild failed", syncErrorMessage(error));
  }));
  return true;
}

async function runSync(supabase: ReturnType<typeof serviceClient>, options: SyncOptions = {}) {
  const started = new Date().toISOString();
  await supabase.from("sync_logs").update({
    status: "failed",
    message: "Sync timed out before completion",
    finished_at: started,
  }).eq("status", "running").is("finished_at", null);
  const { data: settings, error: settingsError } = await supabase.from("qbtime_settings").select("*").order("created_at", { ascending: false }).limit(1).single();
  if (settingsError || !settings) throw new Error(settingsError?.message || "QuickBooks Time settings are not configured");
  const { data: log, error: logError } = await supabase.from("sync_logs").insert({ status: "running", started_at: started }).select("id").single();
  const stats: Record<string, number> = {};
  const errors: Array<{ dataset: string; message: string }> = [];
  const warnings: Array<{ dataset: string; message: string }> = [];
  if (logError || !log?.id) warnings.push({ dataset: "Sync Log", message: logError?.message || "Could not create a sync log entry" });

  try {
    let accessToken = settings.access_token;
    if (!accessToken) throw new Error("QuickBooks Time is not connected");
    if (settings.token_expires_at && new Date(settings.token_expires_at).getTime() < Date.now() + 120000) {
      const refreshed = await refreshAccessToken(settings);
      accessToken = refreshed.access_token;
      await supabase.from("qbtime_settings").update({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || settings.refresh_token,
        token_expires_at: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString(),
      }).eq("id", settings.id);
    }

    for (const resource of resources) {
      try {
        stats[resource.dataset] = await syncResourceDataset(supabase, resource, accessToken, options);
      } catch (error) {
        const message = syncErrorMessage(error);
        if (resource.optional && isForbiddenSyncError(message)) {
          warnings.push({ dataset: resource.dataset, message });
        } else {
          errors.push({ dataset: resource.dataset, message });
        }
      }
    }

    const permissionResult = await supabase.rpc("grant_shared_qbtime_dataset_permissions", { target_user_id: null });
    if (permissionResult.error) {
      warnings.push({ dataset: "Permissions", message: permissionResult.error.message });
    }
    if (!queueDashboardRebuild(supabase)) {
      warnings.push({ dataset: "Dashboard Refresh", message: "Dashboard analytics rebuild could not be queued in this runtime." });
    }
    const lastSyncResult = await supabase.from("qbtime_settings").update({ last_sync: new Date().toISOString() }).eq("id", settings.id);
    if (lastSyncResult.error) warnings.push({ dataset: "Settings", message: lastSyncResult.error.message });
    const status = errors.length ? "partial" : "success";
    await updateSyncLog(supabase, log?.id, {
      status,
      message: errors.map((error) => `${error.dataset}: ${error.message}`).join("; ") || warnings.map((warning) => `${warning.dataset}: ${warning.message}`).join("; ") || null,
      stats: { ...stats, mode: options.forceFullTimesheets ? "full" : "incremental", errors, warnings },
      finished_at: new Date().toISOString(),
    });
    return { status, stats: { ...stats, mode: options.forceFullTimesheets ? "full" : "incremental", errors, warnings }, errors, warnings };
  } catch (error) {
    await updateSyncLog(supabase, log?.id, { status: "failed", message: syncErrorMessage(error), stats, finished_at: new Date().toISOString() });
    throw error;
  }
}

async function updateSyncLog(supabase: ReturnType<typeof serviceClient>, logId: string | undefined, patch: Record<string, unknown>) {
  if (!logId) return;
  const { error } = await supabase.from("sync_logs").update(patch).eq("id", logId);
  if (error) console.warn("QuickBooks Time sync log update failed", syncErrorMessage(error));
}

async function logUserActivity(userSupabase: ReturnType<typeof userClient>, actionName: string, details: unknown) {
  try {
    const { error } = await userSupabase.rpc("log_activity", { action_name: actionName, details_json: details });
    if (error) console.warn("QuickBooks Time activity log failed", syncErrorMessage(error));
  } catch (error) {
    console.warn("QuickBooks Time activity log failed", syncErrorMessage(error));
  }
}

function syncErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [
      record.message,
      record.details,
      record.hint ? `hint: ${record.hint}` : "",
      record.code ? `code: ${record.code}` : "",
    ]
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
    try {
      return JSON.stringify(record);
    } catch {
      return "Sync failed with an unreadable error object";
    }
  }
  return String(error || "Sync failed");
}

function isForbiddenSyncError(message: string) {
  return /(^|\D)403(\D|$)|forbidden/i.test(message);
}
async function refreshAccessToken(settings: Record<string, string>) {
  if (!settings.refresh_token) throw new Error("QuickBooks Time refresh token is missing");
  const response = await fetch(Deno.env.get("QB_TIME_TOKEN_URL") || "https://rest.tsheets.com/api/v1/grant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: settings.client_id,
      client_secret: atob(settings.encrypted_secret).split(":")[0],
      refresh_token: settings.refresh_token,
    }),
  });
  if (!response.ok) throw new Error(await responseError(response, "QuickBooks Time token refresh failed"));
  return response.json();
}

async function fetchAll(resource: string, accessToken: string, useDateRange = false) {
  const base = Deno.env.get("QB_TIME_API_URL") || "https://rest.tsheets.com/api/v1";
  const rows: unknown[] = [];
  const perPage = Number(Deno.env.get("QB_TIME_PAGE_SIZE") || "200");
  const maxPages = Number(Deno.env.get("QB_TIME_MAX_PAGES") || "250");
  let page = 1;
  let reachedPageCap = false;

  while (page <= maxPages) {
    const url = new URL(`${base}/${resource}`);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    if (useDateRange) {
      const configuredStart = Deno.env.get("QB_TIME_SYNC_START_DATE");
      const configuredEnd = Deno.env.get("QB_TIME_SYNC_END_DATE");
      const end = configuredEnd ? new Date(`${configuredEnd}T00:00:00Z`) : new Date();
      const start = configuredStart ? new Date(`${configuredStart}T00:00:00Z`) : new Date(Date.UTC(end.getUTCFullYear() - 2, end.getUTCMonth(), end.getUTCDate()));
      url.searchParams.set("start_date", start.toISOString().slice(0, 10));
      url.searchParams.set("end_date", end.toISOString().slice(0, 10));
    }
    const pageRows = await fetchPageRows(url, accessToken, resource);
    rows.push(...pageRows.rows);
    if (!pageRows.more || pageRows.rows.length === 0) break;
    if (page === maxPages) reachedPageCap = true;
    page += 1;
  }

  if (reachedPageCap) {
    console.warn(`QuickBooks Time ${resource} reached page cap ${maxPages}; increase QB_TIME_MAX_PAGES for a deeper sync.`);
  }
  return rows;
}

async function syncResourceDataset(
  supabase: ReturnType<typeof serviceClient>,
  resource: { endpoint: string; dataset: string; useDateRange?: boolean },
  accessToken: string,
  options: SyncOptions = {},
) {
  const perPage = Number(Deno.env.get("QB_TIME_PAGE_SIZE") || "200");
  const maxPages = Number(Deno.env.get("QB_TIME_MAX_PAGES") || "250");
  const name = `QuickBooks Time ${resource.dataset}`;
  const { data: existing } = await supabase.from("datasets").select("id,record_count").eq("name", name).maybeSingle();
  const { data: dataset, error: datasetError } = existing
    ? await supabase.from("datasets").update({
      description: `Synchronized ${resource.dataset} from QuickBooks Time`,
      source_type: "quickbooks_time",
    }).eq("id", existing.id).select("id,record_count").single()
    : await supabase.from("datasets").insert({
      name,
      description: `Synchronized ${resource.dataset} from QuickBooks Time`,
      source_type: "quickbooks_time",
      record_count: 0,
    }).select("id,record_count").single();
  if (datasetError) throw datasetError;

  if (resource.useDateRange) {
    const forceFullWindow = Boolean(options.forceFullTimesheets);
    const { start: configuredStart, end: configuredEnd } = configuredDateWindow();
    const end = forceFullWindow ? configuredEnd : new Date();
    const latestWorkDate = forceFullWindow ? null : await latestDatasetWorkDate(supabase, dataset.id);
    const overlapDays = Math.max(Number(Deno.env.get("QB_TIME_INCREMENTAL_OVERLAP_DAYS") || "7"), 0);
    const catchupStart = latestWorkDate
      ? maxDate(subtractUtcDays(new Date(`${latestWorkDate}T00:00:00Z`), overlapDays), configuredStart)
      : configuredStart;
    const rows = await fetchDateWindowRowsInChunks(resource.endpoint, accessToken, catchupStart, end, perPage, maxPages);
    await upsertDatasetRows(supabase, dataset.id, rows);
    if (forceFullWindow && rows.length) await deleteLegacyDatasetDateRange(supabase, dataset.id, catchupStart, end);
    const total = await countDatasetRecords(supabase, dataset.id);
    await supabase.from("datasets").update({ record_count: total }).eq("id", dataset.id);
    return total;
  }

  // Reference datasets such as Employees and Job Codes must refresh from page 1
  // every sync. Their names and parent relationships can change, and resuming
  // from record_count/per_page skips the pages that dashboard job-code joins need.
  const rows = await fetchAll(resource.endpoint, accessToken, false);
  await upsertDatasetRows(supabase, dataset.id, rows);
  const total = await countDatasetRecords(supabase, dataset.id);
  await supabase.from("datasets").update({ record_count: total }).eq("id", dataset.id);
  return total;
}

async function latestDatasetWorkDate(supabase: ReturnType<typeof serviceClient>, datasetId: string) {
  const { data, error } = await supabase
    .from("records")
    .select("work_date")
    .eq("dataset_id", datasetId)
    .not("work_date", "is", null)
    .order("work_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.work_date || null;
}

function configuredDateWindow() {
  const configuredStart = Deno.env.get("QB_TIME_SYNC_START_DATE");
  const configuredEnd = Deno.env.get("QB_TIME_SYNC_END_DATE");
  const end = configuredEnd ? new Date(`${configuredEnd}T00:00:00Z`) : new Date();
  const start = configuredStart ? new Date(`${configuredStart}T00:00:00Z`) : new Date(Date.UTC(end.getUTCFullYear() - 2, end.getUTCMonth(), end.getUTCDate()));
  return { start, end };
}

function dateParam(date: Date) {
  return date.toISOString().slice(0, 10);
}

function subtractUtcDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() - days);
  return next;
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function maxDate(left: Date, right: Date) {
  return left.getTime() > right.getTime() ? left : right;
}

function minDate(left: Date, right: Date) {
  return left.getTime() < right.getTime() ? left : right;
}

async function fetchDateWindowRowsInChunks(resource: string, accessToken: string, start: Date, end: Date, perPage: number, maxPages: number) {
  const rows: unknown[] = [];
  const windowDays = Math.max(Number(Deno.env.get("QB_TIME_SYNC_WINDOW_DAYS") || "31"), 1);
  for (let cursor = new Date(start); cursor.getTime() <= end.getTime(); cursor = addUtcDays(cursor, windowDays)) {
    const chunkEnd = minDate(addUtcDays(cursor, windowDays - 1), end);
    const chunkRows = await fetchDateWindowRows(resource, accessToken, cursor, chunkEnd, perPage, maxPages);
    rows.push(...chunkRows);
  }
  return rows;
}

async function fetchDateWindowRows(resource: string, accessToken: string, start: Date, end: Date, perPage: number, maxPages: number) {
  const base = Deno.env.get("QB_TIME_API_URL") || "https://rest.tsheets.com/api/v1";
  const rows: unknown[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`${base}/${resource}`);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set("start_date", dateParam(start));
    url.searchParams.set("end_date", dateParam(end));
    const pageRows = await fetchPageRows(url, accessToken, resource);
    rows.push(...pageRows.rows);
    if (!pageRows.more || !pageRows.rows.length) break;
  }
  return rows;
}

async function deleteLegacyDatasetDateRange(supabase: ReturnType<typeof serviceClient>, datasetId: string, start: Date, end: Date) {
  const { error } = await supabase
    .from("records")
    .delete()
    .eq("dataset_id", datasetId)
    .gte("work_date", dateParam(start))
    .lte("work_date", dateParam(end))
    .not("source_hash", "like", "qbtime:%");
  if (error) throw error;
}

async function countDatasetRecords(supabase: ReturnType<typeof serviceClient>, datasetId: string) {
  const { count, error } = await supabase
    .from("records")
    .select("id", { count: "exact", head: true })
    .eq("dataset_id", datasetId);
  if (error) throw error;
  return count || 0;
}

async function fetchPageRows(url: URL, accessToken: string, resource: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(await responseError(response, `QuickBooks Time ${resource} sync failed`));
  const payload = await response.json();
  const container = payload.results?.[resource] || payload.results || [];
  const rows = Array.isArray(container) ? container : Object.values(container);
  return { rows, more: Boolean(payload.more) };
}

async function upsertDatasetRows(supabase: ReturnType<typeof serviceClient>, datasetId: string, rows: unknown[]) {
  if (!rows.length) return;
  const recordMap = new Map<string, DatasetRecord>();
  for (const row of rows) {
    const sourceHash = await sourceHashForRow(row);
    recordMap.set(sourceHash, {
      dataset_id: datasetId,
      json_data: row,
      source_hash: sourceHash,
    });
  }
  const records = Array.from(recordMap.values());
  for (let i = 0; i < records.length; i += RECORD_UPSERT_BATCH_SIZE) {
    await upsertRecordBatch(supabase, records.slice(i, i + RECORD_UPSERT_BATCH_SIZE), i, records.length);
  }
}

async function upsertRecordBatch(
  supabase: ReturnType<typeof serviceClient>,
  records: DatasetRecord[],
  startIndex: number,
  totalRecords: number,
) {
  const { error } = await supabase.from("records").upsert(records, { onConflict: "dataset_id,source_hash" });
  if (!error) return;

  const message = syncErrorMessage(error);
  if (/statement timeout|57014/i.test(message) && records.length > MIN_RECORD_UPSERT_BATCH_SIZE) {
    const midpoint = Math.ceil(records.length / 2);
    await upsertRecordBatch(supabase, records.slice(0, midpoint), startIndex, totalRecords);
    await upsertRecordBatch(supabase, records.slice(midpoint), startIndex + midpoint, totalRecords);
    return;
  }

  throw new Error(`Records upsert failed for rows ${startIndex + 1}-${startIndex + records.length} of ${totalRecords}: ${message}`);
}

async function sourceHashForRow(row: unknown) {
  const stableId = row && typeof row === "object" && "id" in row ? String((row as { id?: unknown }).id || "").trim() : "";
  if (stableId) return `qbtime:${stableId}`;
  return digest(JSON.stringify(row));
}

async function digest(value: string) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function htmlResponse(message: string, status = 200) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QuickBooks Time Connection</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; display: grid; min-height: 100vh; place-items: center; background: #f6f7f9; color: #17202a; }
    main { max-width: 560px; padding: 28px; background: white; border: 1px solid #d9dee7; border-radius: 8px; }
  </style>
</head>
<body><main><h1>QuickBooks Time</h1><p>${message}</p></main></body>
</html>`, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char] || char));
}

async function responseError(response: Response, fallback: string) {
  const text = await response.text().catch(() => "");
  let message = text;
  try {
    const parsed = text ? JSON.parse(text) : null;
    message = parsed?.error?.message || parsed?.error || parsed?.message || text;
  } catch {
    message = text;
  }
  const clean = String(message || "").replace(/\s+/g, " ").slice(0, 240);
  return `${fallback}: ${response.status}${clean ? ` - ${clean}` : ""}`;
}


