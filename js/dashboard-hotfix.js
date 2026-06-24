import { FUNCTIONS_BASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { supabase } from "./supabaseClient.js";
import { escapeHtml, setButtonBusy, startProgress, stopProgress } from "./ui.js";

const JOBCODE_DATASET_NAME = "QuickBooks Time Job Codes";
const HOTFIX_BATCH_SIZE = 1000;

main().catch((error) => console.warn("Dashboard hotfix failed", error));

async function main() {
  wireQuickBooksSyncHotfix();
  const options = await loadBestJobcodeOptions();
  if (hasUsableJobcodeOptions(options)) applyJobcodeOptions(options);
}

function wireQuickBooksSyncHotfix() {
  const button = document.querySelector("#dashboard-qb-sync");
  if (!button) return;
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
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
      window.location.reload();
    } catch (error) {
      console.error("QuickBooks Time sync request failed", error);
      const message = /fetch/i.test(error.message || "")
        ? "Could not reach the QuickBooks Time sync function. Refresh, sign in again, then retry. If it continues, redeploy the qbtime Edge Function."
        : error.message;
      stopProgress(progress, message, "error");
    } finally {
      setButtonBusy(button, false);
    }
  }, true);
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

async function loadBestJobcodeOptions() {
  const rpcResult = await supabase.rpc("dashboard_qbtime_filter_options");
  const rpcOptions = normalizeFilterOptions(rpcResult.data);
  if (hasUsableJobcodeOptions(rpcOptions)) return rpcOptions;
  const referenceOptions = await loadJobcodeReferenceOptions();
  return mergeFilterOptions(rpcOptions, referenceOptions);
}

function emptyQbFilterOptions() {
  return { employees: [], jobcode_level1: [], jobcode_level2: [], jobcode_level3: [], service_items: [] };
}

function normalizeFilterOptions(options = {}) {
  const fallback = emptyQbFilterOptions();
  return {
    employees: Array.isArray(options?.employees) ? options.employees : fallback.employees,
    jobcode_level1: Array.isArray(options?.jobcode_level1) ? options.jobcode_level1 : fallback.jobcode_level1,
    jobcode_level2: Array.isArray(options?.jobcode_level2) ? options.jobcode_level2 : fallback.jobcode_level2,
    jobcode_level3: Array.isArray(options?.jobcode_level3) ? options.jobcode_level3 : fallback.jobcode_level3,
    service_items: Array.isArray(options?.service_items) ? options.service_items : fallback.service_items,
  };
}

function hasUsableJobcodeOptions(options = {}) {
  return usableJobcodeOptionCount(options.jobcode_level1) > 0 && usableJobcodeOptionCount(options.jobcode_level2) > 0;
}

function usableJobcodeOptionCount(rows = []) {
  return (rows || []).filter((row) => cleanJobcodeLabel(row?.name)).length;
}

async function loadJobcodeReferenceOptions() {
  try {
    const { data: datasets, error: datasetError } = await supabase.from("datasets").select("id").eq("name", JOBCODE_DATASET_NAME).limit(1);
    if (datasetError) throw datasetError;
    const datasetId = datasets?.[0]?.id;
    if (!datasetId) return emptyQbFilterOptions();
    const rows = [];
    for (let start = 0; start < 10000; start += HOTFIX_BATCH_SIZE) {
      const { data, error } = await supabase.from("records").select("json_data").eq("dataset_id", datasetId).range(start, start + HOTFIX_BATCH_SIZE - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < HOTFIX_BATCH_SIZE) break;
    }
    return buildJobcodeReferenceOptions(rows);
  } catch (error) {
    console.warn("Dashboard job-code reference hotfix failed", error);
    return emptyQbFilterOptions();
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
    jobcodes.set(rawId, { raw_id: rawId, raw_parent_id: parentId && parentId !== "0" ? parentId : "", name });
  }
  const level1 = new Map();
  const level2 = new Map();
  const level3 = new Map();
  for (const rawId of jobcodes.keys()) {
    const path = jobcodeReferencePath(rawId, jobcodes);
    if (!path.level1_name) continue;
    level1.set(path.level1_name, { id: path.level1_name, name: path.level1_name, raw_id: path.level1_raw_id });
    if (path.level2_name) level2.set(`${path.level1_name}|${path.level2_name}`, { id: path.level2_name, name: path.level2_name, parent_id: path.level1_name, parent_name: path.level1_name, raw_id: path.level2_raw_id, parent_raw_id: path.level1_raw_id });
    if (path.level3_name) level3.set(`${path.level1_name}|${path.level2_name}|${path.level3_name}`, { id: path.level3_name, name: path.level3_name, parent_id: path.level2_name, parent_name: path.level2_name, grandparent_id: path.level1_name, grandparent_name: path.level1_name, raw_id: path.level3_raw_id, parent_raw_id: path.level2_raw_id, grandparent_raw_id: path.level1_raw_id });
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
  if (root) return { level1_name: root.name, level1_raw_id: root.raw_id, level2_name: parent.name, level2_raw_id: parent.raw_id, level3_name: leaf.name, level3_raw_id: leaf.raw_id };
  if (parent) return { level1_name: parent.name, level1_raw_id: parent.raw_id, level2_name: leaf.name, level2_raw_id: leaf.raw_id };
  return { level1_name: leaf.name, level1_raw_id: leaf.raw_id };
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
    rows.set(key, { ...row, id: String(row.id || name), name });
  }
  return sortByName(Array.from(rows.values()));
}

