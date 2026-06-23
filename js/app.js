import { supabase } from "./supabaseClient.js";
import { redirectFromLogin } from "./auth.js";
import { $, initTheme, setButtonBusy, toast } from "./ui.js";

const azureLogin = $("#azure-login");
const authMessage = $("#auth-message");

initTheme();
await handleAuthCallback();
await routeAuthenticatedUser();

supabase.auth.onAuthStateChange(async (event) => {
  if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
    await routeAuthenticatedUser();
  }
});

async function handleAuthCallback() {
  const url = new URL(location.href);
  const authError = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (authError) {
    showAuthMessage(authError);
    return;
  }

  if (!url.searchParams.has("code")) return;

  showAuthMessage("Completing Microsoft sign-in...");
  let { data } = await supabase.auth.getSession();
  if (!data.session) {
    const { error } = await supabase.auth.exchangeCodeForSession(url.searchParams.get("code"));
    if (error) {
      const current = await supabase.auth.getSession();
      if (!current.data.session) {
        showAuthMessage(`Microsoft sign-in could not be completed: ${error.message}`);
        return;
      }
    }
  }

  cleanAuthCallbackUrl(url);
}

async function routeAuthenticatedUser() {
  const session = await waitForSession();
  if (!session) return false;

  showAuthMessage("Checking your Microsoft account access...");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const redirected = await redirectFromLogin();
    if (redirected) return true;
    await sleep(300);
  }

  showAuthMessage("Microsoft sign-in succeeded, but this account is not active for this app. Use a Hayat Brown tenant account or ask an admin to enable your profile.");
  return false;
}

async function waitForSession() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { data } = await supabase.auth.getSession();
    if (data.session) return data.session;
    await sleep(250);
  }
  return null;
}

function cleanAuthCallbackUrl(url) {
  ["code", "state", "error", "error_description"].forEach((param) => url.searchParams.delete(param));
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function showAuthMessage(message) {
  if (authMessage) {
    authMessage.textContent = message;
    authMessage.hidden = false;
  }
}

azureLogin?.addEventListener("click", async () => {
  setButtonBusy(azureLogin, true, "Redirecting...");
  showAuthMessage("Redirecting to Microsoft...");
  const redirectTo = location.href.split("#")[0];
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "azure",
    options: { redirectTo },
  });

  if (error) {
    setButtonBusy(azureLogin, false);
    toast(error.message, "error");
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
