import { supabase } from "./supabaseClient.js";
import { assertConfigured } from "./config.js";
import { initTheme } from "./ui.js";

const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const SESSION_META_KEY = "data-platform-sso-session";
export const AUTH_TIMEOUT_REASON_KEY = "data-platform-auth-timeout-reason";

let sessionWatcherStarted = false;
let sessionTimeoutInProgress = false;
let lastActivityWrite = 0;

export async function currentProfile() {
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData.session;
  if (!session) return null;
  if (!(await enforceSessionPolicy(session))) return null;

  let { data, error } = await supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if ((error || !data) && session.user.id) {
    const { error: syncError } = await supabase.rpc("ensure_current_profile");
    if (!syncError) {
      const refreshed = await supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
      data = refreshed.data;
      error = refreshed.error;
    }
  }

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
  if (!profile) return false;
  location.href = dashboardPath(profile.role);
  return true;
}

export function dashboardPath(role) {
  const page = role === "admin" ? "admin-dashboard.html" : "user-dashboard.html";
  return inPagesDirectory() ? `./${page}` : `./pages/${page}`;
}

function inPagesDirectory() {
  return location.pathname
    .replace(/\\/g, "/")
    .split("/")
    .includes("pages");
}

export async function logout() {
  clearSessionTracking();
  await supabase.auth.signOut();
  location.href = "../index.html";
}

export function bindLogout() {
  const btn = document.querySelector("[data-logout]");
  if (btn) btn.addEventListener("click", logout);
}

export function renderShell(profile) {
  startSessionWatcher();
  initTheme();
  const nav = document.querySelector(".nav");
  if (nav && !document.querySelector("[data-theme-toggle]")) {
    const themeButton = document.createElement("button");
    themeButton.type = "button";
    themeButton.className = "secondary theme-toggle";
    themeButton.dataset.themeToggle = "";
    nav.appendChild(themeButton);
    initTheme();
  }
  document.querySelectorAll("[data-admin-only]").forEach((el) => {
    el.classList.toggle("hidden", profile.role !== "admin");
  });
  const email = document.querySelector("[data-user-email]");
  if (email) email.textContent = profile.email;
  bindLogout();
}

export function clearAuthTimeoutMessage() {
  try {
    localStorage.removeItem(AUTH_TIMEOUT_REASON_KEY);
  } catch {
    // Ignore storage failures.
  }
}

async function enforceSessionPolicy(session) {
  ensureSessionMeta(session);
  startSessionWatcher();
  const reason = sessionTimeoutReason();
  if (!reason) return true;
  await endTimedOutSession(reason);
  return false;
}

function ensureSessionMeta(session) {
  const now = Date.now();
  const userId = session?.user?.id || "";
  const meta = readSessionMeta();
  if (meta.user_id !== userId || !meta.login_at) {
    writeSessionMeta({ user_id: userId, login_at: now, last_active_at: now });
    return;
  }
  if (!meta.last_active_at) writeSessionMeta({ ...meta, last_active_at: now });
}

function startSessionWatcher() {
  if (sessionWatcherStarted) return;
  sessionWatcherStarted = true;
  ["click", "keydown", "mousemove", "scroll", "touchstart"].forEach((eventName) => {
    window.addEventListener(eventName, recordActivity, { passive: true });
  });
  setInterval(checkSessionTimeout, 60 * 1000);
}

function recordActivity() {
  const now = Date.now();
  if (now - lastActivityWrite < 15 * 1000) return;
  lastActivityWrite = now;
  const meta = readSessionMeta();
  if (!meta.login_at) return;
  if (sessionTimeoutReason()) {
    checkSessionTimeout();
    return;
  }
  writeSessionMeta({ ...meta, last_active_at: now });
}

async function checkSessionTimeout() {
  if (sessionTimeoutInProgress) return;
  const { data } = await supabase.auth.getSession();
  if (!data.session) return;
  ensureSessionMeta(data.session);
  const reason = sessionTimeoutReason();
  if (reason) await endTimedOutSession(reason);
}

function sessionTimeoutReason() {
  const meta = readSessionMeta();
  if (!meta.login_at) return "";
  const now = Date.now();
  if (now - Number(meta.login_at) > SESSION_MAX_AGE_MS) {
    return "Your Microsoft SSO session reached the 8-hour limit. Sign in again to continue.";
  }
  if (now - Number(meta.last_active_at || meta.login_at) > SESSION_IDLE_TIMEOUT_MS) {
    return "Your Microsoft SSO session timed out after 60 minutes of inactivity. Sign in again to continue.";
  }
  return "";
}

async function endTimedOutSession(reason) {
  sessionTimeoutInProgress = true;
  try {
    try {
      localStorage.setItem(AUTH_TIMEOUT_REASON_KEY, reason);
    } catch {
      // Ignore storage failures.
    }
    clearSessionTracking({ preserveTimeoutReason: true });
    await supabase.auth.signOut();
  } finally {
    const loginPath = inPagesDirectory() ? "../index.html" : "./index.html";
    location.href = loginPath;
  }
}

function clearSessionTracking({ preserveTimeoutReason = false } = {}) {
  try {
    localStorage.removeItem(SESSION_META_KEY);
    if (!preserveTimeoutReason) localStorage.removeItem(AUTH_TIMEOUT_REASON_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function readSessionMeta() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_META_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeSessionMeta(meta) {
  try {
    localStorage.setItem(SESSION_META_KEY, JSON.stringify(meta));
  } catch {
    // Ignore storage failures.
  }
}
