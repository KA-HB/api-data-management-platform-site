import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";

const DASHBOARD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_CACHE_DB = "dashboard-cache-db-v2";
const DASHBOARD_CACHE_STORE = "responses";
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

installDashboardFetchCache();

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

installDashboardRpcCache();
installDashboardCacheInvalidation();

function installDashboardRpcCache() {
  const originalRpc = supabase.rpc.bind(supabase);
  supabase.rpc = (fnName, args = {}, options = {}) => {
    if (!shouldCacheRpc(fnName, args)) return originalRpc(fnName, args, options);

    const key = dashboardMemoryCacheKey(fnName, args);
    const cached = readDashboardMemoryCache(key);
    if (cached) return Promise.resolve(cached);

    return originalRpc(fnName, args, options).then((result) => {
      if (!result?.error) writeDashboardMemoryCache(key, result);
      return result;
    });
  };
}

function shouldCacheRpc(fnName, args = {}) {
  if (!CACHEABLE_RPC_NAMES.has(fnName)) return false;
  if (fnName !== "dashboard_qbtime_rollups") return true;
  return DASHBOARD_ROLLUP_EMPTY_ARGS.every((key) => !args?.[key]);
}

function installDashboardFetchCache() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const request = normalizeRequest(args);

    if (!isCacheableDashboardRequest(request)) {
      const response = await originalFetch(...args);
      await maybeClearDashboardCache(request, response);
      return response;
    }

    const cacheKey = await dashboardResponseCacheKey(request);
    const cached = await readDashboardResponseCache(cacheKey);
    if (cached) return responseFromCache(cached);

    const response = await originalFetch(...args);
    await maybeClearDashboardCache(request, response);
    if (response.ok) await writeDashboardResponseCache(cacheKey, response.clone());
    return response;
  };
}

function normalizeRequest(args) {
  const input = args[0];
  const init = args[1] || {};
  const url = String(input?.url || input || "");
  const method = String(init.method || input?.method || "GET").toUpperCase();
  const headers = new Headers(init.headers || input?.headers || {});
  return {
    input,
    init,
    url,
    method,
    headers,
    body: init.body || "",
  };
}

function isCacheableDashboardRequest(request) {
  if (!request.url.startsWith(SUPABASE_URL)) return false;
  if (request.url.includes("/auth/v1/")) return false;
  if (request.method === "GET" && request.url.includes("/rest/v1/")) {
    return request.url.includes("/datasets")
      || request.url.includes("/activity_logs")
      || request.url.includes("/records");
  }
  if (request.method === "POST" && request.url.includes("/rest/v1/rpc/")) {
    return Array.from(CACHEABLE_RPC_NAMES).some((name) => request.url.includes(`/rpc/${name}`));
  }
  return false;
}

async function dashboardResponseCacheKey(request) {
  return [
    "dashboard-response-cache-v2",
    todayKey(),
    authBucket(request.headers),
    request.method,
    request.url,
    await digest(String(request.body || "")),
  ].join(":");
}

function authBucket(headers) {
  const auth = headers.get("authorization") || headers.get("Authorization") || "";
  return auth ? auth.slice(-24) : currentCachedUserId();
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function responseFromCache(cached) {
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: cached.headers,
  });
}

async function readDashboardResponseCache(key) {
  try {
    const db = await openDashboardCacheDb();
    const cached = await idbGet(db, key);
    if (!cached || Date.now() - cached.saved_at > DASHBOARD_CACHE_TTL_MS || cached.day !== todayKey()) {
      if (cached) await idbDelete(db, key);
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

async function writeDashboardResponseCache(key, response) {
  try {
    const body = await response.text();
    const headers = Array.from(response.headers.entries());
    const db = await openDashboardCacheDb();
    await idbSet(db, {
      key,
      day: todayKey(),
      saved_at: Date.now(),
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
    });
  } catch {
    // Ignore storage failures.
  }
}

function openDashboardCacheDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DASHBOARD_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DASHBOARD_CACHE_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DASHBOARD_CACHE_STORE, "readonly");
    const request = tx.objectStore(DASHBOARD_CACHE_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function idbSet(db, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DASHBOARD_CACHE_STORE, "readwrite");
    tx.objectStore(DASHBOARD_CACHE_STORE).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DASHBOARD_CACHE_STORE, "readwrite");
    tx.objectStore(DASHBOARD_CACHE_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbClear(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DASHBOARD_CACHE_STORE, "readwrite");
    tx.objectStore(DASHBOARD_CACHE_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearDashboardResponseCache() {
  try {
    await idbClear(await openDashboardCacheDb());
  } catch {
    // Ignore storage failures.
  }
}

async function maybeClearDashboardCache(request, response) {
  if (request.method === "POST" && request.url.includes("/functions/v1/qbtime") && request.url.includes("action=sync") && response.ok) {
    clearOldDashboardCache();
    await clearDashboardResponseCache();
  }
}

function dashboardMemoryCacheKey(fnName, args = {}) {
  return [
    "dashboard-cache-v1",
    todayKey(),
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

function readDashboardMemoryCache(key) {
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    if (!cached || Date.now() - cached.saved_at > DASHBOARD_CACHE_TTL_MS || cached.day !== todayKey()) {
      localStorage.removeItem(key);
      return null;
    }
    return cached.result;
  } catch {
    return null;
  }
}

function writeDashboardMemoryCache(key, result) {
  try {
    localStorage.setItem(key, JSON.stringify({ day: todayKey(), saved_at: Date.now(), result }));
  } catch {
    clearOldDashboardCache();
    try {
      localStorage.setItem(key, JSON.stringify({ day: todayKey(), saved_at: Date.now(), result }));
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
  window.clearDashboardCache = () => {
    clearOldDashboardCache();
    clearDashboardResponseCache();
  };
}

async function digest(value) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
