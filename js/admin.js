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
  $("#grant-qbtime-access")?.addEventListener("click", grantQbtimeAccess);
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
      : `<div class="user-actions"><div class="form-actions"><button class="secondary" data-role="${r.id}" data-next="${r.role === "admin" ? "user" : "admin"}">Toggle Role</button><button class="danger" data-disable="${r.id}">${r.active ? "Disable" : "Enable"}</button></div><div class="inline-password"><input type="password" autocomplete="new-password" placeholder="New password" data-password-input="${r.id}"><button class="secondary" data-password="${r.id}" type="button">Set Password</button></div></div>`,
  ]);
  document.querySelectorAll("[data-role]").forEach((btn) => btn.addEventListener("click", () => updateUser(btn.dataset.role, { role: btn.dataset.next }, btn)));
  document.querySelectorAll("[data-disable]").forEach((btn) => btn.addEventListener("click", () => updateUser(btn.dataset.disable, { active: btn.textContent === "Enable" }, btn)));
  document.querySelectorAll("[data-password]").forEach((btn) => btn.addEventListener("click", () => updatePassword(btn.dataset.password, btn)));
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

async function updatePassword(id, button) {
  const input = document.querySelector(`[data-password-input="${id}"]`);
  const password = input?.value || "";
  if (password.length < 8) return toast("Enter a password with at least 8 characters.", "error");
  setButtonBusy(button, true, "Saving...");
  const response = await fetch(`${FUNCTIONS_BASE_URL}/user-admin`, {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify({ id, password }),
  });
  const payload = await response.json();
  setButtonBusy(button, false);
  if (!response.ok) return toast(payload.error, "error");
  input.value = "";
  toast("Password updated.", "success");
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
  try {
    await grantSharedQbtimeAccess([payload.data.id]);
  } catch (error) {
    toast(`User created, but dashboard access still needs to be granted: ${error.message}`, "error");
  }
  toast(`User created. Temporary password: ${payload.data.temporary_password}`);
  event.target.reset();
  loadUsers();
}

async function grantQbtimeAccess(event) {
  const button = event.currentTarget;
  setButtonBusy(button, true, "Granting...");
  try {
    const stats = await grantSharedQbtimeAccess();
    toast(`QuickBooks Time access granted for ${stats.users} active users across ${stats.datasets} datasets.`, "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function grantSharedQbtimeAccess(userIds = null) {
  const [{ data: datasets, error: datasetError }, { data: users, error: userError }] = await Promise.all([
    supabase.from("datasets").select("id,name,source_type").neq("name", "QuickBooks Time PTO"),
    userIds?.length
      ? supabase.from("profiles").select("id").in("id", userIds).eq("active", true)
      : supabase.from("profiles").select("id").eq("active", true),
  ]);
  if (datasetError) throw datasetError;
  if (userError) throw userError;

  const sharedDatasets = (datasets || []).filter((dataset) =>
    dataset.source_type === "quickbooks_time" || String(dataset.name || "").startsWith("QuickBooks Time ")
  );
  const permissions = (users || []).flatMap((user) =>
    sharedDatasets.map((dataset) => ({
      dataset_id: dataset.id,
      user_id: user.id,
      can_export: true,
    }))
  );
  if (!permissions.length) return { users: users?.length || 0, datasets: sharedDatasets.length };

  const { error } = await supabase
    .from("dataset_permissions")
    .upsert(permissions, { onConflict: "dataset_id,user_id" });
  if (error) throw error;
  return { users: users?.length || 0, datasets: sharedDatasets.length };
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
