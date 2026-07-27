import { requireAuth, renderShell } from "./auth.js";
import { FUNCTIONS_BASE_URL } from "./config.js";
import { supabase } from "./supabaseClient.js";
import { $, setButtonBusy, startProgress, stopProgress, toast } from "./ui.js";

const profile = await requireAuth("admin");
const SYNC_STATUS_POLL_MS = 5000;
const SYNC_STATUS_MAX_POLLS = 24;

if (profile) {
  renderShell(profile);
  loadSettings();
  $("#qb-form")?.addEventListener("submit", saveSettings);
  $("#qb-authorize")?.addEventListener("click", authorize);
  $("#qb-sync")?.addEventListener("click", syncNow);
}

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  return { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" };
}

async function loadSettings() {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/qbtime`, { headers: await authHeaders() });
  const payload = await readPayload(response);
  if (!response.ok) {
    renderConnectionStatus(payload.error || `Could not load QuickBooks settings (${response.status}).`, "error");
    return null;
  }
  if (payload.data) {
    $("#client-id").value = payload.data.client_id || "";
    $("#redirect-uri").value = payload.data.redirect_uri || "";
    $("#last-sync").textContent = payload.data.last_sync ? new Date(payload.data.last_sync).toLocaleString() : "Never";
  }
  const connected = Boolean(payload.data?.connected);
  const syncButton = $("#qb-sync");
  if (syncButton) {
    syncButton.disabled = !connected;
    syncButton.title = connected ? "" : "Reconnect QuickBooks Time before running a sync.";
  }
  return loadConnectionStatus(Boolean(payload.data?.client_id), connected);
}

async function loadConnectionStatus(hasSettings, connected) {
  if (!hasSettings) {
    renderConnectionStatus("QuickBooks Time is not configured.", "error");
    return null;
  }
  if (!connected) {
    renderConnectionStatus(friendlySyncError("reconnect required"), "error");
    return "reconnect_required";
  }

  const { data, error } = await supabase
    .from("sync_logs")
    .select("status,message,finished_at")
    .eq("provider", "quickbooks_time")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    renderConnectionStatus("QuickBooks Time settings are configured.");
    return null;
  }
  if (requiresQuickBooksReconnect(data.message)) {
    renderConnectionStatus(friendlySyncError(data.message), "error");
    return data.status;
  }
  if (data.status === "success") {
    renderConnectionStatus(`Connected. Last successful sync ${new Date(data.finished_at).toLocaleString()}.`, "success");
    return data.status;
  }
  if (data.status === "running") {
    renderConnectionStatus("QuickBooks Time sync is currently running.");
    return data.status;
  }
  renderConnectionStatus(`Connected, but the latest sync failed: ${friendlySyncError(data.message)}`, "error");
  return data.status;
}

function renderConnectionStatus(message, type = "info") {
  const status = $("#qb-connection-status");
  if (!status) return;
  status.className = `notice ${type}`;
  status.textContent = message;
}

function requiresQuickBooksReconnect(message) {
  return /refresh[_ ]token.*invalid|token refresh failed.*invalid|invalid.*refresh[_ ]token|authorization expired|not connected|reconnect required/i.test(String(message || ""));
}

function friendlySyncError(message) {
  if (requiresQuickBooksReconnect(message)) {
    return "QuickBooks Time authorization expired. Select Connect / Reconnect QuickBooks Time, complete authorization, then run sync again.";
  }
  return message || "QuickBooks Time sync failed.";
}
async function saveSettings(event) {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector("button");
  setButtonBusy(button, true, "Saving...");
  try {
    const response = await fetch(`${FUNCTIONS_BASE_URL}/qbtime?action=settings`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        client_id: $("#client-id").value.trim(),
        client_secret: $("#client-secret").value,
        redirect_uri: $("#redirect-uri").value.trim(),
      }),
    });
    const payload = await readPayload(response);
    toast(response.ok ? "QuickBooks Time settings saved." : payload.error, response.ok ? "success" : "error");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function authorize() {
  const button = $("#qb-authorize");
  setButtonBusy(button, true, "Opening...");
  try {
    const response = await fetch(`${FUNCTIONS_BASE_URL}/qbtime?action=authorize-url`, { headers: await authHeaders() });
    const payload = await readPayload(response);
    if (!response.ok) return toast(payload.error, "error");
    location.href = payload.data.url;
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function syncNow() {
  const button = $("#qb-sync");
  const progress = startProgress("Syncing QuickBooks Time. This can take a minute...");
  setButtonBusy(button, true, "Syncing...");
  try {
    const response = await fetch(`${FUNCTIONS_BASE_URL}/qbtime?action=sync`, { method: "POST", headers: await authHeaders() });
    const payload = await readPayload(response);
    if (!response.ok) {
      stopProgress(progress, friendlySyncError(payload.error || `Sync failed with status ${response.status}`), "error");
      return;
    }
    if (payload.data?.queued || payload.data?.status === "running") {
      window.clearDashboardCache?.();
      stopProgress(progress, "Sync started in the background. Check Last sync again in a minute.", "info");
      window.setTimeout(() => pollSyncCompletion(), SYNC_STATUS_POLL_MS);
      return;
    }
    const stats = payload.data?.stats ? ` ${JSON.stringify(payload.data.stats)}` : "";
    const errors = payload.data?.errors || [];
    const warnings = payload.data?.warnings || payload.data?.stats?.warnings || [];
    const issueText = [...errors, ...warnings].length ? ` Warnings: ${[...errors, ...warnings].map((e) => `${e.dataset}: ${e.message}`).join("; ")}` : "";
    stopProgress(progress, `Sync finished.${stats}${issueText}`, issueText ? "info" : "success");
    loadSettings();
  } catch (error) {
    stopProgress(progress, friendlySyncError(error.message), "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function pollSyncCompletion(attempt = 0) {
  const status = await loadSettings();
  if (status === "running" && attempt < SYNC_STATUS_MAX_POLLS - 1) {
    window.setTimeout(() => pollSyncCompletion(attempt + 1), SYNC_STATUS_POLL_MS);
    return;
  }
  if (status && status !== "running") window.clearDashboardCache?.();
}

async function readPayload(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || `Request failed with status ${response.status}` };
  }
}
