import { requireAuth, renderShell } from "./auth.js";
import { FUNCTIONS_BASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { supabase } from "./supabaseClient.js";
import { setButtonBusy, setText } from "./ui.js";

const profile = await requireAuth("admin");
if (profile) {
  renderShell(profile);
  document.querySelector("#run-diagnostics")?.addEventListener("click", runDiagnostics);
  await runDiagnostics();
}

async function runDiagnostics() {
  const button = document.querySelector("#run-diagnostics");
  const output = document.querySelector("#diagnostics-output");
  setButtonBusy(button, true, "Running...");
  setText("#diagnostics-status", "Running safe browser-side diagnostics...");

  const results = {
    timestamp: new Date().toISOString(),
    pageUser: { email: profile?.email, role: profile?.role, active: profile?.active },
    checks: {},
  };

  results.checks.session = await safeCheck(async () => {
    const { data } = await supabase.auth.getSession();
    return { signedIn: Boolean(data.session), expiresAt: data.session?.expires_at || null };
  });

  results.checks.quickbooksDatasets = await safeCheck(async () => {
    const { data, error } = await supabase
      .from("datasets")
      .select("name,source_type,record_count,updated_at")
      .ilike("name", "QuickBooks Time%")
      .order("name");
    if (error) throw error;
    return { count: data?.length || 0, datasets: data || [] };
  });

  results.checks.jobcodeFilterRpc = await safeCheck(async () => {
    const { data, error } = await supabase.rpc("dashboard_qbtime_filter_options");
    if (error) throw error;
    return {
      employees: data?.employees?.length || 0,
      jobcode_level1: data?.jobcode_level1?.length || 0,
      jobcode_level2: data?.jobcode_level2?.length || 0,
      jobcode_level3: data?.jobcode_level3?.length || 0,
      service_items: data?.service_items?.length || 0,
      jobcode_level1_sample: (data?.jobcode_level1 || []).slice(0, 10),
      jobcode_level2_sample: (data?.jobcode_level2 || []).slice(0, 10),
    };
  });

  results.checks.rollupRpc = await safeCheck(async () => {
    const { data, error } = await supabase.rpc("dashboard_qbtime_rollups", {
      dataset_uuid: null,
      keyword_filter: null,
      employee_filter: null,
      start_date: null,
      end_date: null,
      jobcode_level1_filter: null,
      jobcode_level2_filter: null,
      jobcode_level3_filter: null,
      service_item_filter: null,
    });
    if (error) throw error;
    return {
      filtered_timesheets: data?.filtered_timesheets ?? null,
      filtered_hours: data?.filtered_hours ?? null,
      date_start: data?.date_start ?? null,
      date_end: data?.date_end ?? null,
      jobcode_sample: (data?.hours_by_jobcode || []).slice(0, 10),
    };
  });

  results.checks.qbtimeFunctionCors = await safeCheck(async () => {
    const response = await fetch(`${FUNCTIONS_BASE_URL}/qbtime?action=settings`, { method: "OPTIONS" });
    return { ok: response.ok, status: response.status, allowOrigin: response.headers.get("access-control-allow-origin") };
  });

  results.checks.qbtimeFunctionAuthReachable = await safeCheck(async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("No active browser session");
    const response = await fetch(`${FUNCTIONS_BASE_URL}/qbtime?action=settings`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    });
    return { ok: response.ok, status: response.status, statusText: response.statusText };
  });

  output.textContent = JSON.stringify(results, null, 2);
  const failed = Object.values(results.checks).filter((item) => item?.ok === false).length;
  setText("#diagnostics-status", failed ? `${failed} check(s) failed. Copy these results and send them back.` : "Diagnostics completed without detected failures.");
  setButtonBusy(button, false);
}

async function safeCheck(fn) {
  try {
    return { ok: true, result: await fn() };
  } catch (error) {
    return { ok: false, error: { name: error.name, message: error.message } };
  }
}
