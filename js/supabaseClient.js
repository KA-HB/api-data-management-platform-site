import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

const DASHBOARD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHEABLE_RPC_NAMES = new Set([
  "dashboard_summary",
  "dashboard_qbtime_filter_options",
  "dashboard_qbtime_rollups",
]);
const DASHBOARD_ROLLUP_EMPTY_ARGS = [
  "dataset_uuid",
  "keyword_filter",
  "employee_filter",
  "start_date",
  "end_date",
  "jobcode_level1_filter",
  "jobcode_level2_filter",
  "jobcode_level3_filter",
  "service_item_filter",
];

installDashboardRpcCache();
installDashboardCacheInvalidation();

function installDashboardRpcCache() {
  const originalRpc = supabase.rpc.bind(supabase);
  supabase.rpc = (fnName, args = {}, options = {}) => {
    if (!shouldCacheRpc(fnName, args)) return originalRpc(fnName, args, options);

    const key = dashboardCacheKey(fnName, args);
    const cached = readDashboardCache(key);
    if (cached) return Promise.resolve(cached);

    return originalRpc(fnName, args, options).then((result) => {
      if (!result?.error) writeDashboardCache(key, result);
      return result;
    });
  };
}

function shouldCacheRpc(fnName, args = {}) {
  if (!CACHEABLE_RPC_NAMES.has(fnName)) return false;
  if (fnName !== "dashboard_qbtime_rollups") return true;
  return DASHBOARD_ROLLUP_EMPTY_ARGS.every((key) => !args?.[key]);
}

function dashboardCacheKey(fnName, args = {}) {
  return [
    "dashboard-cache-v1",
    SUPABASE_URL,
    currentCachedUserId(),
    fnName,
    stableStringify(args || {}),
  ].join(":" );
}

function currentCachedUserId() {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) || "";
      if (!key.startsWith("sb-") || !key.endsWith("-auth-token")) continue;
      const parsed = JSON.parse(localStorage.getItem(key) || "{}");
      const userId = parsed?.user?.id || parsed?.currentSession?.user?.id;
      if (userId) return userId;
    }
  } catch {
    // Fall through to anonymous cache bucket.
  }
  return "anonymous";
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function readDashboardCache(key) {
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    if (!cached || Date.now() - cached.saved_at > DASHBOARD_CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return cached.result;
  } catch {
    return null;
  }
}

function writeDashboardCache(key, result) {
  try {
    localStorage.setItem(key, JSON.stringify({ saved_at: Date.now(), result }));
  } catch {
    clearOldDashboardCache();
    try {
      localStorage.setItem(key, JSON.stringify({ saved_at: Date.now(), result }));
    } catch {
      // Ignore storage quota or privacy-mode failures.
    }
  }
}

function clearOldDashboardCache() {
  try {
    const keys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("dashboard-cache-v1:")) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Ignore storage failures.
  }
}

function installDashboardCacheInvalidation() {
  window.clearDashboardCache = clearOldDashboardCache;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    try {
      const requestUrl = String(args[0]?.url || args[0] || "");
      const method = String(args[1]?.method || args[0]?.method || "GET").toUpperCase();
      if (method === "POST" && requestUrl.includes("/functions/v1/qbtime") && requestUrl.includes("action=sync") && response.ok) {
        clearOldDashboardCache();
      }
    } catch {
      // Ignore fetch wrapping errors.
    }
    return response;
  };
}
