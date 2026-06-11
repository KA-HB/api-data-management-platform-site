import { requireAuth, renderShell } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setButtonBusy, setText, startProgress, stopProgress, toast } from "./ui.js";

const profile = await requireAuth();
let lastRows = [];
let page = 1;
let total = 0;
let charts = new Map();

if (profile) {
  renderShell(profile);
  await loadDatasetOptions();
  await loadSearchSummary();
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
  const basePayload = searchPayload();
  const [{ data, error }, summary] = await Promise.all([
    callSearchAdvanced(basePayload, pageSize, (page - 1) * pageSize),
    callSearchSummary(basePayload),
  ]);
  setButtonBusy(button, false);
  if (error) return stopProgress(progress, error.message, "error");

  lastRows = data || [];
  total = Number(lastRows[0]?.total_count || summary.data?.unique_records || 0);
  renderRows($("#records-body"), lastRows, [
    (r) => escapeHtml(r.dataset_name),
    (r) => renderRelevantFields(r),
    (r) => escapeHtml(recordDate(r)),
    (r) => renderRecordDetails(r),
  ]);
  updatePager();
  renderSearchSummary(summary.data);
  const summaryNote = summary.data ? "unique matching records" : "matching records";
  stopProgress(progress, `${total.toLocaleString()} ${summaryNote}.`, total ? "success" : "info");
}

async function callSearchAdvanced(payload, pageSize, offset) {
  const fullPayload = { ...payload, limit_count: pageSize, offset_count: offset };
  const result = await supabase.rpc("search_records_advanced", fullPayload);
  if (!isSchemaCacheError(result.error)) return result;
  if (payload.service_item_filter) {
    return { data: null, error: { message: "Service item filtering requires the latest Supabase search migration." } };
  }
  return supabase.rpc("search_records_advanced", { ...legacySearchPayload(payload), limit_count: pageSize, offset_count: offset });
}

async function callSearchSummary(payload) {
  const result = await supabase.rpc("search_records_summary", payload);
  if (!isSchemaCacheError(result.error)) return result;
  return { data: null, error: null };
}

function legacySearchPayload(payload) {
  const { service_item_filter, ...legacy } = payload;
  return legacy;
}

function searchPayload() {
  return {
    dataset_uuid: $("#dataset").value || null,
    search_term: $("#term").value.trim() || null,
    exact_key: $("#exact-key").value.trim() || null,
    exact_value: $("#exact-value").value.trim() || null,
    start_date: dateValue("#start-date"),
    end_date: dateValue("#end-date", true),
    user_filter: $("#user-filter").value.trim() || null,
    employee_filter: $("#employee-filter").value.trim() || null,
    jobcode_filter: $("#jobcode-filter").value.trim() || null,
    service_item_filter: $("#service-item-filter").value.trim() || null,
    status_filter: $("#status-filter").value.trim() || null,
    customer_filter: $("#customer-filter").value.trim() || null,
    sort_field: $("#sort-field").value,
    sort_direction: $("#sort-direction").value,
  };
}

