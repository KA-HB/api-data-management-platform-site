import { requireAuth, renderShell } from "./auth.js";
import { FUNCTIONS_BASE_URL } from "./config.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setButtonBusy, toast } from "./ui.js";

const profile = await requireAuth("admin");
if (profile) {
  renderShell(profile);
  if ($("#users-body")) loadUsers();
  if ($("#logs-body")) loadLogs();
  $("#user-form")?.addEventListener("submit", inviteUser);
}

async function loadUsers() {
  const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  if (error) return toast(error.message, "error");
  renderRows($("#users-body"), data, [
    (r) => escapeHtml(r.email),
    (r) => escapeHtml(r.role),
    (r) => r.active ? "<span class='status ok'>Active</span>" : "<span class='status danger'>Disabled</span>",
    (r) => escapeHtml(new Date(r.created_at).toLocaleDateString()),
    (r) => r.id === profile.id
      ? "<span class='status ok'>Current user</span>"
      : `<button class="secondary" data-role="${r.id}" data-next="${r.role === "admin" ? "user" : "admin"}">Toggle Role</button> <button class="danger" data-disable="${r.id}">${r.active ? "Disable" : "Enable"}</button>`,
  ]);
  document.querySelectorAll("[data-role]").forEach((btn) => btn.addEventListener("click", () => updateUser(btn.dataset.role, { role: btn.dataset.next }, btn)));
  document.querySelectorAll("[data-disable]").forEach((btn) => btn.addEventListener("click", () => updateUser(btn.dataset.disable, { active: btn.textContent === "Enable" }, btn)));
}

async function updateUser(id, patch, button = null) {
  setButtonBusy(button, true, "Saving...");
  const response = await fetch(`${FUNCTIONS_BASE_URL}/user-admin`, {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify({ id, ...patch }),
  });
  const payload = await response.json();
  setButtonBusy(button, false);
  if (!response.ok) return toast(payload.error, "error");
  toast("User updated.");
  loadUsers();
}

async function inviteUser(event) {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector("button");
  setButtonBusy(button, true, "Creating...");
  const response = await fetch(`${FUNCTIONS_BASE_URL}/user-admin`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      email: $("#new-user-email").value.trim(),
      role: $("#new-user-role").value,
    }),
  });
  const payload = await response.json();
  setButtonBusy(button, false);
  if (!response.ok) return toast(payload.error, "error");
  toast(`User created. Temporary password: ${payload.data.temporary_password}`);
  event.target.reset();
  loadUsers();
}

async function loadLogs() {
  const { data, error } = await supabase.from("activity_logs").select("*,profiles(email)").order("created_at", { ascending: false }).limit(100);
  if (error) return toast(error.message, "error");
  renderRows($("#logs-body"), data, [
    (r) => escapeHtml(r.profiles?.email || "system"),
    (r) => escapeHtml(r.action),
    (r) => `<pre>${escapeHtml(JSON.stringify(r.details, null, 2))}</pre>`,
    (r) => escapeHtml(new Date(r.created_at).toLocaleString()),
  ]);
}

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  return { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" };
}
