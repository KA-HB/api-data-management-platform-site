import { requireAuth, renderShell } from "./auth.js";
import { FUNCTIONS_BASE_URL } from "./config.js";
import { supabase } from "./supabaseClient.js";
import { $, setButtonBusy, startProgress, stopProgress, toast } from "./ui.js";

const profile = await requireAuth("admin");
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
  if (payload.data) {
    $("#client-id").value = payload.data.client_id || "";
    $("#redirect-uri").value = payload.data.redirect_uri || "";
    $("#last-sync").textContent = payload.data.last_sync ? new Date(payload.data.last_sync).toLocaleString() : "Never";
  }
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
    const stats = payload.data?.stats ? ` ${JSON.stringify(payload.data.stats)}` : "";
    const errors = payload.data?.errors || [];
    const warnings = payload.data?.warnings || payload.data?.stats?.warnings || [];
    const issueText = [...errors, ...warnings].length ? ` Warnings: ${[...errors, ...warnings].map((e) => `${e.dataset}: ${e.message}`).join("; ")}` : "";
    stopProgress(progress, response.ok ? `Sync finished.${stats}${issueText}` : payload.error, response.ok && !issueText ? "success" : "info");
    loadSettings();
  } catch (error) {
    stopProgress(progress, error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function readPayload(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || `Request failed with status ${response.status}` };
  }
}
