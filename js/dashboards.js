import { requireAuth, renderShell } from "./auth.js";
import { FUNCTIONS_BASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setButtonBusy, setText, startProgress, stopProgress, toast } from "./ui.js";

const profile = await requireAuth();
const charts = new Map();
let qbFilterOptions = emptyQbFilterOptions();
let availableDatasets = [];
let lastSummary = null;
let lastGeneralCoverage = null;
const RAW_ROLLUP_BATCH_SIZE = 1000;
const FILTER_OPTION_BATCH_SIZE = 1000;
const FILTER_OPTION_SCAN_LIMIT = 100000;
const FILTER_OPTION_CACHE_TTL_MS = 10 * 60 * 1000;
const EXCLUDED_ADMIN_JOBCODE_PATTERN = /(^|[\s\-_:/])(?:pto|sick|holiday|overhead)(?=$|[\s\-_:/])/i;
const AUTOMATIC_RAW_ROLLUP_FALLBACK = readBooleanFlag("data-platform-raw-rollup-fallback");

function readBooleanFlag(key) {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function emptyQbFilterOptions() {
  return {
    employees: [],
    jobcode_level1: [],
    jobcode_level2: [],
    jobcode_level3: [],
    service_items: [],
  };
}

if (profile) {
  renderShell(profile);
  await loadDatasets();
  await loadDashboard();
  $("#project-experience-lookup")?.addEventListener("submit", searchProjectExperience);
  $("#clear-project-experience")?.addEventListener("click", clearProjectExperienceLookup);
  $("#dashboard-qb-sync")?.addEventListener("click", syncQuickBooksTime);

  if (profile.role === "admin") {
    $("#qb-viz-filters")?.addEventListener("submit", applyQbFilters);
    $("#clear-qb-filters")?.addEventListener("click", clearQbFilters);
    $("#filter-dataset")?.addEventListener("change", () => {
      updateDatasetIndicator();
      loadQbVisuals();
    });
    $("#filter-employee")?.addEventListener("change", loadQbVisuals);
    $("#filter-employee")?.addEventListener("input", debounce(loadQbVisuals, 350));
    $("#filter-start")?.addEventListener("change", loadQbVisuals);
    $("#filter-end")?.addEventListener("change", loadQbVisuals);
    $("#filter-service-item")?.addEventListener("change", loadQbVisuals);
    $("#filter-jobcode-1")?.addEventListener("change", () => {
      refreshDependentJobFilters();
      loadQbVisuals();
    });
    $("#filter-jobcode-2")?.addEventListener("change", () => {
      refreshDependentJobFilters();
      loadQbVisuals();
    });
    $("#filter-jobcode-3")?.addEventListener("change", loadQbVisuals);
    $("#filter-keyword")?.addEventListener("input", debounce(loadQbVisuals, 350));
  }
}

async function loadDatasets() {
  const { data, error } = await supabase
    .from("datasets")
    .select("id,name,source_type,record_count,updated_at")
    .neq("name", "QuickBooks Time PTO")
    .order("name");
  if (error) return toast(error.message, "error");

  availableDatasets = data || [];
  const select = $("#filter-dataset");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">All authorized datasets</option>${availableDatasets.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)} (${formatNumber(row.record_count)} records)</option>`).join("")}`;
  if (current && availableDatasets.some((row) => row.id === current)) select.value = current;
  updateDatasetIndicator();
}

async function loadDashboard() {
  const progress = startProgress("Loading dashboard data...");
  try {
    const [{ data: summary, error }, { data: logs }, qbOptions] = await Promise.all([
      supabase.rpc("dashboard_summary"),
      supabase.from("activity_logs").select("action,details,created_at").order("created_at", { ascending: false }).limit(8),
      supabase.rpc("dashboard_qbtime_filter_options"),
    ]);

    if (error) return stopProgress(progress, error.message, "error");

    lastSummary = summary;
    const rpcFilterOptions = normalizeFilterOptions(qbOptions?.data);
    const rawServiceItemOptionsPromise = loadRawServiceItemOptions();
    const jobcodeReferenceOptions = await loadJobcodeReferenceOptions();
    qbFilterOptions = mergeFilterOptions(rpcFilterOptions, jobcodeReferenceOptions);
    populateQbFilters(qbFilterOptions);

    const experience = await callQbRollups(emptyQbPayload(), { allowDeltaFallback: false, allowJobcodeRebuild: false });
    lastGeneralCoverage = experience.data ? normalizeExperienceRollup(experience.data) : buildFastCoverageSummary(summary);
    qbFilterOptions = mergeFilterOptions(qbFilterOptions, buildFilterOptionsFromRollup(lastGeneralCoverage));
    populateQbFilters(qbFilterOptions);
    if (qbOptions?.error) {
      console.warn("Dashboard filter options RPC failed; using dashboard rollup fallback.", qbOptions.error.message);
    }
    renderGeneralDashboard(summary, lastGeneralCoverage);
    stopProgress(progress);

    if (profile.role === "admin" && $("#qb-viz-filters")) {
      const normalized = normalizeExperienceRollup(lastGeneralCoverage);
      setText("#qb-filter-summary", `${formatNumber(normalized.filtered_timesheets)} experience records, ${formatNumber(normalized.filtered_hours)} hours${dateRangeLabel(normalized)}`);
    }

    renderRecentUploads(isExperienceDashboard() ? summary.recent_uploads || [] : [...availableDatasets].sort((a, b) => Number(b.record_count || 0) - Number(a.record_count || 0)));
    renderRecentSyncs(summary.recent_syncs || []);
    renderRecentLogs(logs || []);
    hydrateServiceItemOptions(rawServiceItemOptionsPromise);
  } catch (error) {
    stopProgress(progress, `Error loading dashboard: ${error.message}`, "error");
  }
}

function renderGeneralDashboard(summary, coverage) {
  const hasNoUserDatasets = profile.role !== "admin" && numeric(summary?.datasets) === 0;
  setText("#metric-datasets", formatNumber(summary?.datasets));
  setText("#metric-keys", formatNumber(summary?.api_keys));
  setText("#metric-raw-records", formatNumber(coverage?.raw_records ?? summary?.records));
  setText("#metric-records", formatNumber(coverage?.unique_records ?? summary?.records));
  setText("#metric-hours", formatNumber(coverage?.filtered_hours ?? coverage?.hours));
  setText("#metric-employees", formatNumber(coverage?.filtered_employees ?? coverage?.employee_count));
  setText("#metric-services", formatNumber(coverage?.filtered_service_items ?? coverage?.service_item_count));
  setText("#data-scope-summary", hasNoUserDatasets ? "No dashboard datasets are assigned to this user yet. An admin can grant QuickBooks Time dashboard access from User Management." : coverage ? scopeSummary(coverage) : `Showing ${formatNumber(summary?.records)} authorized records. Full-year hours, employees, service-item totals, and duplicate removal require the latest Supabase search migration.`);

  renderChart("#records-by-dataset", "bar", coverage?.records_by_dataset || summary?.records_by_dataset || [], "name", coverage ? "records" : "record_count", coverage ? "Unique Records" : "Records");
  renderChart("#records-over-time", "line", coverage?.records_by_day || summary?.records_by_day || [], "date", "records", coverage ? "Unique Records" : "Records");
  renderChart("#activity-over-time", "line", summary?.activity_by_day || [], "date", "events", "Events");
  renderExperienceOverview(coverage || {});
}

function buildFastCoverageSummary(summary) {
  const rows = availableDatasets.length ? availableDatasets : summary?.recent_uploads || [];
  const nonPtoRows = rows.filter((row) => !/pto/i.test(row.name || ""));
  const rawRecords = nonPtoRows.reduce((total, row) => total + numeric(row.record_count), 0);
  return {
    is_fast_fallback: true,
    raw_records: rawRecords || summary?.records || 0,
    unique_records: rawRecords || summary?.records || 0,
    duplicates_removed: null,
    dataset_count: nonPtoRows.length || summary?.datasets || 0,
    employee_count: 0,
    service_item_count: 0,
    hours: 0,
    filtered_employees: 0,
    filtered_service_items: 0,
    filtered_hours: 0,
    records_by_dataset: nonPtoRows.map((row) => ({ name: row.name, records: numeric(row.record_count) })).sort((a, b) => b.records - a.records),
    records_by_day: summary?.records_by_day || [],
  };
}

function isExperienceDashboard() {
  return Boolean($("#qb-viz-filters"));
}

async function applyQbFilters(event) {
  event.preventDefault();
  updateDatasetIndicator();
  await loadQbVisuals();
}

async function loadQbVisuals() {
  const payload = qbFilterPayload();
  if (payload.jobcode_level2_filter && !payload.jobcode_level1_filter && !payload.jobcode_level3_filter) {
    toast("Job Code 2 selected without Job Code 1. Results may be limited.", "info");
  }

  const progress = startProgress("Updating experience charts...");
  const experience = await callQbRollups(payload);
  const { data, error } = experience;
  if (error) {
    clearQbVisuals();
    return stopProgress(progress, error.message, "error");
  }

  stopProgress(progress);
  const normalized = normalizeExperienceRollup(data);
  renderChart("#hours-by-employee", "bar", normalized.hours_by_employee, "employee", "hours", "Hours");
  renderChart("#hours-by-jobcode", "bar", normalized.hours_by_jobcode, "jobcode", "hours", "Hours");
  renderChart("#hours-by-service-item", "bar", normalized.hours_by_service_item, "service_item", "hours", "Hours");
  renderChart("#hours-over-time", "line", normalized.hours_by_day, "date", "hours", "Hours");
  renderChart("#records-by-dataset", "bar", normalized.records_by_dataset || [], "name", "records", "Unique Records");
  renderChart("#records-over-time", "line", normalized.records_by_day || [], "date", "records", "Unique Records");

  setText("#metric-raw-records", formatNumber(normalized.raw_records ?? normalized.filtered_timesheets));
  setText("#metric-records", formatNumber(normalized.unique_records ?? normalized.filtered_timesheets));
  setText("#metric-hours", formatNumber(normalized.filtered_hours));
  setText("#metric-employees", formatNumber(normalized.filtered_employees));
  setText("#metric-services", formatNumber(normalized.filtered_service_items));
  setText("#qb-filter-summary", `${formatNumber(normalized.filtered_timesheets)} experience records, ${formatNumber(normalized.filtered_hours)} hours${dateRangeLabel(normalized)}`);
  setText("#data-scope-summary", scopeSummary(normalized));

  renderEmployeeExperience(normalized.employee_experience);
  renderExperienceDetail(normalized.experience_rows);
}

function clearQbVisuals() {
  setText("#metric-records", "-");
  setText("#metric-hours", "-");
  setText("#metric-employees", "-");
  setText("#metric-services", "-");
  setText("#qb-filter-summary", "No dataset-specific stats loaded");
  setText("#employee-experience-summary", "No matching employees");
  setText("#experience-detail-summary", "No matching experience rows");
  renderRows($("#employee-experience-body"), [], [() => ""]);
  renderRows($("#experience-detail-body"), [], [() => ""]);
}

async function searchProjectExperience(event) {
  event.preventDefault();
  const employee = $("#project-employee")?.value.trim() || "";
  const jobcode1 = $("#project-jobcode-1")?.value.trim() || "";
  const jobcode2 = $("#project-jobcode-2")?.value.trim() || "";
  if (!employee && !jobcode1 && !jobcode2) {
    toast("Enter an employee, Job Code 1, or Job Code 2 to search project experience.", "info");
    return;
  }

  setProjectLookupLoading();
  const payload = normalizeDerivedJobcodePayload({
    ...emptyQbPayload(),
    employee_filter: employee || null,
    jobcode_level1_filter: jobcode1 || null,
    jobcode_level2_filter: jobcode2 || null,
  });
  const { data, error } = await callQbRollups(payload);
  if (error) {
    setText("#project-experience-summary", error.message);
    renderProjectExperience([]);
    return;
  }
  const normalized = normalizeExperienceRollup(data);
  renderProjectSummary(normalized, { employee, jobcode1, jobcode2 });
  renderProjectExperience(normalized.experience_rows);
}

function clearProjectExperienceLookup() {
  $("#project-experience-lookup")?.reset();
  setText("#project-experience-summary", "Search by project/job code and optionally narrow to one employee.");
  setText("#project-metric-hours", "-");
  setText("#project-metric-employees", "-");
  setText("#project-metric-entries", "-");
  setText("#project-metric-range", "-");
  renderProjectExperience([]);
}

function setProjectLookupLoading() {
  setText("#project-experience-summary", "Searching authorized experience data...");
  setText("#project-metric-hours", "...");
  setText("#project-metric-employees", "...");
  setText("#project-metric-entries", "...");
  setText("#project-metric-range", "...");
  renderRows($("#project-experience-body"), [], [() => ""]);
}

function renderProjectSummary(data, filters) {
  const parts = [
    filters.employee ? `employee "${filters.employee}"` : null,
    filters.jobcode1 ? `Job Code 1 "${filters.jobcode1}"` : null,
    filters.jobcode2 ? `Job Code 2 "${filters.jobcode2}"` : null,
  ].filter(Boolean);
  const scope = parts.length ? parts.join(", ") : "all authorized experience";
  setText("#project-experience-summary", `${formatNumber(data.filtered_timesheets)} matching entries for ${scope}.`);
  setText("#project-metric-hours", formatNumber(data.filtered_hours));
  setText("#project-metric-employees", formatNumber(data.filtered_employees));
  setText("#project-metric-entries", formatNumber(data.filtered_timesheets));
  setText("#project-metric-range", data.date_start || data.date_end ? `${formatDate(data.date_start)} - ${formatDate(data.date_end)}` : "-");
}

function renderProjectExperience(rows) {
  const sortedRows = [...(rows || [])].sort((a, b) => numeric(b.hours) - numeric(a.hours)).slice(0, 100);
  renderRows($("#project-experience-body"), sortedRows, [
    (r) => escapeHtml(r.employee),
    (r) => escapeHtml(detailJobcodeLabel(r, 1)),
    (r) => escapeHtml(detailJobcodeLabel(r, 2)),
    (r) => escapeHtml(displayServiceLabel(r.service_item)),
    (r) => formatNumber(r.hours),
    (r) => formatNumber(r.timesheets),
    (r) => formatDate(r.first_work),
    (r) => formatDate(r.last_work),
  ]);
}

async function callQbRollups(payload, options = {}) {
  const result = await callQbRollupOnce(payload);
  const hasJobcodeFilter = Boolean(payload._derived_jobcode_filter || payload.jobcode_level1_filter || payload.jobcode_level2_filter || payload.jobcode_level3_filter);
  const fallbackOptions = { ...options, forceRawRebuild: options.forceRawRebuild || hasJobcodeFilter };
  const rawFallback = await rawQbRollupFallback(payload, result.data, result.error, fallbackOptions);
  if (rawFallback) return rawFallback;
  if (!shouldExpandJobcodeFilter(payload, result.data, result.error)) return result;

  const expandedPayloads = expandedJobcodePayloads(payload);
  if (!expandedPayloads.length) return result;

  const expandedResults = await callExpandedQbRollups(expandedPayloads);
  const expandedRawFallback = await rawQbRollupFallback(payload, expandedResults.data, expandedResults.error, fallbackOptions);
  if (expandedRawFallback) return expandedRawFallback;
  if (expandedResults.error) return result;
  if (!numeric(expandedResults.data?.filtered_timesheets)) return result;
  return expandedResults;
}

async function callQbRollupOnce(payload) {
  const rpcPayload = rpcSafePayload(payload);
  const result = await supabase.rpc("dashboard_qbtime_rollups", rpcPayload);
  if (!isSchemaCacheError(result.error)) return result;
  if (rpcPayload.dataset_uuid) {
    return { data: null, error: { message: "Dataset-specific dashboard filtering requires the latest Supabase dashboard migration." } };
  }
  const legacyPayload = { ...rpcPayload };
  delete legacyPayload.dataset_uuid;
  const legacyResult = await supabase.rpc("dashboard_qbtime_rollups", legacyPayload);
  if (!isSchemaCacheError(legacyResult.error)) return legacyResult;
  delete legacyPayload.keyword_filter;
  return supabase.rpc("dashboard_qbtime_rollups", legacyPayload);
}

function rpcSafePayload(payload) {
  return Object.fromEntries(Object.entries(payload || {}).filter(([key]) => !key.startsWith("_")));
}

function shouldExpandJobcodeFilter(payload, data, error) {
  if (error) return false;
  const hasJobcodeFilter = Boolean(payload.jobcode_level1_filter || payload.jobcode_level2_filter || payload.jobcode_level3_filter);
  return hasJobcodeFilter && numeric(data?.filtered_timesheets) === 0;
}

async function callExpandedQbRollups(payloads) {
  const results = [];
  for (let index = 0; index < payloads.length; index += 8) {
    const batch = payloads.slice(index, index + 8);
    const settled = await Promise.all(batch.map((payload) => callQbRollupOnce(payload)));
    const errorResult = settled.find((result) => result.error);
    if (errorResult) return errorResult;
    results.push(...settled.map((result) => result.data).filter(Boolean));
  }
  return { data: mergeQbRollupData(results), error: null };
}

function expandedJobcodePayloads(payload) {
  if (!qbFilterOptions) return [];
  const base = { ...payload, jobcode_level1_filter: null, jobcode_level2_filter: null, jobcode_level3_filter: null };
  const level2Rows = qbFilterOptions.jobcode_level2 || [];
  const level3Rows = qbFilterOptions.jobcode_level3 || [];
  const payloads = new Map();

  const addPayload = (levelKey, rowOrValue) => {
    const value = typeof rowOrValue === "object" ? rowOrValue?.id : rowOrValue;
    const filter = String(value || "").trim();
    if (!filter) return;
    const nextPayload = { ...base, [levelKey]: filter };
    payloads.set(`${levelKey}:${filter}`, nextPayload);
  };

  if (payload.jobcode_level3_filter) {
    for (const row of matchingRows(level3Rows, payload.jobcode_level3_filter)) addPayload("jobcode_level3_filter", row);
    if (!payloads.size) addPayload("jobcode_level3_filter", payload.jobcode_level3_filter);
    return Array.from(payloads.values());
  }

  if (payload.jobcode_level2_filter) {
    const children = level3Rows.filter((row) => optionMatches(row, payload.jobcode_level2_filter, ["parent_id", "parent_name"]));
    for (const row of children) addPayload("jobcode_level3_filter", row);
    for (const row of matchingRows(level2Rows, payload.jobcode_level2_filter)) addPayload("jobcode_level2_filter", row);
    if (!payloads.size) addPayload("jobcode_level2_filter", payload.jobcode_level2_filter);
    return Array.from(payloads.values());
  }

  if (payload.jobcode_level1_filter) {
    const children = level2Rows.filter((row) => optionMatches(row, payload.jobcode_level1_filter, ["parent_id", "parent_name"]));
    const descendants = level3Rows.filter((row) => optionMatches(row, payload.jobcode_level1_filter, ["grandparent_id", "grandparent_name"]));
    for (const row of children) addPayload("jobcode_level2_filter", row);
    for (const row of descendants) addPayload("jobcode_level3_filter", row);
    if (!payloads.size) addPayload("jobcode_level1_filter", payload.jobcode_level1_filter);
  }

  return Array.from(payloads.values());
}

function matchingRows(rows, value) {
  return rows.filter((row) => optionMatches(row, value, ["id", "name"]));
}

function optionMatches(row, value, keys) {
  const selected = String(value || "").trim();
  return Boolean(selected && keys.some((key) => String(row?.[key] || "").trim() === selected));
}

function mergeQbRollupData(results) {
  const merged = {
    hours_by_employee: mergeRows(results, "hours_by_employee", (row) => row.employee, {
      hours: "sum",
      timesheets: "sum",
    }),
    hours_by_jobcode: mergeRows(results, "hours_by_jobcode", (row) => projectLabel(row.jobcode), {
      hours: "sum",
    }).map((row) => ({ jobcode: row.key, hours: row.hours })),
    hours_by_service_item: mergeRows(results, "hours_by_service_item", (row) => row.service_item, {
      hours: "sum",
    }),
    hours_by_day: mergeRows(results, "hours_by_day", (row) => row.date, {
      hours: "sum",
    }),
    records_by_dataset: mergeRows(results, "records_by_dataset", (row) => row.name, {
      records: "sum",
    }),
    records_by_day: mergeRows(results, "records_by_day", (row) => row.date, {
      records: "sum",
    }),
    experience_rows: mergeExperienceRows(results),
  };

  merged.employee_experience = mergeEmployeeExperience(results);
  merged.filtered_timesheets = sumResults(results, "filtered_timesheets");
  merged.filtered_hours = roundValue(sumResults(results, "filtered_hours"));
  merged.filtered_employees = distinctValues(merged.employee_experience, "employee").length;
  merged.filtered_service_items = distinctValues(merged.hours_by_service_item, "service_item").filter((name) => name && name !== "No service item").length;
  merged.filtered_jobcodes = distinctValues(merged.experience_rows, "jobcode").filter(isDisplayJobcodeLabel).length || distinctValues(merged.hours_by_jobcode, "jobcode").filter(isDisplayJobcodeLabel).length;
  merged.raw_records = sumResults(results, "raw_records") || merged.filtered_timesheets;
  merged.unique_records = sumResults(results, "unique_records") || merged.filtered_timesheets;
  merged.duplicates_removed = sumResults(results, "duplicates_removed");
  merged.dataset_count = Math.max(...results.map((data) => numeric(data.dataset_count)), 0);
  merged.date_start = minDate(results.map((data) => data.date_start));
  merged.date_end = maxDate(results.map((data) => data.date_end));

  merged.hours_by_employee = limitRows(merged.hours_by_employee, "hours", 15);
  merged.hours_by_jobcode = limitRows(merged.hours_by_jobcode, "hours", 15);
  merged.hours_by_service_item = limitRows(merged.hours_by_service_item, "hours", 15);
  merged.records_by_dataset = limitRows(merged.records_by_dataset, "records", 12);
  merged.employee_experience = limitRows(merged.employee_experience, "hours", 50);
  merged.experience_rows = limitRows(merged.experience_rows, "hours", 100);
  return merged;
}

function mergeRows(results, property, keyFn, numericFields) {
  const rows = new Map();
  for (const data of results) {
    for (const row of data?.[property] || []) {
      const key = String(keyFn(row) || "").trim() || "Unassigned";
      const current = rows.get(key) || { ...row, key };
      for (const [field, mode] of Object.entries(numericFields)) {
        if (mode === "sum") current[field] = roundValue(numeric(current[field]) + numeric(row[field]));
      }
      rows.set(key, current);
    }
  }
  return Array.from(rows.values());
}

function mergeEmployeeExperience(results) {
  const rows = mergeRows(results, "employee_experience", (row) => row.employee, {
    hours: "sum",
    timesheets: "sum",
  });
  for (const row of rows) {
    const matches = results.flatMap((data) => data?.experience_rows || []).filter((detail) => detail.employee === row.employee);
    row.jobcodes = distinctValues(matches, "jobcode").filter((value) => value && value !== "Unassigned").length || numeric(row.jobcodes);
    row.service_items = distinctValues(matches, "service_item").filter((value) => value && value !== "No service item").length || numeric(row.service_items);
    row.first_work = minDate(matches.map((detail) => detail.first_work).concat(row.first_work));
    row.last_work = maxDate(matches.map((detail) => detail.last_work).concat(row.last_work));
  }
  return rows;
}

function mergeExperienceRows(results) {
  const rows = new Map();
  for (const data of results) {
    for (const row of data?.experience_rows || []) {
      const key = [
        row.employee,
        row.jobcode_level1,
        row.jobcode_level2,
        row.jobcode_level3,
        row.jobcode,
        row.service_item,
      ].map((value) => String(value || "").trim()).join("|");
      const current = rows.get(key) || { ...row, hours: 0, timesheets: 0 };
      current.hours = roundValue(numeric(current.hours) + numeric(row.hours));
      current.timesheets = numeric(current.timesheets) + numeric(row.timesheets);
      current.first_work = minDate([current.first_work, row.first_work]);
      current.last_work = maxDate([current.last_work, row.last_work]);
      rows.set(key, current);
    }
  }
  return Array.from(rows.values());
}

function sumResults(results, key) {
  return roundValue(results.reduce((total, data) => total + numeric(data?.[key]), 0));
}

function limitRows(rows, sortKey, limit) {
  return [...rows].sort((a, b) => numeric(b[sortKey]) - numeric(a[sortKey])).slice(0, limit);
}

function roundValue(value) {
  return Math.round(numeric(value) * 100) / 100;
}

function minDate(values) {
  const dates = values.filter(Boolean).sort();
  return dates[0] || null;
}

function maxDate(values) {
  const dates = values.filter(Boolean).sort();
  return dates[dates.length - 1] || null;
}

async function rawQbRollupFallback(payload, cachedData, cachedError, options = {}) {
  if (cachedError || !availableDatasets.length) return null;
  const allowDeltaFallback = options.allowDeltaFallback ?? AUTOMATIC_RAW_ROLLUP_FALLBACK;
  const allowJobcodeRebuild = options.allowJobcodeRebuild ?? AUTOMATIC_RAW_ROLLUP_FALLBACK;
  const forceRawRebuild = Boolean(options.forceRawRebuild);
  const rebuildForBadJobcodes = forceRawRebuild || (allowJobcodeRebuild && hasPoorJobcodeCoverage(cachedData));
  if (!allowDeltaFallback && !rebuildForBadJobcodes) return null;
  const timesheetDatasets = rawTimesheetDatasets(payload);
  if (!timesheetDatasets.length) return null;
  const cachedEnd = cachedData?.date_end;
  if (!rebuildForBadJobcodes && !cachedEnd) return null;
  if (!rebuildForBadJobcodes && cachedEnd && payload.end_date && String(payload.end_date) <= String(cachedEnd)) return null;
  if (!rebuildForBadJobcodes && cachedEnd && !(await hasNewerRawTimesheets(timesheetDatasets, cachedEnd))) return null;

  try {
    const fallbackPayload = rebuildForBadJobcodes ? payload : deltaFallbackPayload(payload, cachedEnd);
    if (fallbackPayload.start_date && fallbackPayload.end_date && String(fallbackPayload.start_date) > String(fallbackPayload.end_date)) return null;
    const [employeeRows, jobcodeRows, timesheetRows] = await Promise.all([
      fetchRawDatasetRows("QuickBooks Time Employees", "id,json_data"),
      fetchRawDatasetRows("QuickBooks Time Job Codes", "id,json_data"),
      fetchRawTimesheetRows(timesheetDatasets, fallbackPayload),
    ]);
    if (!timesheetRows.length) return null;
    const deltaRollup = buildRawQbRollup(timesheetRows, employeeRows, jobcodeRows, fallbackPayload, timesheetDatasets);
    const data = cachedData && cachedEnd && !rebuildForBadJobcodes
      ? mergeQbRollupData([cachedData, deltaRollup])
      : deltaRollup;
    data.is_raw_delta_fallback = Boolean(cachedData && cachedEnd && !rebuildForBadJobcodes);
    data.is_raw_rebuild_fallback = rebuildForBadJobcodes;
    return { data, error: null };
  } catch (error) {
    console.warn("Raw QuickBooks Time dashboard fallback failed", error);
    return null;
  }
}

function hasPoorJobcodeCoverage(data) {
  if (!data) return false;
  const detailRows = data.experience_rows || [];
  const jobRows = data.hours_by_jobcode || [];
  const hasActivity = numeric(data.filtered_timesheets) > 0 || numeric(data.filtered_hours) > 0;
  if (hasActivity && !detailRows.length && !jobRows.length) return true;
  const badDetailRows = detailRows.filter((row) => !cleanJobcodeLabel(row.jobcode_level1) || !cleanJobcodeLabel(row.jobcode_level2));
  const jobHours = sumValues(jobRows, "hours");
  const unassignedHours = sumValues(jobRows.filter((row) => !isDisplayJobcodeLabel(row.jobcode)), "hours");
  return (detailRows.length >= 10 && badDetailRows.length / detailRows.length >= 0.35)
    || (jobHours > 0 && unassignedHours / jobHours >= 0.35);
}

function deltaFallbackPayload(payload, cachedEnd) {
  if (!cachedEnd) return payload;
  const nextDate = nextIsoDate(cachedEnd);
  return {
    ...payload,
    start_date: maxIsoDate(payload.start_date, nextDate),
  };
}

function nextIsoDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function maxIsoDate(...values) {
  return values.filter(Boolean).sort().pop() || null;
}

function rawTimesheetDatasets(payload) {
  const datasets = availableDatasets.filter((dataset) =>
    dataset.name === "QuickBooks Time Timesheets" ||
    (dataset.source_type === "quickbooks_time" && /timesheets/i.test(dataset.name || ""))
  );
  if (!payload.dataset_uuid) return datasets;
  return datasets.filter((dataset) => dataset.id === payload.dataset_uuid);
}

async function hasNewerRawTimesheets(datasets, cachedEnd) {
  for (const dataset of datasets) {
    const { count, error } = await supabase
      .from("records")
      .select("id", { count: "exact", head: true })
      .eq("dataset_id", dataset.id)
      .gt("work_date", cachedEnd)
      .not("duration_seconds", "is", null);
    if (error) throw error;
    if (numeric(count) > 0) return true;
  }
  return false;
}

async function fetchRawDatasetRows(datasetName, selectFields) {
  const dataset = availableDatasets.find((row) => row.name === datasetName);
  if (!dataset) return [];
  return fetchRecordsInBatches((from, to) =>
    supabase
      .from("records")
      .select(selectFields)
      .eq("dataset_id", dataset.id)
      .range(from, to)
  );
}

async function fetchRawTimesheetRows(datasets, payload) {
  const rows = [];
  for (const dataset of datasets) {
    const datasetRows = await fetchRecordsInBatches((from, to) => {
      let query = supabase
        .from("records")
        .select("id,dataset_id,json_data,source_hash,work_date,duration_seconds")
        .eq("dataset_id", dataset.id)
        .not("work_date", "is", null)
        .not("duration_seconds", "is", null);
      if (payload.start_date) query = query.gte("work_date", payload.start_date);
      if (payload.end_date) query = query.lte("work_date", payload.end_date);
      return query.range(from, to);
    });
    rows.push(...datasetRows.map((row) => ({ ...row, dataset_name: dataset.name })));
  }
  return rows;
}

async function fetchRecordsInBatches(queryFactory) {
  const rows = [];
  for (let from = 0; ; from += RAW_ROLLUP_BATCH_SIZE) {
    const { data, error } = await queryFactory(from, from + RAW_ROLLUP_BATCH_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < RAW_ROLLUP_BATCH_SIZE) break;
  }
  return rows;
}

function buildRawQbRollup(timesheetRows, employeeRows, jobcodeRows, payload, datasets) {
  const employees = buildEmployeeMap(employeeRows);
  const jobcodes = buildJobcodeMap(jobcodeRows);
  const datasetIds = new Set();
  const deduped = new Map();
  let matchedRawCount = 0;

  for (const row of timesheetRows) {
    const experience = rawExperienceRow(row, employees, jobcodes);
    if (!experience || !rawExperienceMatches(experience, payload)) continue;
    matchedRawCount += 1;
    const key = row.source_hash || row.id;
    const current = deduped.get(key);
    if (!current || String(experience.work_date || "") > String(current.work_date || "")) deduped.set(key, experience);
    datasetIds.add(row.dataset_id);
  }

  const rows = Array.from(deduped.values());
  const hoursByEmployee = aggregateRows(rows, (row) => row.employee, { hours: "hours", timesheets: "count" })
    .map((row) => ({ employee: row.key, hours: row.hours, timesheets: row.timesheets }));
  const hoursByJobcode = aggregateRows(rows, (row) => row.jobcode_level1 || row.jobcode, { hours: "hours" })
    .map((row) => ({ jobcode: row.key, hours: row.hours }));
  const hoursByService = aggregateRows(rows, (row) => displayServiceLabel(row.service_item), { hours: "hours" })
    .map((row) => ({ service_item: row.key, hours: row.hours }));
  const hoursByDay = aggregateRows(rows, (row) => row.work_date, { hours: "hours" })
    .map((row) => ({ date: row.key, hours: row.hours }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const recordsByDataset = aggregateRows(rows, (row) => row.dataset_name, { records: "count" })
    .map((row) => ({ name: row.key, records: row.records }));
  const recordsByDay = aggregateRows(rows, (row) => row.work_date, { records: "count" })
    .map((row) => ({ date: row.key, records: row.records }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const detailRows = aggregateExperienceRows(rows);

  return {
    hours_by_employee: limitRows(hoursByEmployee, "hours", 15),
    hours_by_jobcode: limitRows(hoursByJobcode, "hours", 15),
    hours_by_service_item: limitRows(hoursByService, "hours", 15),
    hours_by_day: hoursByDay,
    records_by_dataset: limitRows(recordsByDataset, "records", 12),
    records_by_day: recordsByDay,
    employee_experience: limitRows(buildEmployeeExperience(rows), "hours", 50),
    experience_rows: limitRows(detailRows, "hours", 100),
    filtered_timesheets: rows.length,
    filtered_hours: roundValue(sumValues(rows, "hours")),
    filtered_employees: distinctValues(rows, "employee").filter((value) => value !== "Unassigned" && !/^[0-9]+$/.test(value)).length,
    filtered_jobcodes: distinctValues(rows, "jobcode").filter(isDisplayJobcodeLabel).length,
    filtered_service_items: distinctValues(rows, "service_item").filter((value) => displayServiceLabel(value) !== "No service item").length,
    raw_records: matchedRawCount,
    unique_records: rows.length,
    duplicates_removed: Math.max(matchedRawCount - rows.length, 0),
    dataset_count: datasetIds.size || datasets.length,
    date_start: minDate(rows.map((row) => row.work_date)),
    date_end: maxDate(rows.map((row) => row.work_date)),
    dataset_name: payload.dataset_uuid ? datasets.find((dataset) => dataset.id === payload.dataset_uuid)?.name : null,
  };
}

function buildEmployeeMap(rows) {
  const employees = new Map();
  for (const row of rows || []) {
    const data = row.json_data || {};
    const id = String(data.id || "").trim();
    const name = cleanEmployeeLabel([data.first_name, data.last_name].filter(Boolean).join(" ")) || cleanEmployeeLabel(data.email) || cleanEmployeeLabel(data.username);
    if (id && name) employees.set(id, name);
  }
  return employees;
}

function buildJobcodeMap(rows) {
  const raw = new Map();
  for (const row of rows || []) {
    const data = row.json_data || {};
    const id = String(data.id || "").trim();
    if (!id) continue;
    raw.set(id, {
      id,
      parent_id: String(data.parent_id || "").trim() && String(data.parent_id) !== "0" ? String(data.parent_id) : null,
      name: cleanJobcodeLabel(data.name) || cleanJobcodeLabel(data.short_code),
    });
  }
  const paths = new Map();
  for (const job of raw.values()) {
    const parent = job.parent_id ? raw.get(job.parent_id) : null;
    const grandparent = parent?.parent_id ? raw.get(parent.parent_id) : null;
    const hasGrandparent = Boolean(grandparent);
    const hasParent = Boolean(parent);
    paths.set(job.id, {
      id: job.id,
      name: job.name,
      level1_id: hasGrandparent ? grandparent.id : hasParent ? parent.id : job.id,
      level1_name: hasGrandparent ? grandparent.name : hasParent ? parent.name : job.name,
      level2_id: hasGrandparent ? parent?.id : hasParent ? job.id : null,
      level2_name: hasGrandparent ? parent?.name : hasParent ? job.name : null,
      level3_id: hasGrandparent ? job.id : null,
      level3_name: hasGrandparent ? job.name : null,
    });
  }
  return paths;
}

function rawExperienceRow(row, employees, jobcodes) {
  const data = row.json_data || {};
  const employeeId = String(data.user_id || "").trim();
  const employee = employees.get(employeeId)
    || cleanEmployeeLabel([data.fname, data.lname].filter(Boolean).join(" "))
    || cleanEmployeeLabel([data.first_name, data.last_name].filter(Boolean).join(" "))
    || cleanEmployeeLabel(data.employee_name)
    || cleanEmployeeLabel(data.display_name)
    || cleanEmployeeLabel(data.full_name)
    || cleanEmployeeLabel(data.username)
    || cleanEmployeeLabel(data.email)
    || "Unassigned";
  if (!employee || /^[0-9]+$/.test(employee)) return null;
  const jobPath = jobcodes.get(String(data.jobcode_id || "").trim());
  const serviceLabel = bestServiceItemValue(data);
  const servicePath = servicePathFromLabel(serviceLabel);
  const level1 = cleanJobcodeLabel(jobPath?.level1_name) || cleanJobcodeLabel(data.jobcode_1) || servicePath.level1 || "";
  const level2 = cleanJobcodeLabel(jobPath?.level2_name) || cleanJobcodeLabel(data.jobcode_2) || servicePath.level2 || "";
  const level3 = cleanJobcodeLabel(jobPath?.level3_name) || cleanJobcodeLabel(data.jobcode_3) || servicePath.level3 || "";
  const jobcode = level3 || level2 || level1 || cleanJobcodeLabel(data.jobcode_name) || cleanJobcodeLabel(jobPath?.name) || cleanJobcodeLabel(data.name) || cleanJobcodeLabel(data.short_code) || "Unassigned";
  return {
    record_id: row.id,
    dataset_id: row.dataset_id,
    dataset_name: row.dataset_name || "QuickBooks Time Timesheets",
    json_data: data,
    search_text: String(row.search_text || JSON.stringify(data || {})).toLowerCase(),
    work_date: row.work_date,
    hours: numeric(row.duration_seconds) / 3600,
    employee,
    employee_id: employeeId,
    jobcode_level1: level1,
    jobcode_level2: level2,
    jobcode_level3: level3,
    jobcode_level1_id: jobPath?.level1_id || "",
    jobcode_level2_id: jobPath?.level2_id || "",
    jobcode_level3_id: jobPath?.level3_id || "",
    jobcode,
    service_item: displayServiceLabel(serviceLabel),
  };
}

function rawExperienceMatches(row, payload) {
  const keyword = String(payload.keyword_filter || "").trim().toLowerCase();
  if (payload.employee_filter && !matchesEmployeeSearch(row.employee, row.employee_id, payload.employee_filter)) return false;
  if (payload.jobcode_level1_filter && !matchesJobFilter(row, payload.jobcode_level1_filter, ["jobcode_level1", "jobcode_level1_id", "jobcode"])) return false;
  if (payload.jobcode_level2_filter && !matchesJobFilter(row, payload.jobcode_level2_filter, ["jobcode_level2", "jobcode_level2_id", "jobcode"])) return false;
  if (payload.jobcode_level3_filter && !matchesJobFilter(row, payload.jobcode_level3_filter, ["jobcode_level3", "jobcode_level3_id", "jobcode"])) return false;
  if (payload.service_item_filter && !row.service_item.toLowerCase().includes(String(payload.service_item_filter).toLowerCase())) return false;
  if (!keyword) return true;
  return row.search_text.includes(keyword)
    || row.dataset_name.toLowerCase().includes(keyword)
    || matchesEmployeeSearch(row.employee, row.employee_id, keyword)
    || row.jobcode.toLowerCase().includes(keyword)
    || row.service_item.toLowerCase().includes(keyword);
}

function matchesEmployeeSearch(employee, employeeId, query) {
  const term = String(query || "").trim().toLowerCase();
  if (!term) return true;
  if (String(employeeId || "").trim().toLowerCase() === term) return true;
  const name = String(employee || "").trim().toLowerCase();
  if (!name) return false;
  if (name.includes(term)) return true;
  return term.split(/\s+/).filter(Boolean).every((token) => name.includes(token));
}

function matchesJobFilter(row, filter, keys) {
  const selected = String(filter || "").trim().toLowerCase();
  return keys.some((key) => String(row[key] || "").trim().toLowerCase().includes(selected));
}

function aggregateRows(rows, keyFn, fields) {
  const totals = new Map();
  for (const row of rows) {
    const key = String(keyFn(row) || "").trim() || "Unassigned";
    const current = totals.get(key) || { key };
    for (const [field, source] of Object.entries(fields)) {
      current[field] = source === "count"
        ? numeric(current[field]) + 1
        : roundValue(numeric(current[field]) + numeric(row[source]));
    }
    totals.set(key, current);
  }
  return Array.from(totals.values());
}

function buildEmployeeExperience(rows) {
  return aggregateRows(rows, (row) => row.employee, { hours: "hours", timesheets: "count" }).map((row) => {
    const matches = rows.filter((detail) => detail.employee === row.key);
    return {
      employee: row.key,
      hours: row.hours,
      timesheets: row.timesheets,
      jobcodes: distinctValues(matches, "jobcode").filter(isDisplayJobcodeLabel).length,
      service_items: distinctValues(matches, "service_item").filter((value) => value !== "No service item").length,
      first_work: minDate(matches.map((detail) => detail.work_date)),
      last_work: maxDate(matches.map((detail) => detail.work_date)),
    };
  });
}

function aggregateExperienceRows(rows) {
  const totals = new Map();
  for (const row of rows) {
    const normalized = normalizeExperienceDetailRow(row);
    const serviceItem = displayServiceLabel(normalized.service_item);
    const key = [normalized.employee, normalized.jobcode_level1, normalized.jobcode_level2, normalized.jobcode_level3, normalized.jobcode, serviceItem].join("|");
    const current = totals.get(key) || {
      employee: normalized.employee,
      jobcode_level1: normalized.jobcode_level1,
      jobcode_level2: normalized.jobcode_level2,
      jobcode_level3: normalized.jobcode_level3,
      jobcode: normalized.jobcode,
      service_item: serviceItem,
      hours: 0,
      timesheets: 0,
      first_work: row.work_date,
      last_work: row.work_date,
    };
    current.hours = roundValue(current.hours + numeric(row.hours));
    current.timesheets += 1;
    current.first_work = minDate([current.first_work, row.work_date]);
    current.last_work = maxDate([current.last_work, row.work_date]);
    totals.set(key, current);
  }
  return Array.from(totals.values());
}

function cleanEmployeeLabel(value) {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  return label && !/^[0-9]+$/.test(label) ? label : null;
}

function cleanJobcodeLabel(value) {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  if (!label || label === "0" || /^[0-9]+$/.test(label)) return null;
  if (/^(unassigned|not specified|no job code( [123])?)$/i.test(label)) return null;
  if (isExcludedAdminJobcode(label)) return null;
  return label;
}

function isExcludedAdminJobcode(value) {
  return EXCLUDED_ADMIN_JOBCODE_PATTERN.test(String(value || "").trim());
}

function displayJobcodeLabel(value, fallback = "Unassigned") {
  return cleanJobcodeLabel(value) || jobcodePathFromOptions(value).jobcode || fallback;
}

function jobcodePathFromOptions(value) {
  const selected = String(value || "").trim();
  if (!selected) return {};
  const same = (candidate) => String(candidate || "").trim() === selected;
  const label = (candidate) => cleanJobcodeLabel(candidate);
  const options = normalizeFilterOptions(qbFilterOptions);
  const matches = (row) => [row?.id, row?.name, row?.raw_id, row?.parent_raw_id, row?.grandparent_raw_id].some(same);
  const level3 = options.jobcode_level3.find(matches);
  if (level3) {
    return {
      level1: label(level3.grandparent_name) || label(level3.grandparent_id),
      level2: label(level3.parent_name) || label(level3.parent_id),
      level3: label(level3.name),
      jobcode: label(level3.name) || label(level3.parent_name) || label(level3.grandparent_name),
    };
  }
  const level2 = options.jobcode_level2.find(matches);
  if (level2) {
    return {
      level1: label(level2.parent_name) || label(level2.parent_id),
      level2: label(level2.name),
      jobcode: label(level2.name) || label(level2.parent_name),
    };
  }
  const level1 = options.jobcode_level1.find(matches);
  if (level1) return { level1: label(level1.name), jobcode: label(level1.name) };
  return {};
}

function mergeJobcodePath(base, next) {
  return {
    level1: base.level1 || next.level1,
    level2: base.level2 || next.level2,
    level3: base.level3 || next.level3,
    jobcode: base.jobcode || next.jobcode,
  };
}

function splitJobcodePath(value) {
  return String(value || "")
    .split("/")
    .map((part) => cleanJobcodeLabel(part))
    .filter(Boolean);
}

function normalizeExperienceDetailRow(row = {}) {
  const pathValues = [
    row.jobcode_level3_id,
    row.jobcode_level3,
    row.jobcode_level2_id,
    row.jobcode_level2,
    row.jobcode_level1_id,
    row.jobcode_level1,
    row.jobcode_id,
    row.jobcode,
  ];
  const optionPath = pathValues.reduce((path, value) => mergeJobcodePath(path, jobcodePathFromOptions(value)), {});
  const splitPath = splitJobcodePath(row.jobcode);
  const servicePath = servicePathFromLabel(row.service_item);
  const level1 = cleanJobcodeLabel(row.jobcode_level1) || optionPath.level1 || splitPath[0] || servicePath.level1 || null;
  const level2 = cleanJobcodeLabel(row.jobcode_level2) || optionPath.level2 || splitPath[1] || servicePath.level2 || null;
  const level3 = cleanJobcodeLabel(row.jobcode_level3) || optionPath.level3 || splitPath[2] || servicePath.level3 || null;
  const jobcode = cleanJobcodeLabel(row.jobcode) || optionPath.jobcode || servicePath.jobcode || level3 || level2 || level1 || "Unassigned";
  return {
    ...row,
    jobcode_level1: level1 || "Unassigned",
    jobcode_level2: level2 || "Not specified",
    jobcode_level3: level3 || "Not specified",
    jobcode,
    service_item: displayServiceLabel(row.service_item),
  };
}

function detailJobcodeLabel(row, level) {
  const normalized = normalizeExperienceDetailRow(row);
  if (level === 1) return normalized.jobcode_level1;
  if (level === 2) return normalized.jobcode_level2;
  return normalized.jobcode_level3;
}

function cleanServiceLabel(value) {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  if (!label || /^null$/i.test(label) || /^undefined$/i.test(label)) return null;
  return label;
}

function serviceItemValues(data = {}) {
  const values = [
    data.customfields?.["53105"],
    data["service item"],
    data.service_item,
    data.serviceItem,
    data.service,
  ];
  const customfields = data.customfields;
  if (customfields && typeof customfields === "object") {
    const entries = Array.isArray(customfields) ? customfields : Object.values(customfields);
    for (const entry of entries) {
      if (typeof entry === "string") values.push(entry);
      if (entry && typeof entry === "object") values.push(entry.value, entry.name, entry.label);
    }
  }
  return Array.from(new Set(values.map(cleanServiceLabel).filter(Boolean)));
}

function bestServiceItemValue(data = {}) {
  const values = serviceItemValues(data);
  return values.find((value) => value.includes(":")) || values[0] || null;
}
function displayServiceLabel(value) {
  return servicePathFromLabel(value).service || cleanServiceLabel(value) || "No service item";
}

function servicePathFromLabel(value) {
  const label = cleanServiceLabel(value);
  if (!label || label === "No service item") return {};
  const parts = label.split(":").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return { service: label };
  const service = cleanServiceLabel(parts[parts.length - 1]);
  const jobParts = parts.slice(0, -1).map((part) => cleanJobcodeLabel(part)).filter(Boolean);
  return {
    level1: jobParts[0] || null,
    level2: jobParts[1] || null,
    level3: jobParts.length > 2 ? jobParts.slice(2).join(":") : null,
    jobcode: jobParts[jobParts.length - 1] || jobParts[0] || null,
    service,
  };
}

function addServicePathOptions(level1, level2, level3, value) {
  const path = servicePathFromLabel(value);
  if (!path.level1) return;
  level1.set(path.level1, { id: path.level1, name: path.level1, derived_from_service_path: true });
  if (path.jobcode && path.jobcode !== path.level1) {
    level1.set(path.jobcode, {
      id: path.jobcode,
      name: path.jobcode,
      parent_id: path.level1,
      parent_name: path.level1,
      derived_from_service_path: true,
      leaf_jobcode: true,
    });
  }
  if (path.level2) {
    level2.set(`${path.level1}|${path.level2}`, {
      id: path.level2,
      name: path.level2,
      parent_id: path.level1,
      parent_name: path.level1,
      derived_from_service_path: true,
    });
  }
  if (path.level2 && path.level3) {
    level3.set(`${path.level1}|${path.level2}|${path.level3}`, {
      id: path.level3,
      name: path.level3,
      parent_id: path.level2,
      parent_name: path.level2,
      grandparent_id: path.level1,
      grandparent_name: path.level1,
      derived_from_service_path: true,
    });
  }
}

function buildFilterOptionsFromServiceItems(values = []) {
  const options = emptyQbFilterOptions();
  const level1 = new Map();
  const level2 = new Map();
  const level3 = new Map();
  const services = new Set();
  for (const value of values) {
    addServicePathOptions(level1, level2, level3, value);
    const service = displayServiceLabel(value);
    if (service && service !== "No service item") services.add(service);
  }
  options.jobcode_level1 = sortByName(Array.from(level1.values()));
  options.jobcode_level2 = sortByName(Array.from(level2.values()));
  options.jobcode_level3 = sortByName(Array.from(level3.values()));
  options.service_items = Array.from(services).sort((a, b) => a.localeCompare(b));
  return options;
}

function normalizeDerivedJobcodePayload(payload) {
  const next = { ...payload };
  const derived = [
    ["jobcode_level1_filter", next.jobcode_level1_filter],
    ["jobcode_level2_filter", next.jobcode_level2_filter],
    ["jobcode_level3_filter", next.jobcode_level3_filter],
  ].filter(([, value]) => isDerivedServicePathSelection(value));
  if (!derived.length) return next;
  const mostSpecific = derived[derived.length - 1][1];
  next._derived_jobcode_filter = mostSpecific;
  next.keyword_filter = [next.keyword_filter, mostSpecific].filter(Boolean).join(" ") || null;
  return next;
}

function isDerivedServicePathSelection(value) {
  const selected = String(value || "").trim();
  if (!selected) return false;
  const options = normalizeFilterOptions(qbFilterOptions);
  return [...options.jobcode_level1, ...options.jobcode_level2, ...options.jobcode_level3]
    .some((row) => row?.derived_from_service_path && optionMatches(row, selected, ["id", "name"]));
}

async function callSearchSummary() {
  const result = await supabase.rpc("search_records_summary", searchSummaryPayload());
  if (!isSchemaCacheError(result.error)) return result;
  return { data: null, error: null };
}

function emptyQbPayload() {
  return {
    dataset_uuid: null,
    keyword_filter: null,
    employee_filter: null,
    start_date: null,
    end_date: null,
    jobcode_level1_filter: null,
    jobcode_level2_filter: null,
    jobcode_level3_filter: null,
    service_item_filter: null,
  };
}

async function syncQuickBooksTime() {
  const button = $("#dashboard-qb-sync");
  const progress = startProgress("Syncing recent QuickBooks Time changes...");
  setButtonBusy(button, true, "Syncing...");
  try {
    const headers = await authHeaders();
    const response = await fetch(`${FUNCTIONS_BASE_URL}/qbtime?action=sync`, { method: "POST", headers });
    const payload = await readPayload(response);
    if (!response.ok) {
      stopProgress(progress, payload.error || `Sync failed with status ${response.status}`, "error");
      return;
    }
    const stats = payload.data?.stats || {};
    const errors = payload.data?.errors || [];
    const message = `Sync finished. Timesheets: ${formatNumber(stats.Timesheets)}; Employees: ${formatNumber(stats.Employees)}; Job Codes: ${formatNumber(stats["Job Codes"])}.${errors.length ? ` ${errors.length} warning${errors.length === 1 ? "" : "s"} logged.` : ""}`;
    stopProgress(progress, message, errors.length ? "info" : "success");
    await loadDatasets();
    await loadDashboard();
  } catch (error) {
    console.error("QuickBooks Time sync request failed", error);
    const message = /fetch/i.test(error.message || "")
      ? "Could not reach the QuickBooks Time sync function. Refresh, sign in again, then retry. If it continues, the Edge Function may need redeployment."
      : error.message;
    stopProgress(progress, message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired. Sign in again, then retry sync.");
  return { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" };
}

async function readPayload(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || `Request failed with status ${response.status}` };
  }
}

function qbFilterPayload() {
  return normalizeDerivedJobcodePayload({
    dataset_uuid: $("#filter-dataset")?.value || null,
    keyword_filter: $("#filter-keyword")?.value.trim() || null,
    employee_filter: $("#filter-employee")?.value.trim() || null,
    start_date: $("#filter-start")?.value || null,
    end_date: $("#filter-end")?.value || null,
    jobcode_level1_filter: $("#filter-jobcode-1")?.value || null,
    jobcode_level2_filter: $("#filter-jobcode-2")?.value || null,
    jobcode_level3_filter: $("#filter-jobcode-3")?.value || null,
    service_item_filter: $("#filter-service-item")?.value || null,
  });
}

function searchSummaryPayload() {
  const jobcodeFilter = $("#filter-jobcode-3")?.value || $("#filter-jobcode-2")?.value || $("#filter-jobcode-1")?.value || null;
  return {
    dataset_uuid: $("#filter-dataset")?.value || null,
    search_term: $("#filter-keyword")?.value.trim() || null,
    start_date: dateTimeValue("#filter-start"),
    end_date: dateTimeValue("#filter-end", true),
    employee_filter: $("#filter-employee")?.value.trim() || null,
    jobcode_filter: jobcodeFilter,
    service_item_filter: $("#filter-service-item")?.value || null,
  };
}

function clearQbFilters() {
  $("#qb-viz-filters")?.reset();
  refreshDependentJobFilters();
  updateDatasetIndicator();
  loadQbVisuals();
}

function populateQbFilters(options) {
  const normalized = normalizeFilterOptions(options);
  fillEmployeeOptions(normalized.employees);
  fillSelect("#filter-jobcode-1", normalized.jobcode_level1, "All Job Code 1", { hideNumericNames: true });
  fillSelect("#filter-service-item", normalized.service_items.map((name) => ({ id: name, name })), "All service items");
  fillProjectLookupOptions(normalized);
  refreshDependentJobFilters();
}

function normalizeFilterOptions(options = {}) {
  const fallback = emptyQbFilterOptions();
  return {
    employees: Array.isArray(options.employees) ? options.employees : fallback.employees,
    jobcode_level1: Array.isArray(options.jobcode_level1) ? options.jobcode_level1 : fallback.jobcode_level1,
    jobcode_level2: Array.isArray(options.jobcode_level2) ? options.jobcode_level2 : fallback.jobcode_level2,
    jobcode_level3: Array.isArray(options.jobcode_level3) ? options.jobcode_level3 : fallback.jobcode_level3,
    service_items: Array.isArray(options.service_items) ? options.service_items : fallback.service_items,
  };
}


async function loadJobcodeReferenceOptions() {
  try {
    const { data: datasets, error: datasetError } = await supabase
      .from("datasets")
      .select("id")
      .eq("name", "QuickBooks Time Job Codes")
      .limit(1);
    if (datasetError) throw datasetError;
    const datasetId = datasets?.[0]?.id;
    if (!datasetId) return emptyQbFilterOptions();

    const rows = [];
    const batchSize = 1000;
    for (let start = 0; start < 10000; start += batchSize) {
      const { data, error } = await supabase
        .from("records")
        .select("json_data")
        .eq("dataset_id", datasetId)
        .range(start, start + batchSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < batchSize) break;
    }
    return buildJobcodeReferenceOptions(rows);
  } catch (error) {
    console.warn("Dashboard job-code reference fallback failed.", error.message);
    return emptyQbFilterOptions();
  }
}
async function hydrateServiceItemOptions(optionsPromise) {
  try {
    const rawServiceItemOptions = await optionsPromise;
    if (!rawServiceItemOptions?.service_items?.length) return;
    const previousCount = normalizeFilterOptions(qbFilterOptions).service_items.length;
    qbFilterOptions = mergeFilterOptions(qbFilterOptions, rawServiceItemOptions);
    if (normalizeFilterOptions(qbFilterOptions).service_items.length !== previousCount) populateQbFilters(qbFilterOptions);
  } catch (error) {
    console.warn("Dashboard service-item hydration failed.", error.message);
  }
}
async function loadRawServiceItemOptions() {
  try {
    const datasets = availableDatasets.filter((dataset) =>
      dataset.name === "QuickBooks Time Timesheets" ||
      (dataset.source_type === "quickbooks_time" && /timesheets/i.test(dataset.name || ""))
    );
    if (!datasets.length) return emptyQbFilterOptions();

    const cacheKey = serviceItemCacheKey(datasets);
    const cached = readFilterOptionCache(cacheKey);
    if (cached) return cached;

    const serviceItems = new Set();
    for (const dataset of datasets) {
      const rows = await fetchServiceItemRows(dataset.id);
      for (const row of rows) {
        const data = row?.json_data || {};
        for (const service of serviceItemValues(data)) serviceItems.add(service);
      }
    }

    const options = buildFilterOptionsFromServiceItems(Array.from(serviceItems));
    writeFilterOptionCache(cacheKey, options);
    return options;
  } catch (error) {
    console.warn("Dashboard service-item fallback failed.", error.message);
    return emptyQbFilterOptions();
  }
}

async function fetchServiceItemRows(datasetId) {
  const rows = [];
  for (let start = 0; start < FILTER_OPTION_SCAN_LIMIT; start += FILTER_OPTION_BATCH_SIZE) {
    const { data, error } = await supabase
      .from("records")
      .select("json_data")
      .eq("dataset_id", datasetId)
      .not("duration_seconds", "is", null)
      .range(start, start + FILTER_OPTION_BATCH_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < FILTER_OPTION_BATCH_SIZE) break;
  }
  return rows;
}

function serviceItemCacheKey(datasets) {
  const signature = datasets
    .map((dataset) => [dataset.id, dataset.record_count, dataset.updated_at].join(":"))
    .sort()
    .join("|");
  return `dashboard-service-items:v3:${signature}`;
}

function readFilterOptionCache(key) {
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) || "null");
    if (!cached || Date.now() - numeric(cached.cached_at) > FILTER_OPTION_CACHE_TTL_MS) return null;
    return normalizeFilterOptions(cached.options);
  } catch {
    return null;
  }
}

function writeFilterOptionCache(key, options) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ cached_at: Date.now(), options }));
  } catch {
    // Cache is only a speed optimization.
  }
}

