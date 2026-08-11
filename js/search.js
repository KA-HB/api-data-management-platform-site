import { requireAuth, renderShell } from "./auth.js?v=20260811a";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setButtonBusy, setText, startProgress, stopProgress, toast, updateProgress } from "./ui.js";

const profile = await requireAuth();
let lastRows = [];
let lastSummary = null;
let page = 1;
let total = 0;
let charts = new Map();
let activeSearchRun = 0;

if (profile) {
  renderShell(profile);
  await loadDatasetOptions();
  renderSearchSummary(null);
  $("#search-form")?.addEventListener("submit", runSearch);
  initSearchControls();
  $("#clear-search")?.addEventListener("click", clearSearch);
  $("#prev-page")?.addEventListener("click", () => changePage(-1));
  $("#next-page")?.addEventListener("click", () => changePage(1));
  $("#export-json")?.addEventListener("click", exportJson);
  document.addEventListener("themechange", () => renderSearchSummary(lastSummary));
  updatePager();
}

function initSearchControls() {
  $("#dataset")?.addEventListener("change", () => {
    page = 1;
    updateFilterStatus();
    if (hasActiveScope()) loadSearchSummary();
    else renderSearchSummary(null);
  });
  $("#page-size")?.addEventListener("change", () => {
    page = 1;
    updatePager();
  });
  $("#search-form")?.addEventListener("input", updateFilterStatus);
  document.querySelectorAll("[data-quick-term], [data-quick-job], [data-quick-service], [data-quick-month]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.quickTerm) $("#term").value = button.dataset.quickTerm;
      if (button.dataset.quickJob) $("#jobcode-filter").value = button.dataset.quickJob;
      if (button.dataset.quickService) $("#service-item-filter").value = button.dataset.quickService;
      if (button.dataset.quickMonth) setMonthRange(button.dataset.quickMonth);
      page = 1;
      updateFilterStatus();
      runSearch();
    });
  });
  updateFilterStatus();
}

async function loadDatasetOptions() {
  const { data, error } = await supabase.from("datasets").select("id,name").neq("name", "QuickBooks Time PTO").order("name");
  if (error) return toast(error.message, "error");
  $("#dataset").innerHTML = `<option value="">All authorized datasets</option>${(data || []).map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("")}`;
}

async function runSearch(event = null) {
  event?.preventDefault();
  page = event ? 1 : page;
  const payload = searchPayload();
  if (!hasActiveScope()) {
    renderSearchSummary(null);
    setText("#result-summary", "Choose a dataset or enter at least one filter before searching.");
    toast("Choose a dataset, keyword, date range, employee, job, service item, or exact field first.", "info");
    return;
  }
  if ((payload.exact_key && !payload.exact_value) || (!payload.exact_key && payload.exact_value)) {
    toast("Exact match needs both a source field and an exact value.", "error");
    return;
  }
  const button = event?.submitter || $("#run-search");
  const searchRun = ++activeSearchRun;
  const progress = startProgress("Searching experience records...");
  setButtonBusy(button, true, "Searching...");
  setText("#result-summary", "Searching matching experience records...");
  renderRows($("#records-body"), [{ loading: true }], [
    () => `<span class="muted">Searching...</span>`,
    () => `<span class="muted">Matching employee, job, service item, and hour fields.</span>`,
    () => "",
    () => "",
  ]);
  const pageSize = pageSizeValue();
  const basePayload = payload;
  const recordsPromise = callSearchAdvanced(basePayload, pageSize, (page - 1) * pageSize);
  const summaryPromise = callSearchSummary(basePayload);
  const { data, error } = await recordsPromise;
  if (searchRun !== activeSearchRun) return;
  if (error) {
    setButtonBusy(button, false);
    return stopProgress(progress, error.message, "error");
  }

  lastRows = data || [];
  total = Number(lastRows[0]?.total_count || 0);
  renderRows($("#records-body"), lastRows, [
    (r) => escapeHtml(r.dataset_name),
    (r) => renderRelevantFields(r),
    (r) => escapeHtml(recordDate(r)),
    (r) => renderRecordDetails(r),
  ]);
  updatePager();
  updateFilterStatus();
  updateProgress(progress, "Updating charts and totals...");

  const summary = await summaryPromise;
  if (searchRun !== activeSearchRun) return;
  setButtonBusy(button, false);
  if (summary.error) {
    stopProgress(progress, `${total.toLocaleString()} matching records loaded. Charts could not update: ${summary.error.message}`, "info");
    return;
  }
  total = Number(lastRows[0]?.total_count || summary.data?.unique_records || 0);
  updatePager();
  renderSearchSummary(summary.data);
  stopProgress(progress, `${total.toLocaleString()} unique matching records.`, total ? "success" : "info");
}

