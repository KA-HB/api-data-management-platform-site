import { requireAuth, renderShell } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setButtonBusy, startProgress, stopProgress, toast, updateProgress } from "./ui.js";

const profile = await requireAuth();
let editingDatasetId = null;
if (profile) {
  renderShell(profile);
  loadDatasets();
  $("#dataset-form")?.addEventListener("submit", saveDataset);
  $("#upload-form")?.addEventListener("submit", uploadData);
}

async function loadDatasets() {
  const { data, error } = await supabase.from("datasets").select("*").order("created_at", { ascending: false });
  if (error) return toast(error.message, "error");
  const tbody = $("#datasets-body");
  if (!tbody) return;
  renderRows(tbody, data, [
    (r) => `<strong>${escapeHtml(r.name)}</strong><br><span>${escapeHtml(r.description || "")}</span>`,
    (r) => escapeHtml(r.source_type),
    (r) => String(r.record_count || 0),
    (r) => escapeHtml(new Date(r.created_at).toLocaleDateString()),
    (r) => profile.role === "admin" ? `<button class="secondary" data-edit="${r.id}">Edit</button> <button class="danger" data-delete="${r.id}">Delete</button>` : `<a class="button secondary" href="./search.html">Open</a>`,
  ]);
  tbody.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => editDataset(data.find((row) => row.id === btn.dataset.edit))));
  tbody.querySelectorAll("[data-delete]").forEach((btn) => btn.addEventListener("click", () => deleteDataset(btn.dataset.delete)));
}

function editDataset(dataset) {
  if (!dataset) return;
  editingDatasetId = dataset.id;
  $("#dataset-name").value = dataset.name || "";
  $("#dataset-description").value = dataset.description || "";
  $("#dataset-source").value = dataset.source_type || "upload";
  const button = $("#dataset-form button");
  if (button) button.textContent = "Save Changes";
  toast(`Editing ${dataset.name}. Submit the form to save changes.`, "info");
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
  const { error } = await query;
  setButtonBusy(button, false);
  if (error) return toast(error.message, "error");
  event.target.reset();
  editingDatasetId = null;
  if (button) button.textContent = "Create";
  toast(wasEditing ? "Dataset updated." : "Dataset created.", "success");
  loadDatasetOptions();
  loadDatasets();
}

async function deleteDataset(id) {
  const button = document.querySelector(`[data-delete="${id}"]`);
  setButtonBusy(button, true, "Deleting...");
  const { error } = await supabase.from("datasets").delete().eq("id", id);
  setButtonBusy(button, false);
  if (error) return toast(error.message, "error");
  toast("Dataset deleted.", "success");
  loadDatasetOptions();
  loadDatasets();
}

async function uploadData(event) {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector("button");
  const progress = startProgress("Preparing import...", { indeterminate: false });
  setButtonBusy(button, true, "Importing...");
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
  const records = await Promise.all(rows.map(async (row) => ({
    dataset_id: datasetId,
    json_data: row,
    source_hash: await sha256(JSON.stringify(row)),
  })));

  for (let i = 0; i < records.length; i += 1000) {
    const batch = records.slice(i, i + 1000);
    updateProgress(progress, `Uploading ${Math.min(i + batch.length, records.length).toLocaleString()} of ${records.length.toLocaleString()} records...`, 35 + Math.round((i / records.length) * 55));
    const { error } = await supabase.from("records").upsert(batch, { onConflict: "dataset_id,source_hash" });
    if (error) {
      setButtonBusy(button, false);
      return stopProgress(progress, error.message, "error");
    }
  }

  updateProgress(progress, "Finalizing dataset...", 95);
  await supabase.from("datasets").update({ header_signature: headerSignature, record_count: records.length }).eq("id", datasetId);
  await supabase.rpc("log_activity", { action_name: "dataset.uploaded", details_json: { dataset_id: datasetId, rows: records.length } });
  setButtonBusy(button, false);
  stopProgress(progress, `Imported ${records.length.toLocaleString()} records.`, "success");
  event.target.reset();
  loadDatasetOptions();
  loadDatasets();
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
  const { data } = await supabase.from("datasets").select("id,name").order("name");
  select.innerHTML = `<option value="">Choose dataset</option>${(data || []).map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("")}`;
}

loadDatasetOptions();