function buildJobcodeReferenceOptions(rows = []) {
  const options = emptyQbFilterOptions();
  const jobcodes = new Map();
  for (const row of rows) {
    const data = row?.json_data || row || {};
    const rawId = String(data.id || "").trim();
    const parentId = String(data.parent_id || "").trim();
    const name = cleanJobcodeLabel(data.name) || cleanJobcodeLabel(data.short_code);
    if (!rawId || !name) continue;
    jobcodes.set(rawId, {
      raw_id: rawId,
      raw_parent_id: parentId && parentId !== "0" ? parentId : "",
      name,
    });
  }

  const level1 = new Map();
  const level2 = new Map();
  const level3 = new Map();
  for (const rawId of jobcodes.keys()) {
    const path = jobcodeReferencePath(rawId, jobcodes);
    if (!path.level1_name) continue;
    const leafName = cleanJobcodeLabel(path.level3_name) || cleanJobcodeLabel(path.level2_name) || cleanJobcodeLabel(path.level1_name);
    if (leafName) {
      level1.set(leafName, {
        id: leafName,
        name: leafName,
        raw_id: path.level3_raw_id || path.level2_raw_id || path.level1_raw_id,
        parent_id: path.level2_name || path.level1_name,
        parent_name: path.level2_name || path.level1_name,
        leaf_jobcode: true,
      });
    }
    level1.set(path.level1_name, {
      id: path.level1_name,
      name: path.level1_name,
      raw_id: path.level1_raw_id,
    });
    if (path.level2_name) {
      level2.set(`${path.level1_name}|${path.level2_name}`, {
        id: path.level2_name,
        name: path.level2_name,
        parent_id: path.level1_name,
        parent_name: path.level1_name,
        raw_id: path.level2_raw_id,
        parent_raw_id: path.level1_raw_id,
      });
    }
    if (path.level3_name) {
      level3.set(`${path.level1_name}|${path.level2_name}|${path.level3_name}`, {
        id: path.level3_name,
        name: path.level3_name,
        parent_id: path.level2_name,
        parent_name: path.level2_name,
        grandparent_id: path.level1_name,
        grandparent_name: path.level1_name,
        raw_id: path.level3_raw_id,
        parent_raw_id: path.level2_raw_id,
        grandparent_raw_id: path.level1_raw_id,
      });
    }
  }

  options.jobcode_level1 = sortByName(Array.from(level1.values()));
  options.jobcode_level2 = sortByName(Array.from(level2.values()));
  options.jobcode_level3 = sortByName(Array.from(level3.values()));
  return options;
}