function clearSearch() {
  $("#search-form").reset();
  page = 1;
  total = 0;
  lastRows = [];
  $("#records-body").innerHTML = "";
  setText("#result-summary", "Run a search to load records.");
  updatePager();
  loadSearchSummary();
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

async function loadSearchSummary() {
  const { data, error } = await callSearchSummary(searchPayload());
  if (error) return toast(error.message, "error");
  renderSearchSummary(data);
}

function renderSearchSummary(data = null) {
  if (!data) {
    setText("#search-unique-records", "-");
    setText("#search-raw-records", "-");
    setText("#search-datasets", "-");
    setText("#search-hours", "-");
    setText("#search-scope-summary", "Search visuals require the latest Supabase search migration. Record search still works with the current database functions.");
    renderChart("#search-records-by-dataset", "bar", [], "name", "records", "Unique Records");
    renderChart("#search-records-over-time", "line", [], "date", "records", "Unique Records");
    return;
  }
  setText("#search-unique-records", formatNumber(data.unique_records));
  setText("#search-raw-records", formatNumber(data.raw_records));
  setText("#search-datasets", formatNumber(data.dataset_count));
  setText("#search-hours", formatNumber(data.hours));
  setText("#search-scope-summary", scopeSummary(data));
  renderChart("#search-records-by-dataset", "bar", data.records_by_dataset || [], "name", "records", "Unique Records");
  renderChart("#search-records-over-time", "line", data.records_by_day || [], "date", "records", "Unique Records");
}

function renderRelevantFields(row) {
  const data = row.json_data || {};
  const hours = data.hours !== undefined ? `${formatNumber(data.hours)} hrs` : data.duration ? `${roundHours(data.duration)} hrs` : "";
  const fields = [
    ["Employee", data.employee_name || employeeName(data)],
    ["Job/Project", jobPath(data) || data.name || data.jobcode_id || data.project_id],
    ["Service", data.service_item || data.customfields?.["53105"] || data["service item"]],
    ["Hours", hours],
    ["Status", data.state || data.status || activeLabel(data.active)],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  return fields.length
    ? `<div class="field-list">${fields.map(([label, value]) => `<span><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}</span>`).join("")}</div>`
    : `<span class="muted">No common fields found</span>`;
}

function renderRecordDetails(row) {
  const data = row.json_data || {};
  const preview = data.notes || data.description || jobPath(data) || data.email || data.username || data.company_name || data.name || data.id || row.id;
  return `<div>${escapeHtml(preview)}</div><details><summary>Raw JSON</summary><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></details>`;
}

function recordDate(row) {
  const data = row.json_data || {};
  const value = data.work_date || data.local_date || data.date || data.start || data.created || row.created_at;
  return value ? new Date(String(value).slice(0, 10)).toLocaleDateString() : "-";
}

function jobPath(data) {
  return [data.jobcode_level1 || data.jobcode_1, data.jobcode_level2 || data.jobcode_2, data.jobcode_level3 || data.jobcode_3 || data.jobcode_name]
    .filter(Boolean)
    .join(" / ");
}

function employeeName(data) {
  return [data.first_name || data.fname, data.last_name || data.lname].filter(Boolean).join(" ") || data.display_name || data.username || data.email || data.user_id;
}

function activeLabel(value) {
  if (typeof value !== "boolean") return "";
  return value ? "Active" : "Inactive";
}

function roundHours(seconds) {
  return (Number(seconds || 0) / 3600).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function scopeSummary(data) {
  const scope = data.dataset_name || "All authorized datasets";
  const duplicates = Number(data.duplicates_removed || 0);
  const duplicateText = duplicates ? `${formatNumber(duplicates)} duplicate rows excluded.` : "No duplicate rows found.";
  return `${scope}: ${formatNumber(data.unique_records)} unique records from ${formatNumber(data.raw_records)} raw rows. ${duplicateText}`;
}

function renderChart(selector, type, rows, labelKey, valueKey, label) {
  const canvas = $(selector);
  if (!canvas || !window.Chart) return;
  charts.get(selector)?.destroy();
  const context = canvas.getContext("2d");
  const dataRows = rows?.length ? rows : [{ [labelKey]: "No data", [valueKey]: 0 }];
  const isBar = type === "bar";
  charts.set(selector, new Chart(context, {
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
      indexAxis: isBar ? "y" : "x",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: isBar, ticks: { maxRotation: 0, autoSkip: true, color: "#475467" }, grid: { display: false } },
        y: { beginAtZero: !isBar, ticks: { color: "#475467", callback: isBar ? shortTick : numberTick }, grid: { color: "#eef2f7" } },
      },
    },
  }));
}

function shortTick(value) {
  const label = this.getLabelForValue ? this.getLabelForValue(value) : String(value);
  return label.length > 28 ? `${label.slice(0, 25)}...` : label;
}

function numberTick(value) {
  return Number(value || 0).toLocaleString();
}

function isSchemaCacheError(error) {
  return /schema cache|could not find the function/i.test(error?.message || "");
}
