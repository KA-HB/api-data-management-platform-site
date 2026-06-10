import { requireAuth, renderShell } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setButtonBusy, startProgress, stopProgress, toast } from "./ui.js";

const profile = await requireAuth();
let lastRows = [];
if (profile) {
  renderShell(profile);
  await loadDatasetOptions();
  $("#search-form")?.addEventListener("submit", runSearch);
  $("#run-search")?.addEventListener("click", runSearch);
  $("#export-json")?.addEventListener("click", exportJson);
}

async function loadDatasetOptions() {
  const { data, error } = await supabase.from("datasets").select("id,name").order("name");
  if (error) return toast(error.message, "error");
  $("#dataset").innerHTML = `<option value="">Choose dataset</option>${(data || []).map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("")}`;
}

async function runSearch(event) {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector("button");
  const datasetId = $("#dataset").value;
  if (!datasetId) return toast("Choose a dataset to search.", "error");
  const term = $("#term").value.trim();
  const progress = startProgress("Searching records...");
  setButtonBusy(button, true, "Searching...");
  const { data, error } = await supabase.rpc("search_dataset_records", {
    dataset_uuid: datasetId,
    search_term: term,
    limit_count: Number($("#page-size").value || 50),
    offset_count: 0,
  });
  setButtonBusy(button, false);
  if (error) return stopProgress(progress, error.message, "error");
  lastRows = data || [];
  renderRows($("#records-body"), lastRows, [
    (r) => escapeHtml(r.id),
    (r) => `<pre>${escapeHtml(JSON.stringify(r.json_data, null, 2))}</pre>`,
    (r) => escapeHtml(new Date(r.created_at).toLocaleString()),
  ]);
  stopProgress(progress, `${lastRows.length.toLocaleString()} records found.`, lastRows.length ? "success" : "info");
}

function exportJson() {
  if (!lastRows.length) return toast("Run a search before exporting.", "error");
  const blob = new Blob([JSON.stringify(lastRows, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "dataset-export.json";
  link.click();
  URL.revokeObjectURL(url);
}