function jobcodeReferencePath(rawId, jobcodes) {
  const leaf = jobcodes.get(String(rawId || ""));
  if (!leaf) return {};
  const parent = leaf.raw_parent_id ? jobcodes.get(leaf.raw_parent_id) : null;
  const root = parent?.raw_parent_id ? jobcodes.get(parent.raw_parent_id) : null;
  if (root) {
    return {
      level1_name: root.name,
      level1_raw_id: root.raw_id,
      level2_name: parent.name,
      level2_raw_id: parent.raw_id,
      level3_name: leaf.name,
      level3_raw_id: leaf.raw_id,
    };
  }
  if (parent) {
    return {
      level1_name: parent.name,
      level1_raw_id: parent.raw_id,
      level2_name: leaf.name,
      level2_raw_id: leaf.raw_id,
    };
  }
  return {
    level1_name: leaf.name,
    level1_raw_id: leaf.raw_id,
  };
}

function buildFilterOptionsFromRollup(data = {}) {
  const options = emptyQbFilterOptions();
  const employees = new Map();
  const level1 = new Map();
  const level2 = new Map();
  const level3 = new Map();
  const services = new Set();
  const detailRows = (data.experience_rows || []).map((row) => normalizeExperienceDetailRow(row));

  for (const row of data.employee_experience || []) {
    const name = cleanEmployeeLabel(row.employee);
    if (name) employees.set(name, { id: String(row.employee_id || name), name });
  }

  for (const row of detailRows) {
    const employee = cleanEmployeeLabel(row.employee);
    if (employee) employees.set(employee, { id: String(row.employee_id || employee), name: employee });

    const l1 = cleanJobcodeLabel(row.jobcode_level1);
    const l2 = cleanJobcodeLabel(row.jobcode_level2);
    const l3 = cleanJobcodeLabel(row.jobcode_level3);
    if (l1) level1.set(l1, { id: String(row.jobcode_level1_id || l1), name: l1 });
    if (l1 && l2) {
      level2.set(`${l1}|${l2}`, {
        id: String(row.jobcode_level2_id || l2),
        name: l2,
        parent_id: String(row.jobcode_level1_id || l1),
        parent_name: l1,
      });
    }
    if (l1 && l2 && l3) {
      level3.set(`${l1}|${l2}|${l3}`, {
        id: String(row.jobcode_level3_id || l3),
        name: l3,
        parent_id: String(row.jobcode_level2_id || l2),
        parent_name: l2,
        grandparent_id: String(row.jobcode_level1_id || l1),
        grandparent_name: l1,
      });
    }

    addServicePathOptions(level1, level2, level3, row.service_item);
    const service = displayServiceLabel(row.service_item);
    if (service && service !== "No service item") services.add(service);
  }

  for (const row of data.hours_by_jobcode || []) {
    const jobcode = cleanJobcodeLabel(row.jobcode);
    if (jobcode) level1.set(jobcode, { id: jobcode, name: jobcode });
  }

  for (const row of data.hours_by_service_item || []) {
    addServicePathOptions(level1, level2, level3, row.service_item);
    const service = displayServiceLabel(row.service_item);
    if (service && service !== "No service item") services.add(service);
  }

  options.employees = sortByName(Array.from(employees.values()));
  options.jobcode_level1 = sortByName(Array.from(level1.values()));
  options.jobcode_level2 = sortByName(Array.from(level2.values()));
  options.jobcode_level3 = sortByName(Array.from(level3.values()));
  options.service_items = Array.from(services).sort((a, b) => a.localeCompare(b));
  return options;
}

