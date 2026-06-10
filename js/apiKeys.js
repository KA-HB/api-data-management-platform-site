import { requireAuth, renderShell } from "./auth.js";
import { FUNCTIONS_BASE_URL } from "./config.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setButtonBusy, toast } from "./ui.js";

const profile = await requireAuth();
if (profile) {
  renderShell(profile);
  loadKeys();
  $("#api-key-form")?.addEventListener("submit", createKey);
}

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  return { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" };
}

async function loadKeys() {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/api-keys`, { headers: await authHeaders() });
  const payload = await response.json();
  renderRows($("#api-keys-body"), payload.data || [], [
    (r) => escapeHtml(r.key_name),
    (r) => escapeHtml(r.prefix),
    (r) => r.revoked ? "<span class='status danger'>Revoked</span>" : "<span class='status ok'>Active</span>",
    (r) => escapeHtml(r.last_used_at ? new Date(r.last_used_at).toLocaleString() : "Never"),
    (r) => r.revoked ? "" : `<button class="danger" data-revoke="${r.id}">Revoke</button>`,
  ]);
  document.querySelectorAll("[data-revoke]").forEach((btn) => btn.addEventListener("click", () => revokeKey(btn.dataset.revoke)));
}

async function createKey(event) {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector("button");
  setButtonBusy(button, true, "Creating...");
  const response = await fetch(`${FUNCTIONS_BASE_URL}/api-keys`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ key_name: $("#key-name").value.trim() }),
  });
  const payload = await response.json();
  setButtonBusy(button, false);
  if (!response.ok) return toast(payload.error, "error");
  $("#raw-key").textContent = payload.data.raw_key;
  $("#raw-key-wrap").classList.remove("hidden");
  event.target.reset();
  loadKeys();
}

async function revokeKey(id) {
  const button = document.querySelector(`[data-revoke="${id}"]`);
  setButtonBusy(button, true, "Revoking...");
  const response = await fetch(`${FUNCTIONS_BASE_URL}/api-keys`, {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify({ id }),
  });
  const payload = await response.json();
  setButtonBusy(button, false);
  if (!response.ok) return toast(payload.error, "error");
  toast("API key revoked.");
  loadKeys();
}
