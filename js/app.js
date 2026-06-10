import { supabase } from "./supabaseClient.js";
import { redirectFromLogin } from "./auth.js";
import { $, setButtonBusy, toast } from "./ui.js";

const loginForm = $("#login-form");
const resetForm = $("#reset-form");

redirectFromLogin();

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button");
  setButtonBusy(button, true, "Logging in...");
  const email = $("#email").value.trim();
  const password = $("#password").value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  setButtonBusy(button, false);
  if (error) return toast(error.message, "error");
  await redirectFromLogin();
});

resetForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = resetForm.querySelector("button");
  setButtonBusy(button, true, "Sending...");
  const email = $("#reset-email").value.trim();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${location.origin}${location.pathname}`,
  });
  setButtonBusy(button, false);
  toast(error ? error.message : "Password reset email sent.", error ? "error" : "info");
});
