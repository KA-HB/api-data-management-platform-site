import { requireAuth, renderShell } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setText, startProgress, stopProgress, toast } from "./ui.js";

const profile = await requireAuth();
const charts = [];

if (profile) {
  renderShell(profile);
  await loadDashboard();
}

async function loadDashboard() {
  const progress = startProgress("Loading dashboard data...");
  const [{ data: summary, error }, { data: logs }, qb] = await Promise.all([
    supabase.rpc("dashboard_summary"),
    supabase.from("activity_logs").select("action,details,created_at").order("created_at", { ascending: false }).limit(8),
    profile.role === "admin" ? supabase.rpc("dashboard_qbtime_rollups") : Promise.resolve({ data: null, error: null }),
  ]);

  if (error) return stopProgress(progress, error.message, "error");
  stopProgress(progress);

  setText("#metric-users", summary.users ?? "-");
  setText("#metric-datasets", summary.datasets ?? "-");
  setText("#metric-records", formatNumber(summary.records));
  setText("#metric-keys", summary.api_keys ?? "-");
  setText("#metric-sync", summary.last_sync_status || "Not run");

  renderChart("#records-by-dataset", "bar", summary.records_by_dataset || [], "name", "record_count", "Records");
  renderChart("#records-over-time", "line", summary.records_by_day || [], "date", "records", "Records");
  renderChart("#activity-over-time", "line", summary.activity_by_day || [], "date", "events", "Events");

  if (qb?.data) {
    renderChart("#hours-by-employee", "bar", qb.data.hours_by_employee || [], "employee", "hours", "Hours");
    renderChart("#hours-by-jobcode", "bar", qb.data.hours_by_jobcode || [], "jobcode", "hours", "Hours");
    renderChart("#pto-by-employee", "bar", qb.data.pto_by_employee || [], "employee", "hours", "Hours");
  } else if (qb?.error) {
    toast(qb.error.message, "error");
  }

  renderRecentUploads(summary.recent_uploads || []);
  renderRecentSyncs(summary.recent_syncs || []);
  renderRecentLogs(logs || []);
}

function renderChart(selector, type, rows, labelKey, valueKey, label) {
  const canvas = $(selector);
  if (!canvas || !window.Chart) return;
  const context = canvas.getContext("2d");
  const dataRows = rows.length ? rows : [{ [labelKey]: "No data", [valueKey]: 0 }];
  charts.push(new Chart(context, {
    type,
    data: {
      labels: dataRows.map((row) => String(row[labelKey] ?? "")),
      datasets: [{
        label,
        data: dataRows.map((row) => Number(row[valueKey] || 0)),
        borderColor: "#2563eb",
        backgroundColor: type === "line" ? "rgba(37, 99, 235, .16)" : ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#0891b2", "#7c3aed", "#475569"],
        borderWidth: 2,
        tension: 0.28,
        fill: type === "line",
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true, color: "#475467" }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: "#475467" }, grid: { color: "#eef2f7" } },
      },
    },
  }));
}

function renderRecentUploads(rows) {
  const tbody = $("#recent-uploads");
  if (!tbody) return;
  renderRows(tbody, rows, [
    (r) => escapeHtml(r.name),
    (r) => escapeHtml(r.source_type),
    (r) => formatNumber(r.record_count),
    (r) => escapeHtml(r.updated_at ? new Date(r.updated_at).toLocaleString() : "Never"),
  ]);
}

function renderRecentSyncs(rows) {
  const tbody = $("#recent-syncs");
  if (!tbody) return;
  renderRows(tbody, rows, [
    (r) => `<span class="status ${r.status === "success" ? "ok" : r.status === "partial" ? "warn" : "danger"}">${escapeHtml(r.status)}</span>`,
    (r) => escapeHtml(r.finished_at ? new Date(r.finished_at).toLocaleString() : "Running"),
    (r) => escapeHtml(r.message || JSON.stringify(r.stats || {})),
  ]);
}

function renderRecentLogs(rows) {
  const tbody = $("#recent-logs");
  if (!tbody) return;
  renderRows(tbody, rows, [
    (r) => escapeHtml(r.action),
    (r) => escapeHtml(new Date(r.created_at).toLocaleString()),
    (r) => `<pre>${escapeHtml(JSON.stringify(r.details, null, 2))}</pre>`,
  ]);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}