function mergeFilterOptions(primary, fallback) {
  const base = normalizeFilterOptions(primary);
  const next = normalizeFilterOptions(fallback);
  return {
    employees: mergeOptionRows(base.employees, next.employees),
    jobcode_level1: mergeOptionRows(base.jobcode_level1, next.jobcode_level1),
    jobcode_level2: mergeOptionRows(base.jobcode_level2, next.jobcode_level2),
    jobcode_level3: mergeOptionRows(base.jobcode_level3, next.jobcode_level3),
    service_items: Array.from(new Set([...base.service_items, ...next.service_items].filter(cleanServiceLabel))).sort((a, b) => a.localeCompare(b)),
  };
}

function mergeOptionRows(primary = [], fallback = []) {
  const rows = new Map();
  for (const row of [...fallback, ...primary]) {
    const name = cleanJobcodeLabel(row?.name) || cleanEmployeeLabel(row?.name);
    if (!name) continue;
    const key = [row?.grandparent_name, row?.parent_name, name].filter(Boolean).join("|") || name;
    const existing = rows.get(key) || {};
    const rowId = String(row?.id || "").trim();
    const rawId = row?.raw_id || existing.raw_id || (rowId && !cleanJobcodeLabel(rowId) ? rowId : null);
    rows.set(key, {
      ...existing,
      ...row,
      id: optionValue({ ...row, name }),
      name,
      raw_id: rawId,
      parent_id: row?.parent_id || existing.parent_id,
      parent_name: row?.parent_name || existing.parent_name,
      parent_raw_id: row?.parent_raw_id || existing.parent_raw_id,
      grandparent_id: row?.grandparent_id || existing.grandparent_id,
      grandparent_name: row?.grandparent_name || existing.grandparent_name,
      grandparent_raw_id: row?.grandparent_raw_id || existing.grandparent_raw_id,
    });
  }
  return sortByName(Array.from(rows.values()));
}

