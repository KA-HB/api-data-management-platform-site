import { requireAuth, renderShell } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setButtonBusy, setText, startProgress, stopProgress, toast } from "./ui.js";

const profile = await requireAuth();
let lastRows = [];
let page = 1;
let total = 0;

if (profile) {
  renderShell(profile);
  await loadDatasetOptions();
  $("#search-form")?.addEventListener("submit", runSearch);
  $("#run-search")?.addEventListener("click", () => {
    page = 1;
    runSearch();
  });
  $("#clear-search")?.addEventListener("click", clearSearch);
  $("#prev-page")?.addEventListener("click", () => changePage(-1));
  $("#next-page")?.addEventListener("click", () => changePage(1));
  $("#export-json")?.addEventListener("click", exportJson);
  updatePager();
}

async function loadDatasetOptions() {
  const { data, error } = await supabase.from("datasets").select("id,name").neq("name", "QuickBooks Time PTO").order("name");
  if (error) return toast(error.message, "error");
  $("#dataset").innerHTML = `<option value="">All authorized datasets</option>${(data || []).map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("")}`;
}

async function runSearch(event = null) {
  event?.preventDefault();
  page = event ? 1 : page;
  const button = event?.submitter || $("#run-search");
  const progress = startProgress("Searching records...");
  setButtonBusy(button, true, "Searching...");
  const pageSize = pageSizeValue();
  const { data, error } = await supabase.rpc("search_records_advanced", {
    dataset_uuid: $("#dataset").value || null,
    search_term: $("#term").value.trim() || null,
    exact_key: $("#exact-key").value.trim() || null,
    exact_value: $("#exact-value").value.trim() || null,
    start_date: dateValue("#start-date"),
    end_date: dateValue("#end-date", true),
    user_filter: $("#user-filter").value.trim() || null,
    employee_filter: $("#employee-filter").value.trim() || null,
    jobcode_filter: $("#jobcode-filter").value.trim() || null,
    status_filter: $("#status-filter").value.trim() || null,
    customer_filter: $("#customer-filter").value.trim() || null,
    sort_field: $("#sort-field").value,
    sort_direction: $("#sort-direction").value,
    limit_count: pageSize,
    offset_count: (page - 1) * pageSize,
  });
  setButtonBusy(button, false);
  if (error) return stopProgress(progress, error.message, "error");

  lastRows = data || [];
  total = Number(lastRows[0]?.total_count || 0);
  renderRows($("#records-body"), lastRows, [
    (r) => escapeHtml(r.dataset_name),
    (r) => escapeHtml(r.id),
    (r) => `<pre>${escapeHtml(JSON.stringify(r.json_data, null, 2))}</pre>`,
    (r) => escapeHtml(new Date(r.created_at).toLocaleString()),
  ]);
  updatePager();
  stopProgress(progress, `${total.toLocaleString()} matching records.`, total ? "success" : "info");
}

function clearSearch() {
  $("#search-form").reset();
  page = 1;
  total = 0;
  lastRows = [];
  $("#records-body").innerHTML = "";
  setText("#result-summary", "Run a search to load records.");
  updatePager();
}

function changePage(direction) {
  const nextPage = page + direction;
  if (nextPage < 1 || nextPage > totalPages()) return;
  page = nextPage;
  runSearch();
}

function updatePager() {
  const pages = totalPages();
  setText("#page-status", `Page ${page} of ${pages}`);
  setText("#result-summary", total ? `${total.toLocaleString()} results. Showing ${lastRows.length.toLocaleString()} on this page.` : "No records loaded.");
  $("#prev-page").disabled = page <= 1;
  $("#next-page").disabled = page >= pages;
}

function totalPages() {
  return Math.max(1, Math.ceil(total / pageSizeValue()));
}

function pageSizeValue() {
  return Math.min(Math.max(Number($("#page-size").value || 50), 1), 250);
}

function dateValue(selector, endOfDay = false) {
  const value = $(selector).value;
  if (!value) return null;
  return `${value}T${endOfDay ? "23:59:59" : "00:00:00"}`;
}

function exportJson() {
  if (!lastRows.length) return toast("Run a search before exporting.", "error");
  const blob = new Blob([JSON.stringify(lastRows, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "dataset-search-results.json";
  link.click();
  URL.revokeObjectURL(url);
}
