import { supabase } from "./supabaseClient.js";
import { AUTH_TIMEOUT_REASON_KEY, redirectFromLogin } from "./auth.js?v=20260811b";
import { $, initTheme, setButtonBusy, toast } from "./ui.js";

const azureLogin = $("#azure-login");
const authMessage = $("#auth-message");

initTheme();
azureLogin?.addEventListener("click", beginMicrosoftSignIn);
showTimeoutMessage();
void redirectFromLogin();

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
async function beginMicrosoftSignIn() {
  const prompt = microsoftPromptMode();
  setButtonBusy(azureLogin, true, "Redirecting...");
  if (authMessage) authMessage.hidden = true;
  const redirectTo = new URL("./pages/auth-callback.html", location.href).toString();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "azure",
    options: {
      scopes: "email",
      redirectTo,
      queryParams: { prompt },
    },
  });

  if (error) {
    setButtonBusy(azureLogin, false);
    showAuthMessage(error.message);
    toast(error.message, "error");
  }
}