function sortByName(rows) {
  return rows.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
}

function optionValue(row) {
  const readable = cleanJobcodeLabel(row?.name) || cleanServiceLabel(row?.name) || cleanEmployeeLabel(row?.name);
  return String(readable || row?.id || "");
}

function fillEmployeeOptions(rows) {
  const list = $("#employee-options");
  if (!list) return;
  const cleanRows = (rows || []).filter((row) => row?.id && row?.name && !/^\d+$/.test(String(row.name).trim()));
  list.innerHTML = cleanRows
    .map((row) => `<option value="${escapeHtml(row.name)}" label="${escapeHtml(row.id)}"></option>`)
    .join("");
}

function fillProjectLookupOptions(options) {
  fillDatalist("#project-jobcode-1-options", options.jobcode_level1 || []);
  fillDatalist("#project-jobcode-2-options", options.jobcode_level2 || [], (row) => row.parent_name);
}

function fillDatalist(selector, rows, labelFn = null) {
  const list = $(selector);
  if (!list) return;
  const seen = new Set();
  const cleanRows = (rows || []).filter((row) => row?.id && row?.name && cleanJobcodeLabel(row.name) && !seen.has(row.name) && seen.add(row.name));
  list.innerHTML = cleanRows
    .map((row) => `<option value="${escapeHtml(row.name)}"${labelFn ? ` label="${escapeHtml(labelFn(row) || "")}"` : ""}></option>`)
    .join("");
}

