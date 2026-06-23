import { supabase } from "./supabaseClient.js";
import { redirectFromLogin } from "./auth.js";
import { $, initTheme, setButtonBusy, toast } from "./ui.js";

const azureLogin = $("#azure-login");
const authMessage = $("#auth-message");

initTheme();
await routeAuthenticatedUser();

supabase.auth.onAuthStateChange(async (event) => {
  if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
    await routeAuthenticatedUser();
  }
});

async function routeAuthenticatedUser() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) return false;
  showAuthMessage("Checking your Microsoft account access...");
  const redirected = await redirectFromLogin();
  if (!redirected) {
    showAuthMessage("Microsoft sign-in succeeded, but this account is not active for this app. Use a Hayat Brown tenant account or ask an admin to enable your profile.");
    return false;
  }
  return true;
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
