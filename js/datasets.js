import { requireAuth, renderShell } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, toast } from "./ui.js";

const profile = await requireAuth();
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
  tbody.querySelectorAll("[data-delete]").forEach((btn) => btn.addEventListener("click", () => deleteDataset(btn.dataset.delete)));
}

async function saveDataset(event) {
  event.preventDefault();
  const payload = {
    name: $("#dataset-name").value.trim(),
    description: $("#dataset-description").value.trim(),
    source_type: $("#dataset-source").value,
    created_by: profile.id,
  };
  const { error } = await supabase.from("datasets").insert(payload);
  if (error) return toast(error.message, "error");
  event.target.reset();
  toast("Dataset created.");
  loadDatasets();
}

async function deleteDataset(id) {
  const { error } = await supabase.from("datasets").delete().eq("id", id);
  if (error) return toast(error.message, "error");
  toast("Dataset deleted.");
  loadDatasets();
}

async function uploadData(event) {
  event.preventDefault();
  const file = $("#data-file").files[0];
  const datasetId = $("#upload-dataset").value;
  if (!file || !datasetId) return toast("Choose a dataset and a CSV or Excel file.", "error");

  const rows = await parseFile(file);
  if (!rows.length) return toast("No records found in the file.", "error");

  const headerSignature = Object.keys(rows[0]).sort().join("|");
  const records = await Promise.all(rows.map(async (row) => ({
    dataset_id: datasetId,
    json_data: row,
    source_hash: await sha256(JSON.stringify(row)),
  })));

  for (let i = 0; i < records.length; i += 1000) {
    const batch = records.slice(i, i + 1000);
    const { error } = await supabase.from("records").upsert(batch, { onConflict: "dataset_id,source_hash" });
    if (error) return toast(error.message, "error");
  }

  await supabase.from("datasets").update({ header_signature: headerSignature, record_count: records.length }).eq("id", datasetId);
  await supabase.rpc("log_activity", { action_name: "dataset.uploaded", details_json: { dataset_id: datasetId, rows: records.length } });
  toast(`Imported ${records.length.toLocaleString()} records.`);
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