async function callSearchAdvanced(payload, pageSize, offset) {
  const fullPayload = { ...payload, limit_count: pageSize, offset_count: offset };
  const result = await supabase.rpc("experience_search_records", fullPayload);
  if (!isSchemaCacheError(result.error)) return result;
  return supabase.rpc("search_records_advanced", { ...legacySearchPayload(payload), limit_count: pageSize, offset_count: offset });
}

async function callSearchSummary(payload) {
  const result = await supabase.rpc("experience_search_summary", payload);
  if (!isSchemaCacheError(result.error)) return result;
  return supabase.rpc("search_records_summary", legacySearchPayload(payload));
}

function legacySearchPayload(payload) {
  const { p_start_date, p_end_date, ...legacy } = payload;
  return {
    ...legacy,
    start_date: p_start_date ? `${p_start_date}T00:00:00` : null,
    end_date: p_end_date ? `${p_end_date}T23:59:59` : null,
  };
}

function searchPayload() {
  return {
    dataset_uuid: $("#dataset").value || null,
    search_term: $("#term").value.trim() || null,
    exact_key: $("#exact-key").value.trim() || null,
    exact_value: $("#exact-value").value.trim() || null,
    p_start_date: dateValue("#start-date"),
    p_end_date: dateValue("#end-date"),
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
  updateFilterStatus();
  renderSearchSummary(null);
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

function hasActiveScope(payload = searchPayload()) {
  return Boolean(
    payload.dataset_uuid ||
    payload.search_term ||
    payload.exact_key ||
    payload.exact_value ||
    payload.p_start_date ||
    payload.p_end_date ||
    payload.user_filter ||
    payload.employee_filter ||
    payload.jobcode_filter ||
    payload.service_item_filter ||
    payload.status_filter ||
    payload.customer_filter
  );
}

function updateFilterStatus() {
  const payload = searchPayload();
  const active = [
    payload.dataset_uuid ? datasetName() : "",
    payload.search_term ? `keyword "${payload.search_term}"` : "",
    payload.employee_filter ? `employee "${payload.employee_filter}"` : "",
    payload.jobcode_filter ? `job "${payload.jobcode_filter}"` : "",
    payload.service_item_filter ? `service "${payload.service_item_filter}"` : "",
    payload.p_start_date || payload.p_end_date ? dateRangeLabel(payload.p_start_date, payload.p_end_date) : "",
    payload.exact_key && payload.exact_value ? `${payload.exact_key} = ${payload.exact_value}` : "",
  ].filter(Boolean);
  setText("#search-filter-status", active.length ? `Active scope: ${active.join(" | ")}` : "Showing all authorized data until filters are applied.");
}

function datasetName() {
  const option = $("#dataset")?.selectedOptions?.[0];
  return option?.value ? option.textContent : "";
}

function dateRangeLabel(start, end) {
  const from = start ? formatDateValue(start) : "earliest";
  const to = end ? formatDateValue(end) : "latest";
  return `${from} to ${to}`;
}

function setMonthRange(monthValue) {
  const [year, month] = monthValue.split("-").map(Number);
  if (!year || !month) return;
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  $("#start-date").value = start.toISOString().slice(0, 10);
  $("#end-date").value = end.toISOString().slice(0, 10);
}

function dateValue(selector) {
  const value = $(selector).value;
  if (!value) return null;
  return value;
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
  if (!hasActiveScope()) {
    renderSearchSummary(null);
    return;
  }
  const { data, error } = await callSearchSummary(searchPayload());
  if (error) return toast(error.message, "error");
  renderSearchSummary(data);
}

function renderSearchSummary(data = null) {
  lastSummary = data;
  if (!data) {
    setText("#search-unique-records", "-");
    setText("#search-raw-records", "-");
    setText("#search-datasets", "-");
    setText("#search-hours", "-");
    setText("#search-scope-summary", "Choose a dataset or apply a filter to load scoped search visuals.");
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
  const hours = hoursLabel(data);
  const fields = [
    ["Employee", employeeName(data)],
    ["Job/Project", jobPath(data) || cleanJobcodeLabel(fieldValue(data, ["jobcode_name", "name", "short_code", "project_id", "project_name"]))],
    ["Service", serviceItem(data)],
    ["Hours", hours],
    ["Status", fieldValue(data, ["state", "status"]) || activeLabel(data.active)],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  return fields.length
    ? `<div class="field-list">${fields.map(([label, value]) => `<span><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}</span>`).join("")}</div>`
    : `<span class="muted">No common fields found</span>`;
}

function renderRecordDetails(row) {
  const data = row.json_data || {};
  const preview = fieldValue(data, ["notes", "description", "memo"]) || jobPath(data) || serviceItem(data) || employeeName(data) || cleanJobcodeLabel(fieldValue(data, ["company_name", "name"])) || row.id;
  return `<div>${escapeHtml(preview)}</div><details><summary>Raw JSON</summary><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></details>`;
}

function recordDate(row) {
  const data = row.json_data || {};
  return formatDateValue(fieldValue(data, ["work_date", "local_date", "date", "start", "created"]) || row.created_at);
}

function jobPath(data) {
  return uniqueValues([
    cleanJobcodeLabel(fieldValue(data, ["jobcode_level1", "jobcode_1", "parent_jobcode_name"])),
    cleanJobcodeLabel(fieldValue(data, ["jobcode_level2", "jobcode_2"])),
    cleanJobcodeLabel(fieldValue(data, ["jobcode_level3", "jobcode_3", "jobcode_name", "name"])),
  ])
    .join(" / ");
}

function employeeName(data) {
  const direct = cleanDisplayName(fieldValue(data, ["employee_name", "display_name", "full_name", "name"]));
  const firstLast = cleanDisplayName([fieldValue(data, ["first_name", "fname"]), fieldValue(data, ["last_name", "lname"])].filter(Boolean).join(" "));
  return direct || firstLast || cleanDisplayName(fieldValue(data, ["username", "email"]));
}

function serviceItem(data) {
  return fieldValue(data, ["service_item", "service item", "service", "item", "item_name"]) || data.customfields?.["53105"];
}

function hoursLabel(data) {
  const rawHours = fieldValue(data, ["hours", "hours_worked", "decimal_hours", "total_hours"]);
  const numericHours = numericValue(rawHours);
  if (Number.isFinite(numericHours)) return `${numericHours.toLocaleString(undefined, { maximumFractionDigits: 2 })} hrs`;
  const duration = numericValue(fieldValue(data, ["duration", "time_seconds", "seconds"]));
  if (Number.isFinite(duration)) return `${roundHours(duration)} hrs`;
  return "";
}

function fieldValue(data, keys) {
  for (const key of keys) {
    const value = data?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function cleanDisplayName(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized === "Unassigned" || /^[0-9]+$/.test(normalized)) return "";
  return normalized;
}

function cleanJobcodeLabel(value) {
  const label = String(value || '').trim();
  if (!label || label === '0' || /^[0-9]+$/.test(label)) return '';
  return label;
}

function uniqueValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized.toLowerCase())) return false;
    seen.add(normalized.toLowerCase());
    return true;
  });
}

function numericValue(value) {
  if (value === undefined || value === null || value === "") return NaN;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/,/g, "").trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function formatDateValue(value) {
  if (!value) return "-";
  const raw = String(value).trim();
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    const [year, month, day] = isoMatch[1].split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString();
  }
  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    const year = Number(slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3]);
    return new Date(year, month - 1, day).toLocaleDateString();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleDateString();
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
  const dark = document.documentElement.dataset.theme === "dark";
  const axisColor = dark ? "#b8c2d6" : "#475467";
  const gridColor = dark ? "rgba(184, 194, 214, .18)" : "#eef2f7";
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
        x: { beginAtZero: isBar, ticks: { maxRotation: 0, autoSkip: true, color: axisColor }, grid: { display: false } },
        y: { beginAtZero: !isBar, ticks: { color: axisColor, callback: isBar ? shortTick : numberTick }, grid: { color: gridColor } },
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