function applyJobcodeOptions(options) {
  fillSelect("#filter-jobcode-1", options.jobcode_level1, "All Job Code 1");
  fillSelect("#filter-jobcode-2", options.jobcode_level2, "All Job Code 2");
  fillSelect("#filter-jobcode-3", options.jobcode_level3, "All Job Code 3");
  fillDatalist("#project-jobcode-1-options", options.jobcode_level1);
  fillDatalist("#project-jobcode-2-options", options.jobcode_level2, (row) => row.parent_name);
  document.querySelector("#filter-jobcode-1")?.addEventListener("change", () => refreshDependentJobFilters(options));
  document.querySelector("#filter-jobcode-2")?.addEventListener("change", () => refreshDependentJobFilters(options));
  refreshDependentJobFilters(options);
}

function refreshDependentJobFilters(options) {
  const selectedLevel1 = document.querySelector("#filter-jobcode-1")?.value || "";
  const selectedLevel2 = document.querySelector("#filter-jobcode-2")?.value || "";
  const selectedLevel3 = document.querySelector("#filter-jobcode-3")?.value || "";
  const level2 = (options.jobcode_level2 || []).filter((row) => !selectedLevel1 || row.parent_id === selectedLevel1 || row.parent_name === selectedLevel1);
  fillSelect("#filter-jobcode-2", level2, "All Job Code 2");
  if (selectedLevel2 && level2.some((row) => row.id === selectedLevel2 || row.name === selectedLevel2)) document.querySelector("#filter-jobcode-2").value = selectedLevel2;
  const nextLevel2 = document.querySelector("#filter-jobcode-2")?.value || "";
  const level3 = (options.jobcode_level3 || []).filter((row) => {
    if (nextLevel2) return row.parent_id === nextLevel2 || row.parent_name === nextLevel2;
    if (selectedLevel1) return row.grandparent_id === selectedLevel1 || row.grandparent_name === selectedLevel1;
    return true;
  });
  fillSelect("#filter-jobcode-3", level3, "All Job Code 3");
  if (selectedLevel3 && level3.some((row) => row.id === selectedLevel3 || row.name === selectedLevel3)) document.querySelector("#filter-jobcode-3").value = selectedLevel3;
}

function fillSelect(selector, rows, placeholder) {
  const select = document.querySelector(selector);
  if (!select) return;
  const current = select.value;
  const cleanRows = (rows || []).filter((row) => row?.id && row?.name && cleanJobcodeLabel(row.name));
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${cleanRows.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`).join("")}`;
  if (current && cleanRows.some((row) => row.id === current || row.name === current)) select.value = current;
}

function fillDatalist(selector, rows, labelFn = null) {
  const list = document.querySelector(selector);
  if (!list) return;
  const seen = new Set();
  const cleanRows = (rows || []).filter((row) => row?.id && row?.name && cleanJobcodeLabel(row.name) && !seen.has(row.name) && seen.add(row.name));
  list.innerHTML = cleanRows.map((row) => `<option value="${escapeHtml(row.name)}"${labelFn ? ` label="${escapeHtml(labelFn(row) || "")}"` : ""}></option>`).join("");
}

function cleanEmployeeLabel(value) {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  return label && !/^\d+$/.test(label) ? label : null;
}

function cleanJobcodeLabel(value) {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  if (!label || label === "0" || /^\d+$/.test(label)) return null;
  if (/^(unassigned|not specified|no job code( [123])?)$/i.test(label)) return null;
  return label;
}

function cleanServiceLabel(value) {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  if (!label || /^null$/i.test(label) || /^undefined$/i.test(label)) return null;
  return label;
}

function sortByName(rows) {
  return rows.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}
