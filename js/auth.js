import { supabase } from "./supabaseClient.js";
import { assertConfigured } from "./config.js";

export async function currentProfile() {
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData.session;
  if (!session) return null;
  const { data, error } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();
  if (error || !data?.active) return null;
  return { ...data, session };
}

export async function requireAuth(requiredRole = null) {
  if (!assertConfigured()) {
    document.body.insertAdjacentHTML("afterbegin", "<div class='notice'>Configure js/config.js with your Supabase URL and anon key.</div>");
  }
  const profile = await currentProfile();
  if (!profile) {
    location.href = "../index.html";
    return null;
  }
  if (requiredRole && profile.role !== requiredRole) {
    location.href = profile.role === "admin" ? "./admin-dashboard.html" : "./user-dashboard.html";
    return null;
  }
  return profile;
}

export async function redirectFromLogin() {
  const profile = await currentProfile();
  if (!profile) return;
  location.href = profile.role === "admin" ? "./pages/admin-dashboard.html" : "./pages/user-dashboard.html";
}

export async function logout() {
  await supabase.auth.signOut();
  location.href = "../index.html";
}

export function bindLogout() {
  const btn = document.querySelector("[data-logout]");
  if (btn) btn.addEventListener("click", logout);
}

export function renderShell(profile) {
  document.querySelectorAll("[data-admin-only]").forEach((el) => {
    el.classList.toggle("hidden", profile.role !== "admin");
  });
  const email = document.querySelector("[data-user-email]");
  if (email) email.textContent = profile.email;
  bindLogout();
}
