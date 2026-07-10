import { supabase } from "./supabaseClient.js";
import { AUTH_TIMEOUT_REASON_KEY, redirectFromLogin } from "./auth.js";
import { $, initTheme, setButtonBusy, toast } from "./ui.js";

const azureLogin = $("#azure-login");
const authMessage = $("#auth-message");

initTheme();
await redirectFromLogin();
showTimeoutMessage();

function showAuthMessage(message) {
  if (authMessage) {
    authMessage.textContent = message;
    authMessage.hidden = false;
  }
}


function showTimeoutMessage() {
  let reason = "";
  try {
    reason = localStorage.getItem(AUTH_TIMEOUT_REASON_KEY) || "";
  } catch {
    reason = "";
  }
  if (reason) showAuthMessage(reason);
}

function microsoftPromptMode() {
  try {
    return localStorage.getItem(AUTH_TIMEOUT_REASON_KEY) ? "login" : "select_account";
  } catch {
    return "login";
  }
}
azureLogin?.addEventListener("click", async () => {
  setButtonBusy(azureLogin, true, "Redirecting...");
  showAuthMessage("Redirecting to Microsoft...");
  const redirectTo = new URL("./pages/auth-callback.html", location.href).toString();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "azure",
    options: {
      scopes: "email",
      redirectTo,
      queryParams: { prompt: microsoftPromptMode() },
    },
  });

  if (error) {
    setButtonBusy(azureLogin, false);
    toast(error.message, "error");
  }
});