function updateDatasetIndicator() {
  const indicator = $("#dataset-indicator");
  if (!indicator) return;
  const selected = availableDatasets.find((row) => row.id === ($("#filter-dataset")?.value || ""));
  if (!selected) {
    indicator.classList.add("hidden");
    indicator.textContent = "";
    return;
  }
  indicator.textContent = `Viewing dataset: ${selected.name} (${formatNumber(selected.record_count)} records)`;
  indicator.classList.remove("hidden");
}

function refreshDependentJobFilters() {
  qbFilterOptions = normalizeFilterOptions(qbFilterOptions);
  const selectedLevel1 = $("#filter-jobcode-1")?.value || "";
  const selectedLevel2 = $("#filter-jobcode-2")?.value || "";
  const selectedLevel3 = $("#filter-jobcode-3")?.value || "";
  const level2 = (qbFilterOptions.jobcode_level2 || []).filter((row) => !selectedLevel1 || optionMatches(row, selectedLevel1, ["parent_id", "parent_name", "parent_raw_id"]));
  fillSelect("#filter-jobcode-2", level2, "All Job Code 2", { hideNumericNames: true });
  if (selectedLevel2 && level2.some((row) => optionMatches(row, selectedLevel2, ["id", "name", "raw_id"]))) $("#filter-jobcode-2").value = selectedLevel2;

  const nextLevel2 = $("#filter-jobcode-2")?.value || "";
  const level3 = (qbFilterOptions.jobcode_level3 || []).filter((row) => {
    if (nextLevel2) return optionMatches(row, nextLevel2, ["parent_id", "parent_name", "parent_raw_id"]);
    if (selectedLevel1) return optionMatches(row, selectedLevel1, ["grandparent_id", "grandparent_name", "grandparent_raw_id"]);
    return true;
  });
  fillSelect("#filter-jobcode-3", level3, "All Job Code 3", { hideNumericNames: true });
  if (selectedLevel3 && level3.some((row) => optionMatches(row, selectedLevel3, ["id", "name", "raw_id"]))) $("#filter-jobcode-3").value = selectedLevel3;
}

