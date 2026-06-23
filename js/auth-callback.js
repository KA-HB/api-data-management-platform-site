import { supabase } from "./supabaseClient.js";
import { currentProfile, dashboardPath } from "./auth.js";
import { initTheme } from "./ui.js";

const message = document.querySelector("#auth-callback-message");

initTheme();
await completeSignIn();

async function completeSignIn() {
  const url = new URL(location.href);
  const authError = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (authError) {
    showMessage(authError);
    return;
  }

  if (url.searchParams.has("code")) {
    showMessage("Completing Microsoft sign-in...");
    const { error } = await supabase.auth.exchangeCodeForSession(url.searchParams.get("code"));
    if (error) {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        showMessage(`Microsoft sign-in could not be completed: ${error.message}`);
        return;
      }
    }
    cleanAuthCallbackUrl(url);
  }

  const session = await waitForSession();
  if (!session) {
    showMessage("No Microsoft session was returned. Please start sign-in again.");
    setTimeout(() => {
      location.href = "../index.html";
    }, 1600);
    return;
  }

  showMessage("Checking your account access...");
  const profile = await waitForProfile();
  if (!profile) {
    showMessage("Microsoft sign-in succeeded, but this account is not active for this app. Use a Hayat Brown tenant account or ask an admin to enable your profile.");
    return;
  }

  location.replace(dashboardPath(profile.role));
}

async function waitForSession() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const { data } = await supabase.auth.getSession();
    if (data.session) return data.session;
    await sleep(250);
  }
  return null;
}

async function waitForProfile() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const profile = await currentProfile();
    if (profile) return profile;
    await sleep(350);
  }
  return null;
}

function cleanAuthCallbackUrl(url) {
  ["code", "state", "error", "error_description"].forEach((param) => url.searchParams.delete(param));
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function showMessage(text) {
  if (message) message.textContent = text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
