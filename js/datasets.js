import { requireAuth, renderShell } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setButtonBusy, startProgress, stopProgress, toast, updateProgress } from "./ui.js";

const profile = await requireAuth();
let editingDatasetId = null;
let datasetsById = new Map();

const PRIMARY_QBTIME_DATASET = "QuickBooks Time Timesheets";
const HIDDEN_QBTIME_SUPPORT_DATASETS = new Set([
  "QuickBooks Time Customers",
  "QuickBooks Time Employees",
  "QuickBooks Time Groups",
  "QuickBooks Time Job Codes",
  "QuickBooks Time PTO",
  "QuickBooks Time Custom Fields",
]);

function isHiddenQbtimeSupportDataset(dataset) {
  return HIDDEN_QBTIME_SUPPORT_DATASETS.has(dataset?.name || "");
}

function visibleDatasets(rows = []) {
  return rows.filter((dataset) => !isHiddenQbtimeSupportDataset(dataset));
}
if (profile) {
  renderShell(profile);
  loadDatasets();
  $("#dataset-form")?.addEventListener("submit", saveDataset);
  $("#upload-form")?.addEventListener("submit", uploadData);
  $("#dataset-cancel-edit")?.addEventListener("click", cancelEdit);
  $("#datasets-body")?.addEventListener("click", handleDatasetAction);
}

async function loadDatasets() {
  const { data, error } = await supabase.from("datasets").select("*").neq("name", "QuickBooks Time PTO").order("created_at", { ascending: false });
  if (error) return toast(error.message, "error");
  const visibleRows = visibleDatasets(data || []);
  datasetsById = new Map(visibleRows.map((dataset) => [dataset.id, dataset]));
  const tbody = $("#datasets-body");
  if (!tbody) return;
  renderRows(tbody, visibleRows, [
    (r) => `<strong>${escapeHtml(r.name)}</strong><br><span>${escapeHtml(r.description || "")}</span>`,
    (r) => escapeHtml(r.source_type),
    (r) => String(r.record_count || 0),
    (r) => escapeHtml(new Date(r.created_at).toLocaleDateString()),
    (r) => profile.role === "admin" ? `<div class="form-actions"><button class="secondary" type="button" data-action="edit-dataset" data-dataset-id="${r.id}">Edit</button><button class="danger" type="button" data-action="delete-dataset" data-dataset-id="${r.id}">Delete</button></div>` : `<a class="button secondary" href="./search.html">Open</a>`,
  ]);
  markEditingRow();
}

function handleDatasetAction(event) {
  const button = event.target.closest("[data-action][data-dataset-id]");
  if (!button) return;
  const { action, datasetId } = button.dataset;
  if (action === "edit-dataset") {
    editDataset(datasetsById.get(datasetId));
    return;
  }
  if (action === "delete-dataset") deleteDataset(datasetId);
}

function editDataset(dataset) {
  if (!dataset) return toast("That dataset is no longer available. Refreshing the list.", "error");
  editingDatasetId = dataset.id;
  $("#dataset-name").value = dataset.name || "";
  $("#dataset-description").value = dataset.description || "";
  $("#dataset-source").value = dataset.source_type || "upload";
  setEditMode(dataset);
  markEditingRow();
  $("#dataset-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#dataset-name")?.focus();
}

function setEditMode(dataset) {
  $("#dataset-form-title").textContent = dataset ? "Edit Dataset" : "Create Dataset";
  $("#dataset-save-button").textContent = dataset ? "Save Changes" : "Create";
  $("#dataset-cancel-edit")?.classList.toggle("hidden", !dataset);
  const notice = $("#dataset-edit-notice");
  if (!notice) return;
  if (dataset) {
    notice.textContent = `Editing ${dataset.name}. Save changes or cancel to return to creating a new dataset.`;
    notice.classList.remove("hidden");
  } else {
    notice.textContent = "";
    notice.classList.add("hidden");
  }
}

function cancelEdit() {
  editingDatasetId = null;
  $("#dataset-form")?.reset();
  setEditMode(null);
  markEditingRow();
}

async function saveDataset(event) {
  event.preventDefault();
  const wasEditing = Boolean(editingDatasetId);
  const button = event.submitter || event.target.querySelector("button");
  setButtonBusy(button, true, editingDatasetId ? "Saving..." : "Creating...");
  const payload = {
    name: $("#dataset-name").value.trim(),
    description: $("#dataset-description").value.trim(),
    source_type: $("#dataset-source").value,
    created_by: profile.id,
  };
  const query = editingDatasetId
    ? supabase.from("datasets").update(payload).eq("id", editingDatasetId)
    : supabase.from("datasets").insert(payload);
  try {
    const { error } = await query;
    if (error) return toast(error.message, "error");
    event.target.reset();
    editingDatasetId = null;
    setEditMode(null);
    toast(wasEditing ? "Dataset updated." : "Dataset created.", "success");
    loadDatasetOptions();
    loadDatasets();
  } finally {
    setButtonBusy(button, false);
    $("#dataset-save-button").textContent = editingDatasetId ? "Save Changes" : "Create";
  }
}

