import { requireAuth, renderShell } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { renderRows, setText, escapeHtml } from "./ui.js";

const profile = await requireAuth();
if (profile) {
  renderShell(profile);
  const [{ count: users }, { count: datasets }, { count: keys }, { data: logs }, { data: sync }] = await Promise.all([
    supabase.from("profiles").select("id", { count: "exact", head: true }),
    supabase.from("datasets").select("id", { count: "exact", head: true }),
    supabase.from("api_keys").select("id", { count: "exact", head: true }),
    supabase.from("activity_logs").select("action,details,created_at").order("created_at", { ascending: false }).limit(8),
    supabase.from("sync_logs").select("status,stats,finished_at").order("started_at", { ascending: false }).limit(1),
  ]);
  setText("#metric-users", users ?? "-");
  setText("#metric-datasets", datasets ?? "-");
  setText("#metric-keys", keys ?? "-");
  setText("#metric-sync", sync?.[0]?.status || "Not run");

  const tbody = document.querySelector("#recent-logs");
  if (tbody) {
    renderRows(tbody, logs || [], [
      (r) => escapeHtml(r.action),
      (r) => escapeHtml(new Date(r.created_at).toLocaleString()),
      (r) => `<pre>${escapeHtml(JSON.stringify(r.details, null, 2))}</pre>`,
    ]);
  }
}
