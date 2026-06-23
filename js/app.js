import { supabase } from "./supabaseClient.js";
import { redirectFromLogin } from "./auth.js";
import { $, initTheme, setButtonBusy, toast } from "./ui.js";

const azureLogin = $("#azure-login");

initTheme();
redirectFromLogin();

azureLogin?.addEventListener("click", async () => {
  setButtonBusy(azureLogin, true, "Redirecting...");
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