function fillSelect(selector, rows, placeholder, { hideNumericNames = false } = {}) {
  const select = $(selector);
  if (!select) return;
  const current = select.value;
  const cleanRows = (rows || []).filter((row) => row?.id && row?.name && (!hideNumericNames || cleanJobcodeLabel(row.name)));
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${cleanRows.map((row) => `<option value="${escapeHtml(optionValue(row))}">${escapeHtml(row.name)}</option>`).join("")}`;
  if (current && cleanRows.some((row) => optionMatches(row, current, ["id", "name", "raw_id"]))) select.value = current;
}

function renderChart(selector, type, rows, labelKey, valueKey, label) {
  const canvas = $(selector);
  if (!canvas || !window.Chart) return;
  charts.get(selector)?.destroy();
  const context = canvas.getContext("2d");
  const dataRows = rows.length ? rows : [{ [labelKey]: "No data", [valueKey]: 0 }];
  const isBar = type === "bar";
  const palette = chartPalette();
  charts.set(selector, new Chart(context, {
    type,
    data: {
      labels: dataRows.map((row) => String(row[labelKey] ?? "")),
      datasets: [{
        label,
        data: dataRows.map((row) => Number(row[valueKey] || 0)),
        borderColor: palette.primary,
        backgroundColor: type === "line" ? palette.fill : palette.series,
        borderWidth: 2,
        tension: 0.28,
        fill: type === "line",
      }],
    },
    options: {
      indexAxis: isBar ? "y" : "x",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items.map((item) => item.label).join(", "),
            label: (item) => `${item.dataset.label}: ${formatNumber(item.parsed?.x ?? item.parsed?.y ?? item.raw)}`,
          },
        },
      },
      scales: {
        x: { beginAtZero: isBar, ticks: { maxRotation: 0, autoSkip: true, color: palette.tick, callback: isBar ? numberTick : shortTick }, grid: { display: false } },
        y: { beginAtZero: !isBar, ticks: { color: palette.tick, callback: isBar ? shortTick : numberTick }, grid: { color: palette.grid } },
      },
    },
  }));
}

function renderExperienceOverview(data) {
  const normalized = normalizeExperienceRollup(data);
  renderChart("#hours-by-employee", "bar", normalized.hours_by_employee, "employee", "hours", "Hours");
  renderChart("#hours-by-jobcode", "bar", normalized.hours_by_jobcode, "jobcode", "hours", "Hours");
  renderChart("#hours-by-service-item", "bar", normalized.hours_by_service_item, "service_item", "hours", "Hours");
  renderChart("#hours-over-time", "line", normalized.hours_by_day, "date", "hours", "Hours");
  renderEmployeeExperience(normalized.employee_experience);
  renderExperienceDetail(normalized.experience_rows);
}

function renderEmployeeExperience(rows) {
  setText("#employee-experience-summary", rows.length ? `${formatNumber(rows.length)} matching employees` : "No matching employees");
  renderRows($("#employee-experience-body"), rows, [
    (r) => escapeHtml(r.employee),
    (r) => formatNumber(r.hours),
    (r) => formatNumber(r.timesheets),
    (r) => formatNumber(r.jobcodes),
    (r) => formatNumber(r.service_items),
    (r) => formatDate(r.first_work),
    (r) => formatDate(r.last_work),
  ]);
}

function renderExperienceDetail(rows) {
  setText("#experience-detail-summary", rows.length ? `${formatNumber(rows.length)} employee, job, and service combinations` : "No matching experience rows");
  renderRows($("#experience-detail-body"), rows, [
    (r) => escapeHtml(r.employee),
    (r) => escapeHtml(detailJobcodeLabel(r, 1)),
    (r) => escapeHtml(detailJobcodeLabel(r, 2)),
    (r) => escapeHtml(detailJobcodeLabel(r, 3)),
    (r) => escapeHtml(displayServiceLabel(r.service_item)),
    (r) => formatNumber(r.hours),
    (r) => `${formatDate(r.first_work)} - ${formatDate(r.last_work)}`,
  ]);
}

function normalizeExperienceRollup(data = {}) {
  const detailRows = (data.experience_rows || []).map(normalizeExperienceDetailRow).filter(hasNamedEmployee);
  const employeeRows = (data.employee_experience || data.hours_by_employee || []).filter(hasNamedEmployee);
  const serviceRows = (data.hours_by_service_item || []).map((row) => ({ ...row, service_item: displayServiceLabel(row.service_item) }));
  const rawJobRows = normalizeProjectHours(data.hours_by_jobcode || []);
  const detailJobRows = normalizeProjectHours(detailRows.map((row) => ({ jobcode: row.jobcode_level1, hours: row.hours })));
  const rawJobHours = sumValues(rawJobRows, "hours");
  const rawUnassignedHours = sumValues(rawJobRows.filter((row) => !isDisplayJobcodeLabel(row.jobcode)), "hours");
  const jobRows = rawJobRows.length && rawJobHours && rawUnassignedHours / rawJobHours < 0.25 ? rawJobRows : detailJobRows;
  const dayRows = data.hours_by_day || [];
  const employeeNames = distinctValues([...employeeRows, ...detailRows], "employee");
  const serviceNames = distinctValues([...serviceRows, ...detailRows], "service_item").filter((name) => displayServiceLabel(name) !== "No service item");
  return {
    ...data,
    employee_experience: employeeRows,
    experience_rows: detailRows,
    hours_by_employee: employeeRows,
    hours_by_jobcode: jobRows,
    hours_by_service_item: serviceRows,
    hours_by_day: dayRows,
    records_by_dataset: data.records_by_dataset || [],
    records_by_day: data.records_by_day || [],
    raw_records: numeric(data.raw_records ?? data.filtered_timesheets),
    unique_records: numeric(data.unique_records ?? data.filtered_timesheets),
    dataset_count: numeric(data.dataset_count),
    duplicates_removed: numeric(data.duplicates_removed),
    filtered_hours: numeric(data.filtered_hours ?? firstPositive(sumValues(dayRows, "hours"), sumValues(employeeRows, "hours"), sumValues(detailRows, "hours"))),
    filtered_employees: numeric(data.filtered_employees ?? employeeNames.length),
    filtered_service_items: numeric(data.filtered_service_items ?? serviceNames.length),
    filtered_timesheets: numeric(data.filtered_timesheets ?? sumValues(employeeRows, "timesheets") ?? detailRows.length),
  };
}

function hasNamedEmployee(row) {
  const employee = String(row?.employee || "").trim();
  return Boolean(employee && employee !== "Unassigned" && !/^[0-9]+$/.test(employee));
}

function normalizeProjectHours(rows) {
  const totals = new Map();
  for (const row of rows || []) {
    const project = projectLabel(row.jobcode);
    if (isDisplayJobcodeLabel(project)) totals.set(project, (totals.get(project) || 0) + numeric(row.hours));
  }
  return Array.from(totals.entries())
    .map(([jobcode, hours]) => ({ jobcode, hours }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 15);
}

function projectLabel(value) {
  const raw = String(value || "").trim();
  const optionPath = jobcodePathFromOptions(raw);
  if (optionPath.level1) return optionPath.level1;
  if (!cleanJobcodeLabel(raw)) return "Unassigned";
  const options = qbFilterOptions || {};
  const level1 = options.jobcode_level1 || [];
  const level2 = options.jobcode_level2 || [];
  const level3 = options.jobcode_level3 || [];
  const directLevel1 = level1.find((row) => row.id === raw || row.name === raw);
  if (directLevel1) return cleanJobcodeLabel(directLevel1.name) || "Unassigned";
  const directLevel2 = level2.find((row) => row.id === raw || row.name === raw);
  if (directLevel2) return cleanJobcodeLabel(directLevel2.parent_name) || cleanJobcodeLabel(directLevel2.name) || "Unassigned";
  const directLevel3 = level3.find((row) => row.id === raw || row.name === raw);
  if (directLevel3) return cleanJobcodeLabel(directLevel3.grandparent_name) || cleanJobcodeLabel(directLevel3.parent_name) || cleanJobcodeLabel(directLevel3.name) || "Unassigned";
  const firstPathPart = raw.split("/").map((part) => cleanJobcodeLabel(part)).find(Boolean);
  return firstPathPart || cleanJobcodeLabel(raw) || "Unassigned";
}

function isDisplayJobcodeLabel(value) {
  const label = cleanJobcodeLabel(value);
  return Boolean(label && label !== "Unassigned");
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

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function sumValues(rows, key) {
  if (!rows?.length) return 0;
  return rows.reduce((total, row) => total + numeric(row[key]), 0);
}

function firstPositive(...values) {
  return values.find((value) => numeric(value) > 0) || 0;
}

function distinctValues(rows, key) {
  return Array.from(new Set((rows || []).map((row) => String(row[key] || "").trim()).filter(Boolean)));
}

function formatDate(value) {
  return value ? new Date(`${value}T00:00:00`).toLocaleDateString() : "-";
}

function dateTimeValue(selector, endOfDay = false) {
  const value = $(selector)?.value;
  if (!value) return null;
  return `${value}T${endOfDay ? "23:59:59" : "00:00:00"}`;
}

function dateRangeLabel(data) {
  if (!data.date_start && !data.date_end) return "";
  return ` from ${formatDate(data.date_start)} to ${formatDate(data.date_end)}`;
}

function shortTick(value) {
  const label = this.getLabelForValue ? this.getLabelForValue(value) : String(value);
  return label.length > 28 ? `${label.slice(0, 25)}...` : label;
}

function numberTick(value) {
  return Number(value || 0).toLocaleString();
}

function chartPalette() {
  const isDark = document.documentElement.dataset.theme === "dark" || document.body.classList.contains("dark");
  return {
    primary: isDark ? "#60a5fa" : "#2563eb",
    fill: isDark ? "rgba(96, 165, 250, .18)" : "rgba(37, 99, 235, .16)",
    tick: isDark ? "#cbd5e1" : "#475467",
    grid: isDark ? "rgba(148, 163, 184, .18)" : "#eef2f7",
    series: isDark
      ? ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#22d3ee", "#a78bfa", "#94a3b8"]
      : ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#0891b2", "#7c3aed", "#475569"],
  };
}

function isSchemaCacheError(error) {
  return /schema cache|could not find the function/i.test(error?.message || "");
}

function debounce(fn, delay) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), delay);
  };
}

function scopeSummary(data) {
  if (data.is_fast_fallback) {
    return `Showing ${formatNumber(data.unique_records)} records across ${formatNumber(data.dataset_count)} dataset${Number(data.dataset_count) === 1 ? "" : "s"} from dataset metadata. Experience totals will update after the dashboard rollup finishes refreshing.`;
  }
  const scope = data.dataset_name || "All authorized datasets";
  const sourceText = data.is_raw_delta_fallback
    ? " Cached dashboard rollup was extended with newer synced QuickBooks Time rows."
    : "";
  const duplicateText = Number(data.duplicates_removed || 0)
    ? ` ${formatNumber(data.duplicates_removed)} duplicate rows excluded.`
    : " No duplicate rows found.";
  const refreshText = data.refreshed_at
    ? ` Dashboard rollup refreshed ${new Date(data.refreshed_at).toLocaleString()}.`
    : "";
  return `${scope}: ${formatNumber(data.unique_records)} unique records from ${formatNumber(data.raw_records)} raw rows across ${formatNumber(data.dataset_count)} dataset${Number(data.dataset_count) === 1 ? "" : "s"}.${duplicateText}${sourceText}${refreshText}`;
}
