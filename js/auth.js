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
  if (nav && !nav.querySelector('a[href="./monthly-report.html"]')) {
    const reportLink = document.createElement("a");
    reportLink.href = "./monthly-report.html";
    reportLink.textContent = "Monthly Report";
    reportLink.classList.toggle("active", location.pathname.endsWith("/monthly-report.html"));
    const dashboardLink = nav.querySelector('a[href="./admin-dashboard.html"], a[href="./user-dashboard.html"]');
    dashboardLink?.insertAdjacentElement("afterend", reportLink);
  }
  if (nav && !document.querySelector("[data-theme-toggle]")) {
    const themeButton = document.createElement("button");
    themeButton.type = "button";
    themeButton.className = "secondary theme-toggle";
    themeButton.dataset.themeToggle = "";
    nav.appendChild(themeButton);
    initTheme();
  }
  prepareShellNavigation(nav);
  enhanceScrollableRegions();
  requestAnimationFrame(enhanceScrollableRegions);
  setTimeout(enhanceScrollableRegions, 1000);
  document.querySelectorAll("[data-admin-only]").forEach((el) => {
    el.classList.toggle("hidden", profile.role !== "admin");
  });
  const email = document.querySelector("[data-user-email]");
  if (email) email.textContent = profile.email;
  bindLogout();
}

function prepareShellNavigation(nav) {
  if (!nav) return;
  nav.setAttribute("aria-label", "Primary navigation");
  const sidebar = nav.closest(".sidebar");
  if (!sidebar) return;
  sidebar.id ||= "app-sidebar";

  const brand = sidebar.querySelector(".brand");
  if (brand && !brand.querySelector(".brand-mark")) {
    brand.textContent = "";
    const mark = document.createElement("span");
    mark.className = "brand-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "DP";
    const copy = document.createElement("span");
    copy.className = "brand-copy";
    const name = document.createElement("strong");
    name.textContent = "Data Platform";
    const descriptor = document.createElement("small");
    descriptor.textContent = "Workforce analytics";
    copy.append(name, descriptor);
    brand.append(mark, copy);
  }

  const currentPage = location.pathname.split("/").pop();
  const links = [...nav.querySelectorAll(":scope > a")];
  links.forEach((link) => {
    const linkPage = new URL(link.href, location.href).pathname.split("/").pop();
    link.classList.toggle("active", linkPage === currentPage);
    if (linkPage === currentPage) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  if (!nav.querySelector(".nav-section-label")) {
    const groups = [
      { label: "Analyze", pages: ["admin-dashboard.html", "user-dashboard.html", "monthly-report.html", "anomalies.html", "search.html"] },
      { label: "Manage", pages: ["users.html", "datasets.html", "my-datasets.html", "api-keys.html", "api-docs.html"] },
      { label: "System", pages: ["logs.html", "qbtime.html", "settings.html", "account.html"] },
    ];
    groups.forEach(({ label, pages }) => {
      const firstLink = links.find((link) => pages.some((page) => link.pathname.endsWith(`/${page}`)));
      if (!firstLink) return;
      const heading = document.createElement("div");
      heading.className = "nav-section-label";
      heading.textContent = label;
      firstLink.insertAdjacentElement("beforebegin", heading);
    });
  }

  if (!nav.querySelector(".nav-utility")) {
    const utility = document.createElement("div");
    utility.className = "nav-utility";
    const logoutButton = nav.querySelector("[data-logout]");
    const themeButton = nav.querySelector("[data-theme-toggle]");
    if (logoutButton) utility.appendChild(logoutButton);
    if (themeButton) utility.appendChild(themeButton);
    if (utility.children.length) nav.appendChild(utility);
  }

  setupMobileNavigation(sidebar, nav);
}

function setupMobileNavigation(sidebar, nav) {
  if (document.querySelector(".nav-toggle")) return;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "nav-toggle";
  toggle.setAttribute("aria-controls", sidebar.id);
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open navigation");
  toggle.title = "Open navigation";
  toggle.innerHTML = '<span class="nav-toggle-bars" aria-hidden="true"></span>';

  const backdrop = document.createElement("button");
  backdrop.type = "button";
  backdrop.className = "nav-backdrop";
  backdrop.setAttribute("aria-label", "Close navigation");

  const setOpen = (open) => {
    document.body.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    toggle.title = open ? "Close navigation" : "Open navigation";
  };

  toggle.addEventListener("click", () => setOpen(!document.body.classList.contains("nav-open")));
  backdrop.addEventListener("click", () => setOpen(false));
  nav.querySelectorAll("a, [data-logout]").forEach((control) => control.addEventListener("click", () => setOpen(false)));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("nav-open")) {
      setOpen(false);
      toggle.focus();
    }
  });
  window.matchMedia("(min-width: 861px)").addEventListener("change", (event) => {
    if (event.matches) setOpen(false);
  });
  document.body.append(toggle, backdrop);
}

function enhanceScrollableRegions() {
  document.querySelectorAll(".table-wrap, .chart-scroll").forEach((region) => {
    if (!region.hasAttribute("tabindex")) region.tabIndex = 0;
    if (!region.hasAttribute("role")) region.setAttribute("role", "region");
    if (!region.hasAttribute("aria-label")) {
      const title = region.closest(".panel")?.querySelector("h2, h3")?.textContent?.trim();
      region.setAttribute("aria-label", `${title || "Data"} scrollable content`);
    }
  });
  document.querySelectorAll(".notice").forEach((notice) => {
    notice.setAttribute("role", notice.classList.contains("error") ? "alert" : "status");
    notice.setAttribute("aria-live", notice.classList.contains("error") ? "assertive" : "polite");
  });
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