async function deleteDataset(id) {
  const dataset = datasetsById.get(id);
  if (!dataset) return toast("That dataset is no longer visible. Refreshing the list.", "error");
  if (dataset.name === PRIMARY_QBTIME_DATASET) {
    return toast("QuickBooks Time Timesheets is the primary synced dataset and should stay available for dashboards.", "info");
  }
  if (!confirm(`Delete ${dataset.name}? This removes its records and permissions.`)) return;

  const button = document.querySelector(`[data-action="delete-dataset"][data-dataset-id="${id}"]`);
  setButtonBusy(button, true, "Deleting...");
  try {
    const { data, error } = await supabase.rpc("delete_dataset_admin", { dataset_uuid: id });
    if (error) return toast(error.message, "error");
    if (editingDatasetId === id) cancelEdit();
    const records = Number(data?.records_deleted || 0).toLocaleString();
    toast(`Dataset deleted. Removed ${records} record${records === "1" ? "" : "s"}.`, "success");
    loadDatasetOptions();
    loadDatasets();
  } finally {
    setButtonBusy(button, false);
  }
}
async function uploadData(event) {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector("button");
  const progress = startProgress("Preparing import...", { indeterminate: false });
  setButtonBusy(button, true, "Importing...");
  try {
    const file = $("#data-file").files[0];
    const datasetId = $("#upload-dataset").value;
    if (!file || !datasetId) {
      setButtonBusy(button, false);
      return stopProgress(progress, "Choose a dataset and a CSV or Excel file.", "error");
    }

    updateProgress(progress, "Parsing file...", 10);
    const rows = await parseFile(file);
    if (!rows.length) {
      setButtonBusy(button, false);
      return stopProgress(progress, "No records found in the file.", "error");
    }

    updateProgress(progress, `Hashing ${rows.length.toLocaleString()} records...`, 30);
    const headerSignature = Object.keys(rows[0]).sort().join("|");
    const dedupedRecords = new Map();
    for (const row of rows) {
      const sourceHash = await sha256(JSON.stringify(row));
      dedupedRecords.set(sourceHash, {
        dataset_id: datasetId,
        json_data: row,
        source_hash: sourceHash,
      });
    }
    const records = Array.from(dedupedRecords.values());
    const skippedDuplicates = rows.length - records.length;

    updateProgress(progress, skippedDuplicates ? `Uploading ${records.length.toLocaleString()} unique records (${skippedDuplicates.toLocaleString()} duplicates skipped)...` : `Uploading ${records.length.toLocaleString()} records...`, 35);
    for (let i = 0; i < records.length; i += 1000) {
      const batch = records.slice(i, i + 1000);
      updateProgress(progress, `Uploading ${Math.min(i + batch.length, records.length).toLocaleString()} of ${records.length.toLocaleString()} unique records...`, 35 + Math.round((i / records.length) * 55));
      const { error } = await supabase.from("records").upsert(batch, { onConflict: "dataset_id,source_hash" });
      if (error) return stopProgress(progress, error.message, "error");
    }

    updateProgress(progress, "Finalizing dataset...", 95);
    await supabase.from("datasets").update({ header_signature: headerSignature, record_count: records.length }).eq("id", datasetId);
    await supabase.rpc("refresh_dashboard_experience_records");
    await supabase.rpc("log_activity", { action_name: "dataset.uploaded", details_json: { dataset_id: datasetId, rows: records.length, duplicates_skipped: skippedDuplicates } });
    stopProgress(progress, skippedDuplicates ? `Imported ${records.length.toLocaleString()} unique records. Skipped ${skippedDuplicates.toLocaleString()} duplicate rows.` : `Imported ${records.length.toLocaleString()} records.`, "success");
    event.target.reset();
    loadDatasetOptions();
    loadDatasets();
  } catch (error) {
    stopProgress(progress, error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function parseFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "csv") {
    return new Promise((resolve, reject) => {
      Papa.parse(file, { header: true, skipEmptyLines: true, complete: (r) => resolve(r.data), error: reject });
    });
  }
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

async function sha256(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadDatasetOptions() {
  const select = $("#upload-dataset");
  if (!select) return;
  const { data } = await supabase.from("datasets").select("id,name").neq("name", "QuickBooks Time PTO").order("name");
  const options = visibleDatasets(data || []);
  select.innerHTML = `<option value="">Choose dataset</option>${options.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("")}`;
}

loadDatasetOptions();

function markEditingRow() {
  document.querySelectorAll("#datasets-body tr").forEach((row) => {
    const rowId = row.querySelector("[data-dataset-id]")?.dataset.datasetId;
    row.classList.toggle("is-editing", Boolean(editingDatasetId && rowId === editingDatasetId));
  });
}
