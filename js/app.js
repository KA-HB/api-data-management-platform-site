import { supabase } from "./supabaseClient.js";
import { redirectFromLogin } from "./auth.js";
import { $, initTheme, setButtonBusy, toast } from "./ui.js";

const azureLogin = $("#azure-login");
const authMessage = $("#auth-message");

initTheme();
await redirectFromLogin();

function showAuthMessage(message) {
  if (authMessage) {
    authMessage.textContent = message;
    authMessage.hidden = false;
  }
}

azureLogin?.addEventListener("click", async () => {
  setButtonBusy(azureLogin, true, "Redirecting...");
  showAuthMessage("Redirecting to Microsoft...");
  const redirectTo = new URL("./pages/auth-callback.html", location.href).toString();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "azure",
    options: {
      redirectTo,
      queryParams: { prompt: "select_account" },
    },
  });

  if (error) {
    setButtonBusy(azureLogin, false);
    toast(error.message, "error");
  }
});
