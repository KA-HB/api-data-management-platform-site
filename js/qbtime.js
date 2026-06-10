import { requireAuth, renderShell } from "./auth.js";
import { FUNCTIONS_BASE_URL } from "./config.js";
import { supabase } from "./supabaseClient.js";
import { $, toast } from "./ui.js";

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
  const payload = await response.json();
  if (payload.data) {
    $("#client-id").value = payload.data.client_id || "";
    $("#redirect-uri").value = payload.data.redirect_uri || "";
    $("#last-sync").textContent = payload.data.last_sync ? new Date(payload.data.last_sync).toLocaleString() : "Never";
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const response = await fetch(`${FUNCTIONS_BASE_URL}/qbtime?action=settings`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      client_id: $("#client-id").value.trim(),
      client_secret: $("#client-secret").value,
      redirect_uri: $("#redirect-uri").value.trim(),
    }),
  });
  const payload = await response.json();
  toast(response.ok ? "QuickBooks Time settings saved." : payload.error, response.ok ? "info" : "error");
}

async function authorize() {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/qbtime?action=authorize-url`, { headers: await authHeaders() });
  const payload = await response.json();
  if (!response.ok) return toast(payload.error, "error");
  location.href = payload.data.url;
}

async function syncNow() {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/qbtime?action=sync`, { method: "POST", headers: await authHeaders() });
  const payload = await response.json();
  toast(response.ok ? `Sync complete: ${JSON.stringify(payload.data.stats)}` : payload.error, response.ok ? "info" : "error");
  loadSettings();
}
