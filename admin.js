/* ==================================================================
   QQSGP organiser dashboard
   ------------------------------------------------------------------
   Talks to the Apps Script backend on POST <URL>?action=admin.
   Signing in posts an organiser ID and a PIN; the server verifies the
   PIN against a salted PBKDF2 verifier and answers with a session
   token. Every later request carries that token, and the server checks
   it and the caller's role before reading anything.

   Nothing here is trusted by the server: record ids are hashes,
   statuses and note text are validated again on the other side, and
   the account actions are refused with FORBIDDEN for an Organizer no
   matter what this page chooses to render.
   ================================================================== */

/* Must stay identical to APPS_SCRIPT_URL in script.js — both files point at
   the same Web App deployment. */
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw_-E7L9mE7xGk_Fypf6tnTvAbG4wZu9idrycpawkakihtgKndDMknDLdZnt333T3y-/exec";

const REQUEST_TIMEOUT_MS = 20000;
const AUTO_REFRESH_MS = 30000;
const PAGE_SIZE = 25;
const STATUSES = ["PENDING", "APPROVED", "REJECTED", "WAITLISTED"];

/* The server hands back a session token at sign-in. It is the only credential
   this page holds: this tab keeps it in sessionStorage, and "keep me signed in"
   additionally lets it survive a reload in localStorage. No PIN is ever stored,
   and no key ships in this file. */
const KEY_SESSION = "qqsgp_org_session";
const KEY_PERSIST = "qqsgp_org_session_remembered";
const KEY_LEGACY = "qqsgp_admin_key";
const KEY_LEGACY_PERSIST = "qqsgp_admin_key_remembered";
const KEY_ACTOR = "qqsgp_org_actor";

/* Mirrors ORG_PERMISSIONS.SUPER on the server. Only used to decide which panel
   to show; the server enforces the real thing. */
/* Must match ORG_PERMISSIONS.SUPER in apps-script.js. Payment and settings
   permissions were missing here, so the break-glass key could see a payment
   row but the browser refused to let it mark cash received — even though the
   server would have allowed the same Super Admin. */
const SUPER_PERMISSIONS = [
  "records.view", "records.update", "records.export",
  "pay.view", "pay.update",
  "wa.view", "wa.send",
  "accounts.manage", "sessions.manage", "audit.view"
];

/* ------------------------------ elements ------------------------------ */

const el = (id) => document.getElementById(id);

const gate = el("gate");
const gateForm = el("gateForm");
const gateId = el("gateId");
const gatePin = el("gatePin");
const gateKey = el("gateKey");
const gateRemember = el("gateRemember");
const gateSubmit = el("gateSubmit");
const gateKeySubmit = el("gateKeySubmit");
const gateError = el("gateError");

const shell = el("shell");
const refreshState = el("refreshState");
const refreshBtn = el("refreshBtn");
const exportBtn = el("exportBtn");
const signOutBtn = el("signOutBtn");

const stats = {
  teams: el("statTeams"),
  teamsNote: el("statTeamsNote"),
  players: el("statPlayers"),
  PENDING: el("statPending"),
  APPROVED: el("statApproved"),
  WAITLISTED: el("statWaitlisted"),
  REJECTED: el("statRejected"),
  onlineAwaiting: el("statOnlineAwaiting"),
  cashPending: el("statCashPending"),
  paid: el("statPaid"),
  paidNote: el("statPaidNote")
};

const regSummary = el("regSummary");
const searchInput = el("searchInput");
const departmentFilter = el("departmentFilter");
const paymentFilter = el("paymentFilter");
const methodFilter = el("methodFilter");
const statusChips = Array.from(document.querySelectorAll(".chip[data-status]"));
const regRows = el("regRows");
const stateBox = el("stateBox");
const stateTitle = el("stateTitle");
const stateCopy = el("stateCopy");
const pageInfo = el("pageInfo");
const prevBtn = el("prevBtn");
const nextBtn = el("nextBtn");

const drawer = el("drawer");
const drawerBackdrop = el("drawerBackdrop");
const drawerMeta = el("drawerMeta");
const drawerTitle = el("drawerTitle");
const drawerDepartment = el("drawerDepartment");
const drawerStatus = el("drawerStatus");
const drawerId = el("drawerId");
const drawerRoster = el("drawerRoster");
const drawerClose = el("drawerClose");
const noteInput = el("noteInput");
const noteCount = el("noteCount");
const noteSave = el("noteSave");
const copyMessageBtn = el("copyMessageBtn");
const openWaLink = el("openWaLink");
const drawerContactHint = el("drawerContactHint");
const statusButtons = Array.from(drawer.querySelectorAll("[data-set-status]"));

// Payment controls in the drawer.
const drawerFee = el("drawerFee");
const drawerMethod = el("drawerMethod");
const drawerPayStatus = el("drawerPayStatus");
const drawerUtr = el("drawerUtr");
const drawerUtrLine = el("drawerUtrLine");
const drawerPayUpdated = el("drawerPayUpdated");
const drawerPayUpdatedLine = el("drawerPayUpdatedLine");
const payNoteInput = el("payNoteInput");
const payStatusButtons = Array.from(drawer.querySelectorAll("[data-pay-status]"));
const drawerVerified = el("drawerVerified");
const drawerVerifiedLine = el("drawerVerifiedLine");
const drawerPaymentId = el("drawerPaymentId");
const drawerPaymentIdLine = el("drawerPaymentIdLine");

// The live entry fee, written to the sheet and read back from it.
const feeInput = el("feeInput");
const feeSave = el("feeSave");
const settingsState = el("settingsState");
const reviewRows = el("reviewRows");
const reviewState = el("reviewState");
const reviewEmpty = el("reviewEmpty");
const reviewRefresh = el("reviewRefresh");

const confirmBackdrop = el("confirmBackdrop");
const confirmTitle = el("confirmTitle");
const confirmCopy = el("confirmCopy");
const confirmCancel = el("confirmCancel");
const confirmOk = el("confirmOk");

/* Who receives the approval message, shown only when the leader has no usable
   number and another player does. */
const waPickBackdrop = el("waPickBackdrop");
const waPickTitle = el("waPickTitle");
const waPickCopy = el("waPickCopy");
const waPickList = el("waPickList");
const waPickOk = el("waPickOk");
const waPickCancel = el("waPickCancel");

const toasts = el("toasts");

const whoName = el("whoName");
const whoRole = el("whoRole");
const sessionBtn = el("sessionBtn");
const orgPanel = el("organisers");
const orgSummary = el("orgSummary");
const orgRows = el("orgRows");
const orgSessions = el("orgSessions");
const orgAudit = el("orgAudit");
const orgRefresh = el("orgRefresh");
const orgCreateForm = el("orgCreateForm");
const orgNewId = el("orgNewId");
const orgNewName = el("orgNewName");
const orgNewRole = el("orgNewRole");
const orgNewPin = el("orgNewPin");
const orgCreateBtn = el("orgCreateBtn");
const orgSelfForm = el("orgSelfForm");
const orgCurrentPin = el("orgCurrentPin");
const orgNewSelfPin = el("orgNewSelfPin");
const orgSelfBtn = el("orgSelfBtn");

/* -------------------------------- state ------------------------------- */

const state = {
  /* "session" once signed in with an id and PIN; "key" only for the recovery
     credential. The server decides everything else. */
  mode: "",
  /* One approval at a time: a double tap must not save twice or open two tabs. */
  approving: false,
  /* The last WhatsApp link this page prepared, so a blocked tab can be
     recovered from the drawer instead of approving again. */
  pendingWa: null,
  session: "",
  key: "",
  actor: null,
  permissions: [],
  accounts: [],
  records: [],
  counts: {
    total: 0, players: 0, PENDING: 0, APPROVED: 0, REJECTED: 0, WAITLISTED: 0,
    onlineAwaiting: 0, cashPending: 0, paid: 0, needsReview: 0, notSelected: 0,
    paidTeams: 0, amountCollected: 0, amountOutstanding: 0, selfReported: 0, fee: 100
  },
  departments: [],
  page: 1,
  pageSize: PAGE_SIZE,
  total: 0,
  status: "ALL",
  department: "",
  payment: "",
  method: "",
  query: "",
  openId: null,
  lastFocus: null,
  busy: false,
  autoTimer: null,
  searchTimer: null
};

/* ------------------------------- helpers ------------------------------ */

function readStorage(name) {
  try {
    return sessionStorage.getItem(name) || localStorage.getItem(name + "_remembered") || "";
  } catch (ignored) {
    return "";
  }
}

function writeStorage(name, value, remember) {
  try {
    sessionStorage.setItem(name, value);
  } catch (ignored) {}
  try {
    if (remember) localStorage.setItem(name + "_remembered", value);
    else localStorage.removeItem(name + "_remembered");
  } catch (ignored) {}
}

function clearStorage(name) {
  try {
    sessionStorage.removeItem(name);
    localStorage.removeItem(name + "_remembered");
  } catch (ignored) {}
}

function loadStoredActor() {
  try {
    const raw = localStorage.getItem(KEY_ACTOR) || sessionStorage.getItem(KEY_ACTOR);
    return raw ? JSON.parse(raw) : null;
  } catch (ignored) {
    return null;
  }
}

function storeActor(actor, remember) {
  const raw = JSON.stringify(actor);
  try {
    if (remember) localStorage.setItem(KEY_ACTOR, raw);
    else sessionStorage.setItem(KEY_ACTOR, raw);
  } catch (ignored) {}
}

function forgetEverything() {
  clearStorage(KEY_SESSION);
  clearStorage(KEY_LEGACY);
  try {
    sessionStorage.removeItem(KEY_ACTOR);
    localStorage.removeItem(KEY_ACTOR);
  } catch (ignored) {}
  state.mode = "";
  state.session = "";
  state.key = "";
  state.actor = null;
  state.permissions = [];
}

function can(permission) {
  return state.permissions.indexOf(permission) !== -1;
}

/** A short description of the browser, so a session row is recognisable. */
function deviceLabel() {
  const ua = navigator.userAgent || "";
  const platform = /Android/i.test(ua) ? "Android"
    : /iPhone|iPad|iPod/i.test(ua) ? "iOS"
    : /Windows/i.test(ua) ? "Windows"
    : /Mac OS X/i.test(ua) ? "Mac"
    : /Linux/i.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari" : "browser";
  return browser + " on " + platform;
}

function toast(message, kind) {
  const node = document.createElement("div");
  node.className = "toast" + (kind ? " is-" + kind : "");
  node.textContent = message;
  toasts.appendChild(node);
  setTimeout(() => node.remove(), kind === "error" ? 7000 : 4500);
}

function setRefreshState(mode, label) {
  refreshState.className = "live-pill" + (mode === "live" ? "" : " is-" + mode);
  refreshState.innerHTML = "<i></i>" + (label || "Live");
}

/* POSTs one admin action. Network and HTTP problems come back as
   { ok:false, code } so callers only ever branch on the result object. */
async function api(action, extra) {
  if (APPS_SCRIPT_URL.includes("PASTE_YOUR")) {
    return { ok: false, code: "CONFIG", error: "The dashboard is not connected to the Apps Script URL yet." };
  }

  /* The server accepts a session token or, for the recovery path only, the
     dashboard key. Whatever is sent, the server re-checks it and re-checks the
     role before touching a row. */
  const credential = state.mode === "key" ? { key: state.key } : { session: state.session };
  const body = Object.assign({ action: action }, credential, extra || {});
  const url = APPS_SCRIPT_URL + (APPS_SCRIPT_URL.includes("?") ? "&" : "?") + "action=admin";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    /* text/plain keeps this a CORS-simple request, which is what Apps Script
       answers. Combined with a credential that travels in the body rather than
       in a cookie, a page on another origin cannot ride along on a signed-in
       session: it can neither read the token nor replay it. */
    const response = await fetch(url, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "follow"
    });

    if (!response.ok) {
      return { ok: false, code: "HTTP", error: "The server answered " + response.status + ". Try again." };
    }

    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (ignored) {
      return { ok: false, code: "PARSE", error: "The server sent a response the dashboard could not read. Check that the Web App is deployed with access set to anyone." };
    }

    if (!parsed || typeof parsed !== "object") {
      return { ok: false, code: "PARSE", error: "The server sent an empty response." };
    }

    return parsed.ok
      ? parsed
      : { ok: false, code: parsed.code || "ERROR", error: parsed.error || "The request was refused." };

  } catch (error) {
    const aborted = error && error.name === "AbortError";
    return {
      ok: false,
      code: aborted ? "TIMEOUT" : "NETWORK",
      error: aborted ? "The server took too long to answer. Try again." : "Could not reach the server. Check your connection and try again."
    };
  } finally {
    clearTimeout(timer);
  }
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ------------------- WhatsApp number + click-to-chat ------------------- */

/**
 * An Indian mobile number in the only shape WhatsApp accepts: country code 91
 * followed by a 10-digit number that starts 6-9.
 *
 * Returns "" for anything else. A missing digit or a stray prefix is never
 * guessed at: the approval flow would otherwise open a conversation with a
 * stranger, which is worse than telling the organiser the number is wrong.
 */
function waNumber(value) {
  const digits = String(value === undefined || value === null ? "" : value).replace(/\D/g, "");
  if (/^[6-9]\d{9}$/.test(digits)) return "91" + digits;
  if (/^0[6-9]\d{9}$/.test(digits)) return "91" + digits.slice(1);
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  // Anything else is refused rather than "repaired": a guessed digit sends a
  // stranger a message about a tournament they never entered. These are Indian
  // numbers only, which is what the registration form collects.
  return "";
}

function waUrl(number, message) {
  const to = waNumber(number);
  if (!to) return "";
  return "https://wa.me/" + to + (message ? "?text=" + encodeURIComponent(message) : "");
}

/* Kept for the roster links, which only need the number. */
function whatsappLink(number, message) {
  return waUrl(number, message);
}

/**
 * The roster as possible recipients, in sheet order. Index 0 is the team
 * leader: that is the first player column, the one the registration form
 * treats as the contact. Nothing here invents a number.
 */
function waRecipients(record) {
  return (record.players || []).map((player, index) => ({
    name: player.name || "Player " + (index + 1),
    label: index === 0 ? "Team leader" : "Player " + (index + 1),
    raw: player.whatsapp || "",
    number: waNumber(player.whatsapp)
  }));
}

/**
 * One honest line about money. A team that has not paid is never told that it
 * has, and a team that has paid is not nagged. Run after the approval has been
 * saved, using the server's copy of the record.
 */
function paymentStatusLine(payment) {
  const pay = payment || {};
  const status = String(pay.status || "NOT SELECTED").toUpperCase();
  // The fee comes from the row, never from a number typed into this file: a
  // team that registered before a price change must be told its own fee.
  const fee = pay.entryFee ? formatMoney(pay.entryFee) : "the entry fee";
  if (status === "PAID") return "💰 Payment status: Paid — thank you!";
  if (status === "PENDING VERIFICATION") {
    return "💰 Payment status: Pending verification — your " + fee + " payment is being checked.";
  }
  if (status === "NEEDS REVIEW") {
    return "💰 Payment status: Needs review — an organiser will contact you about the " + fee + " entry fee.";
  }
  if (status === "REJECTED") {
    return "💰 Payment status: Rejected — please contact the organisers about the " + fee + " entry fee.";
  }
  if (status === "PENDING") {
    return "💰 Payment status: Pending — the " + fee + " team entry fee is still due.";
  }
  return "💰 Payment status: Not selected — please choose Online (UPI QR) or Cash for the " + fee + " team entry fee.";
}

/**
 * The approval message. Every value comes from the saved registration, so what
 * the team receives can never disagree with the sheet.
 */
function approvalMessage(record, recipientName) {
  const team = record.teamName || "your team";
  const leader = recipientName || ((record.players || [])[0] || {}).name || "team";

  return [
    "Hello " + leader + "!",
    "",
    "Congratulations! 🎉 Your team *" + team + "* has been APPROVED for the QQSGP Free Fire Tournament!",
    "",
    "🏆 Team: " + team,
    "🏫 Department: " + (record.department || "Not recorded"),
    "🆔 Registration ID: " + record.id,
    "",
    paymentStatusLine(record.payment),
    "",
    "Please stay tuned for the official match schedule and further tournament updates.",
    "",
    "Best of luck, team! 🔥",
    "",
    "— QQSGP Free Fire Tournament Organizing Team"
  ].join("\n");
}

/**
 * Where a rejected team is told to ask questions. This is the same WhatsApp
 * number the public pages publish (index.html and rules.html, "Organizer
 * contact"), copied here because a message that says "contact the organisers"
 * without saying how is not an answer. Change all three together.
 */
const ORGANISER_CONTACT_WA = "917075593104";

/**
 * The rejection message. Polite, honest about what happened, and it points at a
 * contact that actually exists on the public site. It never claims a refund, a
 * reason or a next round that nobody decided, and it is prepared for the
 * organiser to send — nothing here sends anything.
 */
function rejectionMessage(record, recipientName) {
  const team = record.teamName || "your team";
  const leader = recipientName || ((record.players || [])[0] || {}).name || "team";

  return [
    "Hello " + leader + ",",
    "",
    "Thank you for registering *" + team + "* for the QQSGP Free Fire Tournament.",
    "After reviewing the entries, we are sorry to say that we cannot offer your team a slot this time.",
    "",
    "🏆 Team: " + team,
    "🏫 Department: " + (record.department || "Not recorded"),
    "🆔 Registration ID: " + record.id,
    "",
    paymentStatusLine(record.payment),
    "",
    "If you have a question about this decision, please message the organising team on WhatsApp:",
    "https://wa.me/" + ORGANISER_CONTACT_WA,
    "",
    "We hope to see your squad at a future event.",
    "",
    "— QQSGP Free Fire Tournament Organizing Team"
  ].join("\n");
}

/* ------------------------------ sign in ------------------------------- */

function showGateError(message) {
  gateError.hidden = false;
  gateError.textContent = message;
}

function setGateBusy(busy) {
  gateSubmit.disabled = busy;
  gateKeySubmit.disabled = busy;
  gateSubmit.textContent = busy ? "Checking..." : "Sign in";
}

function organisIdSafe(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
}

/* ORG_JS */
async function openDashboard(key, remember) {
  return signInWithKey(key, remember);
}

/** Shared tail of both sign-in paths: prove the credential, then open up. */
async function enterDashboard(remember) {
  const result = await api("list", { page: 1, pageSize: state.pageSize, status: "ALL" });
  setGateBusy(false);

  if (!result.ok) {
    forgetEverything();
    showGateError(result.code === "AUTH"
      ? "That credential was refused. Check your organiser ID and PIN."
      : result.error);
    gateId.focus();
    return false;
  }

  if (state.mode === "session") writeStorage(KEY_SESSION, state.session, remember);
  else writeStorage(KEY_LEGACY, state.key, remember);
  storeActor(state.actor, remember);

  gate.hidden = true;
  shell.hidden = false;
  applyIdentity();
  applyResult(result, { keepPage: false });
  startAutoRefresh();
  /* Signing in goes straight to applyResult, not through load(), so the hold
     queue has to be read here too: a payment that arrived while the page was
     closed must not look like "Nothing waiting" until the next refresh. */
  loadReview();
  loadTournament();
  refreshBtn.focus();
  // The log and the account panel are separate reads, so a slow provider can
  // never hold up the registrations table.
  waLoadLog(true);
  if (can("accounts.manage")) orgRefresh_();
  return true;
}

async function signIn(organiserId, pin, remember) {
  state.mode = "session";
  state.session = "";
  state.key = "";
  setGateBusy(true);
  gateError.hidden = true;

  const result = await api("login", {
    organiserId: organisIdSafe(organiserId),
    pin: pin,
    device: deviceLabel(),
    remember: remember === true
  });

  if (!result.ok) {
    setGateBusy(false);
    state.mode = "";
    gatePin.value = "";
    showGateError(result.error);
    if (result.code === "LOCKED") gateId.focus();
    else gatePin.focus();
    return false;
  }

  state.session = result.session;
  state.actor = result.actor;
  state.permissions = result.permissions || [];

  const opened = await enterDashboard(remember);
  if (opened) {
    gatePin.value = "";
    gateId.value = result.actor.id;
    toast("Signed in as " + result.actor.name + " (" + result.actor.role + ").");
  }
  return opened;
}

async function signInWithKey(key, remember) {
  state.mode = "key";
  state.key = key;
  state.session = "";
  state.actor = { id: "dashboard-key", name: "Dashboard key", role: "SUPER" };
  /* The key is a Super Admin credential. The panel is shown for it, and the
     server still refuses anything the key is not entitled to. */
  state.permissions = SUPER_PERMISSIONS.slice(0);
  setGateBusy(true);
  gateError.hidden = true;
  const opened = await enterDashboard(remember);
  if (opened) toast("Signed in with the recovery key.");
  return opened;
}

/** Resumes a session this browser kept, and re-checks it with the server. */
async function resumeSession(session, remember) {
  state.mode = "session";
  state.session = session;
  state.actor = loadStoredActor();
  state.permissions = [];
  setGateBusy(true);

  const who = await api("session-info", {});
  if (!who.ok) {
    setGateBusy(false);
    forgetEverything();
    if (who.code === "SESSION" || who.code === "AUTH") showGateError(who.error);
    return false;
  }

  state.actor = who.actor;
  state.permissions = who.permissions || [];
  return enterDashboard(remember);
}

function applyIdentity() {
  const actor = state.actor || { name: "\u2014", role: "\u2014" };
  whoName.textContent = actor.name || actor.id || "\u2014";
  whoRole.textContent = actor.role || "\u2014";
  whoRole.className = "role-chip" + (actor.role === "SUPER" ? " is-super" : "");
  orgPanel.hidden = !can("accounts.manage");
}

gateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const id = organisIdSafe(gateId.value);
  const pin = gatePin.value;

  if (!id) {
    showGateError("Enter your organiser ID.");
    gateId.focus();
    return;
  }
  if (pin.length < 6) {
    showGateError("Enter your personal PIN - at least 6 characters.");
    gatePin.focus();
    return;
  }

  signIn(id, pin, gateRemember.checked);
});

gateKeySubmit.addEventListener("click", () => {
  const key = gateKey.value.trim();
  if (key.length < 20) {
    showGateError("The key looks too short - keys from setupAdminKey() are 64 characters.");
    return;
  }
  openDashboard(key, gateRemember.checked);
});

sessionBtn.addEventListener("click", async () => {
  if (state.mode !== "session") {
    toast("Signed in with the recovery key. It stays valid until the admin_key property is deleted.");
    return;
  }

  const who = await api("session-info", {});
  if (!who.ok) {
    handleFailure(who, {});
    return;
  }

  toast("This device: " + deviceLabel() + ". Sessions end after 12 idle hours, or now if you sign out or a PIN is reset.");
});

signOutBtn.addEventListener("click", () => {
  /* Tell the server to end the session, then clear this browser whether or not
     that call got through: a local sign-out must not depend on the network. */
  const token = state.session;

  stopAutoRefresh();
  forgetEverything();
  state.records = [];
  orgPanel.hidden = true;
  closeDrawer();
  shell.hidden = true;
  gate.hidden = false;
  gatePin.value = "";
  gateKey.value = "";
  gateId.focus();
  toast("Signed out.");

  if (!token) return;

  fetch(APPS_SCRIPT_URL + (APPS_SCRIPT_URL.includes("?") ? "&" : "?") + "action=admin", {
    method: "POST",
    mode: "cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "logout", session: token }),
    keepalive: true
  }).catch(() => {});
});

/* ------------------------------- loading ------------------------------ */

function applyResult(result, options) {
  const opts = options || {};

  state.records = result.records || [];
  state.counts = result.counts || state.counts;
  state.departments = result.departments || state.departments;
  state.total = typeof result.total === "number" ? result.total : state.records.length;
  if (!opts.keepPage) state.page = result.page || state.page;
  state.pageSize = result.pageSize || state.pageSize;

  renderStats();
  renderDepartments();
  renderTable();

  setRefreshState("live", "Live · " + (result.generatedAt ? timeOf(result.generatedAt) : "now"));
  setHint("");
}

function timeOf(iso) {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "now";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setHint(message) {
  regSummary.textContent = message || (
    state.total === 0
      ? "No registrations match this view."
      : state.total + (state.total === 1 ? " registration" : " registrations") + " match this view."
  );
}

async function load(options) {
  const opts = options || {};
  if (state.busy) return;
  state.busy = true;

  if (!opts.silent) setRefreshState("busy", "Refreshing…");
  refreshBtn.disabled = true;

  const result = await api("list", {
    page: state.page,
    pageSize: state.pageSize,
    status: state.status,
    department: state.department,
    payment: state.payment,
    method: state.method,
    q: state.query
  });

  state.busy = false;
  refreshBtn.disabled = false;

  if (!result.ok) {
    handleFailure(result, opts);
    return;
  }

  applyResult(result, { keepPage: true });

  // The fee is sheet data, so it is read once per sign-in rather than on every
  // 20-second refresh. The review queue is refreshed with every list so a
  // payment that arrived while the page was open shows up.
  if (!settingsLoaded) {
    settingsLoaded = true;
    loadSettings();
  }
  loadReview();
  loadTournament();

  /* Keep the open drawer in step with fresh data; close it if the record
     was changed by someone else and no longer exists in the list. */
  if (state.openId) {
    const still = state.records.filter((record) => record.id === state.openId)[0];
    if (still) fillDrawer(still);
    else closeDrawer();
  }
}

function handleFailure(result, opts) {
  /* A dead whitelist session, a revoked credential or a non-whitelisted role
     all send the organiser back to the gate with the server's own wording. */
  if (result.code === "AUTH" || result.code === "SESSION") {
    stopAutoRefresh();
    forgetEverything();
    orgPanel.hidden = true;
    shell.hidden = true;
    gate.hidden = false;
    showGateError(result.error || "Your session has ended. Sign in again.");
    gateId.focus();
    return;
  }

  if (result.code === "FORBIDDEN") {
    toast(result.error, "error");
    return;
  }

  setRefreshState("error", result.code === "TIMEOUT" ? "Timed out" : "Offline");

  if (state.records.length === 0) {
    showState("Could not load registrations", result.error);
  }
  if (!opts.silent) toast(result.error, "error");
}

/* ------------------------------- render ------------------------------- */

/* ------------------------------- money -------------------------------- */

function formatMoney(value) {
  const amount = Number(value);
  return "₹" + (isFinite(amount) ? amount.toLocaleString("en-IN") : "0");
}

/* Sheet-facing status strings, and the shorter words a phone screen can hold. */
const PAY_LABELS = {
  "NOT SELECTED": "Not chosen",
  "PENDING": "Cash pending",
  "PENDING VERIFICATION": "To verify",
  "PAID": "Paid",
  "NEEDS REVIEW": "Needs review",
  "REJECTED": "Rejected"
};

function payLabel(status) {
  return PAY_LABELS[status] || status || "Not chosen";
}

function renderStats() {
  const counts = state.counts;
  stats.teams.textContent = counts.total;
  stats.teamsNote.textContent = counts.total === 1 ? "Team submitted" : "Teams submitted";
  stats.players.textContent = counts.players;
  stats.PENDING.textContent = counts.PENDING || 0;
  stats.APPROVED.textContent = counts.APPROVED || 0;
  stats.WAITLISTED.textContent = counts.WAITLISTED || 0;
  stats.REJECTED.textContent = counts.REJECTED || 0;

  // Payment totals come from the same records, never from a second store.
  stats.onlineAwaiting.textContent = counts.onlineAwaiting || 0;
  stats.cashPending.textContent = counts.cashPending || 0;
  stats.paid.textContent = counts.paidTeams || 0;
  stats.paidNote.textContent = formatMoney(counts.amountCollected || 0) + " collected" +
    (counts.selfReported ? " · " + counts.selfReported + " self-declared online" : "");
}

function renderDepartments() {
  const current = departmentFilter.value;
  departmentFilter.innerHTML = '<option value="">All departments</option>' +
    state.departments.map((name) =>
      '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + "</option>").join("");
  departmentFilter.value = state.departments.indexOf(current) !== -1 ? current : "";
}

function showState(title, copy) {
  stateTitle.textContent = title;
  stateCopy.textContent = copy;
  stateBox.hidden = false;
}

function renderTable() {
  regRows.innerHTML = "";

  if (state.records.length === 0) {
    regRows.innerHTML = "";
    showState(
      state.total === 0 && !state.query && state.status === "ALL" &&
        !state.department && !state.payment && !state.method
        ? "No registrations yet"
        : "No teams in this view",
      state.total === 0
        ? "Teams will appear here the moment the first squad submits the form."
        : "Try clearing the search box, the department filter or the status filter."
    );
  } else {
    stateBox.hidden = true;

    const fragment = document.createDocumentFragment();
    state.records.forEach((record) => {
      const tr = document.createElement("tr");
      tr.tabIndex = 0;
      tr.dataset.id = record.id;
      tr.innerHTML =
        '<td class="cell-team">' + escapeHtml(record.teamName) +
          "<small>" + escapeHtml(leaderLabel(record)) + "</small></td>" +
        '<td class="cell-dept">' + escapeHtml(record.department || "—") + "</td>" +
        '<td class="cell-players">' + record.playerCount + " of 4</td>" +
        '<td class="cell-date">' + escapeHtml(record.timestampLabel || "—") + "</td>" +
        '<td class="cell-pay">' + paymentCell(record) + "</td>" +
        '<td><span class="badge" data-status="' + escapeHtml(record.status) + '">' + escapeHtml(record.status) + "</span></td>" +
        '<td class="row-open">Details</td>';
      fragment.appendChild(tr);
    });
    regRows.appendChild(fragment);
  }

  const first = state.total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
  const last = Math.min(state.page * state.pageSize, state.total);
  pageInfo.textContent = "Showing " + first + "–" + last + " of " + state.total;
  prevBtn.disabled = state.page <= 1;
  nextBtn.disabled = last >= state.total;
}

/** A payment chip plus the amount, so the row answers "how much" as well. */
function paymentCell(record) {
  const pay = record.payment || {};
  const status = pay.status || "NOT SELECTED";
  const method = pay.method ? pay.method.charAt(0) + pay.method.slice(1).toLowerCase() : "";

  return '<span class="pay-chip" data-pay="' + escapeHtml(status) + '">' +
    escapeHtml(payLabel(status)) + "</span>" +
    '<small class="pay-meta">' + escapeHtml(formatMoney(pay.entryFee)) +
    (method ? " · " + escapeHtml(method) : "") + "</small>";
}

function leaderLabel(record) {
  const leader = record.players && record.players[0] ? record.players[0].name : "";
  return leader ? "Leader: " + leader : "Leader not recorded";
}

/* ------------------------------- drawer ------------------------------- */

function findRecord(id) {
  return state.records.filter((record) => record.id === id)[0] || null;
}

function openDrawer(record) {
  state.openId = record.id;
  state.lastFocus = document.activeElement;
  fillDrawer(record);
  drawer.hidden = false;
  drawerBackdrop.hidden = false;
  drawerClose.focus();
}

function fillDrawer(record) {
  drawerMeta.textContent = (record.timestampLabel || "Registration") + " · " + record.playerCount + " players";
  drawerTitle.textContent = record.teamName || "Team";
  drawerDepartment.textContent = record.department || "Department not recorded";

  drawerStatus.textContent = record.status;
  drawerStatus.dataset.status = record.status;
  drawerId.textContent = record.id;

  drawerRoster.innerHTML = (record.players || []).map((player, index) => {
    const label = index === 0 ? "Leader" : "Player " + (index + 1);
    const link = whatsappLink(player.whatsapp);
    const contact = link
      ? '<a href="' + link + '" target="_blank" rel="noopener">+' + escapeHtml(player.whatsapp) + " (WhatsApp)</a>"
      : '<span class="no-phone">No number on file</span>';
    return '<li><span class="who"><span class="idx">' + (index + 1) + "</span>" +
      escapeHtml(player.name) + '</span><span class="role">' + label + "</span>" +
      contact + "</li>";
  }).join("") || '<li class="no-phone">No players recorded on this row.</li>';

  noteInput.value = record.note || "";
  noteCount.textContent = String(noteInput.value.length);

  statusButtons.forEach((button) => {
    const isCurrent = button.dataset.setStatus === record.status;
    button.disabled = isCurrent;
    button.setAttribute("aria-pressed", isCurrent ? "true" : "false");
    button.title = isCurrent ? "This is the current status" : "";
  });

  /* ---- payment ---- */
  const pay = record.payment || {};
  const payStatus = pay.status || "NOT SELECTED";

  drawerFee.textContent = pay.entryFee ? formatMoney(pay.entryFee) : "—";
  drawerMethod.textContent = pay.method
    ? pay.method.charAt(0) + pay.method.slice(1).toLowerCase()
    : "Not chosen";
  drawerPayStatus.textContent = payStatus;
  drawerPayStatus.dataset.pay = payStatus;
  drawerUtr.textContent = pay.utr || "—";
  drawerUtrLine.hidden = !pay.utr;

  // Evidence from the provider, shown only when there is some. A cash row has
  // none, and must not look as if it had been verified by anybody.
  drawerVerifiedLine.hidden = !pay.paymentId;
  drawerVerified.textContent = pay.paymentId
    ? (pay.provider || "Provider") + " · " + formatMoney(pay.paidAmount || pay.entryFee) +
      " " + (pay.paidCurrency || "INR") + (pay.verifiedAt ? " · " + pay.verifiedAt : "")
    : "—";
  drawerPaymentIdLine.hidden = !pay.paymentId;
  drawerPaymentId.textContent = pay.paymentId || "—";
  drawerPayUpdated.textContent = pay.updatedAt
    ? pay.updatedAt + (pay.updatedBy ? " · " + pay.updatedBy : "")
    : "—";
  drawerPayUpdatedLine.hidden = !pay.updatedAt;
  payNoteInput.value = pay.note || "";

  payStatusButtons.forEach((button) => {
    const same = button.dataset.payStatus === payStatus;
    button.disabled = same;
    button.setAttribute("aria-pressed", same ? "true" : "false");
    button.title = same ? "This is the current payment status" : "";
  });

  /* ---- contact / WhatsApp ---- */
  const recipients = waRecipients(record);
  const leader = recipients[0] || {};
  const usable = recipients.filter((who) => who.number);

  if (record.status === "APPROVED" && leader.number) {
    drawerContactHint.textContent = "Approved. Approve again is not possible — use Open WhatsApp to send the message to " +
      leader.name + " (+" + leader.number + ") if it was not sent.";
  } else if (record.status === "REJECTED" && leader.number) {
    drawerContactHint.textContent = "Rejected. Use Open WhatsApp to send " + leader.name + " (+" + leader.number +
      ") the rejection message, which points at the organisers' WhatsApp for questions.";
  } else if (!usable.length) {
    drawerContactHint.textContent = "No usable WhatsApp number is stored for this team. Approve still works, but no message can be opened.";
  } else if (leader.number) {
    drawerContactHint.textContent = "Approve saves the status, then opens WhatsApp with the message ready for " +
      leader.name + " (+" + leader.number + "). Press Send in WhatsApp.";
  } else {
    drawerContactHint.textContent = "The team leader has no usable WhatsApp number. Approving will ask which player should receive the message.";
  }

  copyMessageBtn.disabled = !usable.length;

  const pending = state.pendingWa;
  if (pending && pending.id === record.id && pending.url) {
    openWaLink.href = pending.url;
    openWaLink.textContent = "Open WhatsApp for " + pending.name;
    openWaLink.hidden = false;
  } else {
    openWaLink.hidden = true;
    openWaLink.removeAttribute("href");
  }
}

function closeDrawer() {
  if (drawer.hidden) return;
  state.openId = null;
  drawer.hidden = true;
  drawerBackdrop.hidden = true;
  if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
}

drawerClose.addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);

noteInput.addEventListener("input", () => {
  noteCount.textContent = String(noteInput.value.length);
});

/* --------------------------- status changes --------------------------- */

function askConfirm(title, copy, confirmLabel, onConfirm) {
  confirmTitle.textContent = title;
  confirmCopy.textContent = copy;
  confirmOk.textContent = confirmLabel || "Confirm";
  confirmBackdrop.hidden = false;
  confirmOk.focus();

  const cleanup = () => {
    confirmBackdrop.hidden = true;
    confirmOk.removeEventListener("click", ok);
    confirmCancel.removeEventListener("click", cancel);
    document.removeEventListener("keydown", onKey);
  };
  const ok = () => { cleanup(); onConfirm(); };
  const cancel = () => { cleanup(); drawerClose.focus(); };
  const onKey = (event) => { if (event.key === "Escape") cancel(); };

  confirmOk.addEventListener("click", ok);
  confirmCancel.addEventListener("click", cancel);
  document.addEventListener("keydown", onKey);
}

function changeStatus(nextStatus) {
  const record = findRecord(state.openId);
  if (!record) return;
  if (STATUSES.indexOf(nextStatus) === -1) {
    toast("That is not a valid status.", "error");
    return;
  }
  if (record.status === nextStatus) return;

  /* Approving is its own flow: it saves first, then opens WhatsApp with the
     message already typed. Everything below is the old status switch. */
  if (nextStatus === "APPROVED") {
    approveTeam(record);
    return;
  }

  const apply = async () => {
    noteSave.disabled = true;
    statusButtons.forEach((button) => { button.disabled = true; });

    const result = await api("status", {
      id: record.id,
      status: nextStatus,
      expectedStatus: record.status
    });

    noteSave.disabled = false;

    if (!result.ok) {
      if (result.code === "STALE") {
        toast("Someone else changed this team. Reloading the list.", "error");
        await load({ silent: true });
        return;
      }
      fillDrawer(record);
      toast(result.error, "error");
      return;
    }

    /* Only trust the server's copy: whatever it wrote is what the row now says. */
    replaceRecord(result.record);
    if (result.counts) state.counts = result.counts;
    renderStats();
    /* A rejection gets a message of its own, prepared before the drawer is
       painted so its "Open WhatsApp" link is already there if a popup was
       blocked. Nothing is sent from here — the organiser presses Send. */
    if (result.record.status === "REJECTED") offerRejection(result.record);
    fillDrawer(result.record);
    renderRowsOnly();
    if (result.record.status !== "REJECTED") {
      toast(record.teamName + " is now " + result.record.status + ".", "ok");
    }
    // The status change may have produced a WhatsApp message (or a skipped
    // row when there was no consent); refresh the log to show the real result.
    waLoadLog(true);
  };

  if (nextStatus === "REJECTED") {
    askConfirm(
      "Reject " + record.teamName + "?",
      "The team is kept in the sheet with a REJECTED status. This does not delete the record, and you can change the status again later.",
      "Reject team",
      apply
    );
    return;
  }

  apply();
}

/**
 * Prepares the rejection message once the rejection is saved. It is never sent
 * from here: wa.me opens WhatsApp with the text ready and the organiser presses
 * Send. A missing or unusable number is said plainly — the rejection itself
 * still stands, and no message is claimed to have gone anywhere.
 */
function offerRejection(record) {
  const recipient = waRecipients(record).filter((who) => who.number)[0] || null;

  if (!recipient) {
    state.pendingWa = null;
    toast(record.teamName + " rejected. No usable WhatsApp number is stored, so no message could be prepared — reach the team another way.", "error");
    return;
  }

  const url = waUrl(recipient.raw, rejectionMessage(record, recipient.name));
  state.pendingWa = { id: record.id, url: url, name: recipient.name };

  let tab = null;
  try {
    tab = window.open(url, "_blank");
  } catch (ignored) {
    tab = null;
  }

  if (tab && tab !== window) {
    toast(record.teamName + " rejected. WhatsApp is open with the message — press Send.", "ok");
  } else {
    toast(record.teamName + " rejected. The browser blocked the new tab — tap “Open WhatsApp for " +
      recipient.name + "” in Contact.", "error");
  }
}

/* -------------------- approve → save → WhatsApp -------------------- */

/**
 * Approve is one action, not two: the status is saved first, and only a saved
 * approval opens WhatsApp. The message and the recipient both come from the
 * record the server returns, so the team is never told something the sheet does
 * not say.
 *
 * The tab is reserved while the click is still live, because browsers drop that
 * permission as soon as we await the network. If the save fails the tab is
 * closed again — nothing is ever opened on a failed write.
 */
async function approveAndOpenWhatsApp(record, recipient) {
  if (state.approving) return;
  if (record.status === "APPROVED") {
    toast(record.teamName + " is already approved. Nothing was saved again.", "ok");
    return;
  }

  state.approving = true;
  const wantsMessage = !!recipient;
  let tab = null;

  if (wantsMessage) {
    try {
      tab = window.open("", "_blank");
    } catch (ignored) {
      tab = null;
    }

    /* A browser that blocks popups may hand back this very window, or a handle
       whose document is this page. Painting "Opening WhatsApp" onto the
       dashboard would wipe the organiser's screen, so any doubt at all drops
       the handle and leaves the Open WhatsApp button to do the job. */
    if (!tab || tab === window) {
      tab = null;
    } else {
      let doc = null;
      try {
        doc = tab.document;
      } catch (ignored) {
        doc = null;
      }
      if (doc === document) {
        tab = null;
      } else if (doc) {
        /* Cosmetic only: the navigation below is what matters. */
        try {
          doc.title = "Opening WhatsApp…";
          doc.body.textContent = "Saving the approval, then opening WhatsApp…";
        } catch (ignored) { /* an unwritable blank tab is still navigable */ }
      }
    }
  }

  statusButtons.forEach((button) => { button.disabled = true; });
  noteSave.disabled = true;

  const result = await api("status", {
    id: record.id,
    status: "APPROVED",
    expectedStatus: record.status
  });

  noteSave.disabled = false;
  state.approving = false;

  if (!result.ok) {
    if (tab) { try { tab.close(); } catch (ignored) {} }
    if (result.code === "STALE") {
      toast("This team was changed somewhere else. Reload and approve it again.", "error");
      await load({ silent: true });
      return;
    }
    if (result.code === "NETWORK" || result.code === "TIMEOUT" || result.code === "HTTP") {
      /* The write may or may not have landed. Say so, and reload to find out. */
      toast(result.error + " The approval was NOT confirmed — check the team again before messaging.", "error");
      await load({ silent: true });
      fillDrawer(result.record || record);
      return;
    }
    fillDrawer(record);
    toast(result.error + " The team is still " + record.status + ".", "error");
    return;
  }

  /* Only the server's copy counts from here on. */
  const saved = result.record;
  replaceRecord(saved);
  if (result.counts) state.counts = result.counts;
  renderStats();
  renderRowsOnly();

  const url = wantsMessage ? waUrl(recipient.raw, approvalMessage(saved, recipient.name)) : "";
  state.pendingWa = url ? { id: saved.id, url: url, name: recipient.name } : null;
  fillDrawer(saved);

  if (!wantsMessage) {
    toast(saved.teamName + " approved. No usable WhatsApp number, so no message was opened.", "error");
    waLoadLog(true);
    return;
  }

  if (tab && !tab.closed) {
    try {
      tab.location.replace(url);
    } catch (ignored) {
      tab = null;
    }
  }

  if (tab && !tab.closed) {
    toast(saved.teamName + " approved. WhatsApp is open with the message — press Send.", "ok");
  } else {
    toast("Approved and saved. The browser blocked the new tab — tap “Open WhatsApp for " + recipient.name + "” in Contact.", "error");
  }

  waLoadLog(true);
}

/** Choose a recipient when the leader's number is missing or wrong. */
function pickRecipient(record, options) {
  const leader = waRecipients(record)[0] || {};

  waPickTitle.textContent = "Who gets the approval message?";
  waPickCopy.textContent = (leader.name ? leader.name : "The team leader") +
    " has no usable WhatsApp number on this registration. Choose another player, or the approval can be saved without a message.";
  waPickList.innerHTML = options.map((who, index) =>
    '<label class="wa-pick">' +
      '<input type="radio" name="waPick" value="' + index + '"' + (index === 0 ? " checked" : "") + ">" +
      '<span><b>' + escapeHtml(who.name) + "</b>" +
      "<em>" + escapeHtml(who.label) + " · +" + escapeHtml(who.number) + "</em></span>" +
    "</label>"
  ).join("");
  waPickBackdrop.hidden = false;
  waPickOk.disabled = false;
  waPickOk.focus();

  const chosen = () => {
    const picked = waPickList.querySelector('input[name="waPick"]:checked');
    return options[Number(picked ? picked.value : 0)] || options[0];
  };

  const cleanup = () => {
    waPickBackdrop.hidden = true;
    waPickOk.removeEventListener("click", ok);
    waPickCancel.removeEventListener("click", cancel);
    document.removeEventListener("keydown", onKey);
  };
  const ok = () => { cleanup(); approveAndOpenWhatsApp(record, chosen()); };
  const cancel = () => { cleanup(); drawerClose.focus(); };
  const onKey = (event) => { if (event.key === "Escape") cancel(); };

  waPickOk.addEventListener("click", ok);
  waPickCancel.addEventListener("click", cancel);
  document.addEventListener("keydown", onKey);
}

/**
 * Approve always runs this. A usable leader number goes straight to WhatsApp;
 * an unusable one is a question, never a guess.
 */
function approveTeam(record) {
  if (state.approving) return;

  const recipients = waRecipients(record);
  const leader = recipients[0] || null;
  const usable = recipients.filter((who) => who.number);

  if (leader && leader.number) {
    approveAndOpenWhatsApp(record, leader);
    return;
  }

  if (usable.length) {
    pickRecipient(record, usable);
    return;
  }

  askConfirm(
    "Approve " + record.teamName + "?",
    "This registration has no usable WhatsApp number, so WhatsApp cannot be opened. The approval itself will still be saved.",
    "Approve without message",
    () => approveAndOpenWhatsApp(record, null)
  );
}

statusButtons.forEach((button) => {
  button.addEventListener("click", () => changeStatus(button.dataset.setStatus));
});

/* --------------------------- payment changes --------------------------- */

/**
 * Payment status is the organiser's call and is never inferred from a team's
 * typed reference. The server refuses a stale write, so two phones can look
 * at the same team without one silently overwriting the other.
 */
async function changePayment(nextStatus) {
  const record = findRecord(state.openId);
  if (!record) return;

  const pay = record.payment || {};
  const current = pay.status || "NOT SELECTED";
  if (current === nextStatus) return;

  if (!can("pay.update")) {
    toast("Your role cannot change payments.", "error");
    return;
  }

  const apply = async () => {
    payStatusButtons.forEach((button) => { button.disabled = true; });

    const result = await api("payment-status", {
      id: record.id,
      paymentStatus: nextStatus,
      expectedPayment: current,
      method: pay.method || "",
      note: payNoteInput.value.trim()
    });

    if (!result.ok) {
      if (result.code === "STALE") {
        toast("Someone else changed this payment. Reloading.", "error");
        await load({ silent: true });
        fillDrawer(findRecord(state.openId) || record);
        return;
      }
      fillDrawer(record);
      toast(result.error, "error");
      return;
    }

    replaceRecord(result.record);
    if (result.counts) state.counts = result.counts;
    renderStats();
    fillDrawer(result.record);
    renderRowsOnly();
    toast(record.teamName + " payment is now " + payLabel(result.record.payment.status) + ".", "ok");
  };

  if (nextStatus === "PAID") {
    const how = pay.method === "CASH" ? "in cash" : "in your UPI app";
    askConfirm(
      "Mark " + record.teamName + " as paid?",
      "Only do this after you have seen the money — " + formatMoney(pay.entryFee) +
        " " + how + ". The change is recorded against your organiser account.",
      "Mark paid",
      apply
    );
    return;
  }

  apply();
}

payStatusButtons.forEach((button) => {
  button.addEventListener("click", () => changePayment(button.dataset.payStatus));
});

/* Re-draws the table body while the drawer stays open. */
function renderRowsOnly() {
  const openId = state.openId;
  renderTable();
  if (openId) {
    const row = regRows.querySelector('tr[data-id="' + openId + '"]');
    if (row) row.classList.add("is-open");
  }
}

function replaceRecord(updated) {
  state.records = state.records.map((record) => (record.id === updated.id ? updated : record));
}

noteSave.addEventListener("click", async () => {
  const record = findRecord(state.openId);
  if (!record) return;

  noteSave.disabled = true;
  const result = await api("note", {
    id: record.id,
    note: noteInput.value,
    expectedStatus: record.status
  });
  noteSave.disabled = false;

  if (!result.ok) {
    if (result.code === "STALE") {
      toast("Someone else changed this team. Reloading the list.", "error");
      await load({ silent: true });
      return;
    }
    toast(result.error, "error");
    return;
  }

  replaceRecord(result.record);
  if (result.counts) state.counts = result.counts;
  renderStats();
  fillDrawer(result.record);
  toast("Note saved.", "ok");
});

/* ------------------------------ WhatsApp ------------------------------ */

copyMessageBtn.addEventListener("click", async () => {
  const record = findRecord(state.openId);
  if (!record) return;

  const usable = waRecipients(record).filter((who) => who.number);
  const leader = usable[0];
  if (!leader) {
    toast("This team has no usable WhatsApp number to message.", "error");
    return;
  }

  /* An approved or rejected team gets exactly the message that flow would
     open, so copying by hand and opening WhatsApp cannot say different
     things. Every other status keeps the neutral status note. */
  const message = record.status === "APPROVED"
    ? approvalMessage(record, leader.name)
    : record.status === "REJECTED"
    ? rejectionMessage(record, leader.name)
    : [
        "QQSGP Free Fire Championship — " + record.teamName,
        "",
        "Hi " + leader.name + ", this is the tournament organising team.",
        "Your squad (" + record.playerCount + " players) is currently " + record.status + ".",
        "",
        "Please make sure every player is ready at the reporting time and shares the same in-game names as registered."
      ].join("\n");

  try {
    await navigator.clipboard.writeText(message);
    toast("Message copied. Paste it into WhatsApp and send it yourself.", "ok");
  } catch (ignored) {
    toast("This browser blocked the clipboard. Use Open WhatsApp instead.", "error");
  }
});

/* ------------------------------ settings ----------------------------- */

/* Loaded once per sign-in: the fee lives in the sheet, so the dashboard reads
   it rather than assuming the number it was written with. */
let settingsLoaded = false;

async function loadSettings() {
  const result = await api("settings-get");

  if (!result.ok) {
    if (settingsState) settingsState.textContent = "The fee could not be read. " + (result.error || "");
    if (feeSave) feeSave.disabled = true;
    return;
  }

  if (feeInput) feeInput.value = String(result.fee);
  if (feeSave) feeSave.disabled = false;
  if (settingsState) {
    settingsState.textContent = "Live fee " + formatMoney(result.fee) + " · online payment " +
      (result.online
        ? "on (" + (result.provider || "provider") + ")" +
          (result.provider === "YOUPI"
            ? " · hosted checkout · needs verification level " + result.minVerification
            : "")
        : "not configured yet" +
          (Array.isArray(result.missing) && result.missing.length
            ? " — missing Script Properties: " + result.missing.join(", ")
            : ""));
  }
}

if (feeSave) {
  feeSave.addEventListener("click", async () => {
    const fee = Number(feeInput.value);
    if (!Number.isFinite(fee) || fee < 1 || fee > 10000 || Math.round(fee) !== fee) {
      toast("Enter a whole number between 1 and 10000.", "error");
      feeInput.focus();
      return;
    }

    feeSave.disabled = true;
    const result = await api("settings-set", { fee: Math.round(fee) });
    feeSave.disabled = false;

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    feeInput.value = String(result.fee);
    toast("Entry fee saved as " + formatMoney(result.fee) + ". New registrations will be charged this.", "ok");
    loadSettings();
  });
}

/* ------------------------- payments to review ------------------------- */

const REVIEW_REASONS = {
  "NEEDS REVIEW": "Gateway could not verify strongly enough",
  "MISMATCH": "Amount or currency did not match the fee",
  "PAID - NO SLOT": "Paid, but the team could not be added"
};

function reviewRow(draft) {
  const amount = draft.paidAmount ? draft.paidAmount : draft.fee;
  return (
    "<tr data-token=\"" + escapeHtml(draft.token) + "\">" +
    "<td class=\"cell-team\">" + escapeHtml(draft.teamName) +
      "<small>" + escapeHtml(draft.department || "") + "</small></td>" +
    "<td>" + escapeHtml(formatMoney(amount)) + "</td>" +
    "<td>" + escapeHtml(draft.provider || "—") + "</td>" +
    "<td class=\"mono\">" + escapeHtml(draft.paymentId || draft.orderId || "—") + "</td>" +
    "<td>" + escapeHtml(REVIEW_REASONS[draft.status] || draft.status) +
      (draft.verification ? "<small>" + escapeHtml(draft.verification) + "</small>" : "") + "</td>" +
    "<td class=\"cell-actions\">" +
      "<button class=\"btn btn-primary btn-sm\" data-review=\"accept\" type=\"button\">Accept</button> " +
      "<button class=\"btn btn-ghost btn-sm\" data-review=\"reject\" type=\"button\">Reject</button>" +
    "</td></tr>"
  );
}

async function loadReview() {
  if (!reviewRows) return;

  const result = await api("drafts-list");
  if (!result.ok) {
    if (reviewState) reviewState.textContent = result.error || "The review queue could not be read.";
    return;
  }

  const drafts = result.drafts || [];
  reviewRows.innerHTML = drafts.map(reviewRow).join("");
  if (reviewEmpty) reviewEmpty.hidden = drafts.length > 0;
  if (reviewState) {
    reviewState.textContent = drafts.length
      ? drafts.length + (drafts.length === 1 ? " payment is" : " payments are") +
        " waiting for a human decision. Gateway: " + (result.provider || "—") +
        (result.provider === "YOUPI" ? " (needs verification level " + result.minVerification + ")" : "")
      : "Nothing waiting. Gateway: " + (result.provider || "—") +
        (result.provider === "YOUPI" ? " (needs verification level " + result.minVerification + ")" : "");
  }
}

if (reviewRefresh) {
  reviewRefresh.addEventListener("click", () => {
    reviewRefresh.disabled = true;
    loadReview().finally(() => { reviewRefresh.disabled = false; });
  });
}

if (reviewRows) {
  reviewRows.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-review]");
    if (!button) return;
    const row = button.closest("tr");
    const token = row ? row.getAttribute("data-token") : "";
    const decision = button.getAttribute("data-review");
    if (!token) return;

    const note = window.prompt(
      decision === "accept"
        ? "How did you check that this money arrived? (For example: \"seen in UPI app, UTR 1234\")"
        : "Why is this payment rejected?"
    );
    if (note === null) return;
    if (!note.trim()) {
      toast("A short note is required for the audit trail.", "error");
      return;
    }

    button.disabled = true;
    const result = await api("draft-resolve", { token: token, decision: decision, note: note.trim() });
    button.disabled = false;

    if (!result.ok) {
      toast(result.error || "That payment could not be resolved.", "error");
      return;
    }

    toast(
      decision === "accept"
        ? "Saved as Paid" + (result.registrationId ? " · " + result.registrationId : "") + "."
        : "Payment rejected; nothing was registered.",
      "ok"
    );
    loadReview();
    load({ silent: true });
  });
}

/* -------------------------------- CSV -------------------------------- */

exportBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  const result = await api("export", {
    status: state.status,
    department: state.department,
    q: state.query
  });
  exportBtn.disabled = false;

  if (!result.ok) {
    toast(result.error, "error");
    return;
  }

  const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = result.filename || "qqsgp-registrations.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(result.total + (result.total === 1 ? " record exported." : " records exported."), "ok");
});

/* ------------------------------- filters ----------------------------- */

regRows.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-id]");
  if (!row) return;
  const record = findRecord(row.dataset.id);
  if (record) openDrawer(record);
});

regRows.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("tr[data-id]");
  if (!row) return;
  event.preventDefault();
  const record = findRecord(row.dataset.id);
  if (record) openDrawer(record);
});

searchInput.addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    state.query = searchInput.value.trim();
    state.page = 1;
    load();
  }, 320);
});

departmentFilter.addEventListener("change", () => {
  state.department = departmentFilter.value;
  state.page = 1;
  load();
});

paymentFilter.addEventListener("change", () => {
  state.payment = paymentFilter.value;
  state.page = 1;
  load();
});

methodFilter.addEventListener("change", () => {
  state.method = methodFilter.value;
  state.page = 1;
  load();
});

statusChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    state.status = chip.dataset.status;
    state.page = 1;
    statusChips.forEach((other) => {
      const active = other === chip;
      other.classList.toggle("is-active", active);
      other.setAttribute("aria-pressed", active ? "true" : "false");
    });
    load();
  });
});

prevBtn.addEventListener("click", () => {
  if (state.page <= 1) return;
  state.page -= 1;
  load();
});

nextBtn.addEventListener("click", () => {
  const last = Math.min(state.page * state.pageSize, state.total);
  if (last >= state.total) return;
  state.page += 1;
  load();
});

refreshBtn.addEventListener("click", () => load());

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !drawer.hidden && confirmBackdrop.hidden) closeDrawer();
});

/* --------------------------- auto refresh ---------------------------- */

function startAutoRefresh() {
  stopAutoRefresh();
  state.autoTimer = setInterval(() => {
    if (document.hidden) return;
    if (document.activeElement === noteInput) return;
    load({ silent: true });
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (state.autoTimer) clearInterval(state.autoTimer);
  state.autoTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && (state.session || state.key)) load({ silent: true });
});

/* ==================================================================
   ORGANISER ACCOUNTS  (Super Admin only)
   ------------------------------------------------------------------
   Every action here is a server call. The panel is hidden for an
   Organizer, but hiding it is only cosmetic: the server refuses the
   same calls with FORBIDDEN if an Organizer ever sends them.
   ================================================================== */

function orgRow(account) {
  const tone = account.enabled ? "is-good" : "is-bad";
  const stateLabel = account.enabled ? "Enabled" : "Disabled";
  const last = account.lastLogin ? timeOf(account.lastLogin) + " · " + escapeHtml(account.lastDevice || "") : "Never";

  return '<tr>' +
    '<td data-label="Organiser"><strong>' + escapeHtml(account.name) + '</strong>' +
      '<span class="row-sub">' + escapeHtml(account.id) + '</span></td>' +
    '<td data-label="Role"><span class="role-chip' +
      (account.role === "SUPER" ? ' is-super' : '') + '">' + escapeHtml(account.role) + '</span></td>' +
    '<td data-label="State"><span class="badge ' + tone + '">' + stateLabel + '</span></td>' +
    '<td data-label="Last sign-in">' + last + '</td>' +
    '<td data-label="Actions">' +
      '<button class="btn btn-mini" data-org-reset="' + escapeHtml(account.id) + '">Reset PIN</button> ' +
      '<button class="btn btn-mini" data-org-toggle="' + escapeHtml(account.id) + '">' +
        (account.enabled ? "Disable" : "Enable") + '</button> ' +
      '<button class="btn btn-mini" data-org-role="' + escapeHtml(account.id) + '">' +
        (account.role === "SUPER" ? "Make Organizer" : "Make Super Admin") + '</button> ' +
      '<button class="btn btn-mini" data-org-revoke="' + escapeHtml(account.id) + '">Sign out</button>' +
    '</td></tr>';
}

function orgSessionRow(session) {
  return '<tr>' +
    '<td data-label="Organiser">' + escapeHtml(session.name) + '</td>' +
    '<td data-label="Device">' + escapeHtml(session.device) + '</td>' +
    '<td data-label="Last seen">' + timeOf(session.lastSeen) + '</td>' +
    '<td data-label="Action"><button class="btn btn-mini" data-session-revoke="' +
      escapeHtml(session.handle) + '" data-session-who="' + escapeHtml(session.name) + '">End session</button></td>' +
    '</tr>';
}

function orgAuditRow(entry) {
  const tone = entry.result === "refused" ? "is-bad" : "is-good";
  return '<tr>' +
    '<td data-label="When">' + escapeHtml(entry.atLabel) + '</td>' +
    '<td data-label="Actor">' + escapeHtml(entry.actor) + '</td>' +
    '<td data-label="Action">' + escapeHtml(entry.action) + '</td>' +
    '<td data-label="Target">' + escapeHtml(entry.target) + '</td>' +
    '<td data-label="Result"><span class="badge ' + tone + '">' + escapeHtml(entry.result) + '</span></td>' +
    '</tr>';
}

async function orgRefresh_() {
  if (!can("accounts.manage")) return;

  const accounts = await api("account-list", {});
  if (!accounts.ok) {
    handleFailure(accounts, {});
    return;
  }

  state.accounts = accounts.accounts;
  orgSummary.textContent = accounts.accounts.length + " account(s), " +
    accounts.superAdmins + " active Super Admin(s), " + accounts.sessions.length + " signed-in device(s).";
  orgRows.innerHTML = accounts.accounts.map(orgRow).join("");
  orgSessions.innerHTML = accounts.sessions.length
    ? accounts.sessions.map(orgSessionRow).join("")
    : '<tr><td colspan="4">No device is signed in.</td></tr>';

  const audit = await api("audit-list", { pageSize: 25 });
  if (audit.ok) {
    orgAudit.innerHTML = audit.entries.length
      ? audit.entries.map(orgAuditRow).join("")
      : '<tr><td colspan="5">Nothing recorded yet.</td></tr>';
  } else if (audit.code === "FORBIDDEN") {
    orgAudit.innerHTML = '<tr><td colspan="5">Your role cannot read the audit trail.</td></tr>';
  }
}

orgRefresh.addEventListener("click", () => orgRefresh_());

orgCreateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const id = organisIdSafe(orgNewId.value);
  const pin = orgNewPin.value;

  if (!id || pin.length < 6) {
    toast("Enter an organiser ID and a PIN of at least 6 characters.", "error");
    return;
  }

  askConfirm("Create this account?", "\"" + id + "\" will be able to sign in with the PIN you typed. " +
    "The PIN is hashed on the server and cannot be read back, so write it down before you continue.",
    "Create account", async () => {
      orgCreateBtn.disabled = true;
      const result = await api("account-create", {
        organiserId: id,
        name: orgNewName.value,
        role: orgNewRole.value,
        pin: pin
      });
      orgCreateBtn.disabled = false;

      if (!result.ok) {
        toast(result.error, "error");
        return;
      }

      orgCreateForm.reset();
      toast("Created " + result.account.id + " as " + result.account.role + ".");
      orgRefresh_();
    });
});

orgSelfForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  orgSelfBtn.disabled = true;

  const result = await api("self-change-pin", {
    currentPin: orgCurrentPin.value,
    newPin: orgNewSelfPin.value,
    device: deviceLabel()
  });

  orgSelfBtn.disabled = false;
  orgCurrentPin.value = "";
  orgNewSelfPin.value = "";

  if (!result.ok) {
    toast(result.error, "error");
    return;
  }

  /* The server ended every session for this account, including this one, and
     issued a replacement so the organiser is not thrown out mid-task. */
  if (result.session) {
    state.session = result.session;
    writeStorage(KEY_SESSION, result.session, false);
  }
  toast("PIN changed. Your other devices were signed out.");
  orgRefresh_();
});

function orgHandleClick(event) {
  const reset = event.target.closest("[data-org-reset]");
  if (reset) return orgResetPin(reset.getAttribute("data-org-reset"));

  const toggle = event.target.closest("[data-org-toggle]");
  if (toggle) return orgToggleAccount(toggle.getAttribute("data-org-toggle"));

  const role = event.target.closest("[data-org-role]");
  if (role) return orgChangeRole(role.getAttribute("data-org-role"));

  const revoke = event.target.closest("[data-org-revoke]");
  if (revoke) return orgRevokeSessions(revoke.getAttribute("data-org-revoke"));

  const sessionEnd = event.target.closest("[data-session-revoke]");
  if (sessionEnd) {
    return orgEndSession(sessionEnd.getAttribute("data-session-revoke"), sessionEnd.getAttribute("data-session-who"));
  }
}

orgPanel.addEventListener("click", orgHandleClick);

function orgResetPin(id) {
  const pin = window.prompt("New PIN for \"" + id + "\" (6+ characters). It is hashed on the server and never shown again:");
  if (pin === null) return;

  if (pin.length < 6) {
    toast("The PIN must be at least 6 characters.", "error");
    return;
  }

  askConfirm("Reset this PIN?", "The old PIN stops working immediately and every device signed in as \"" +
    id + "\" is signed out.", "Reset PIN", async () => {
      const result = await api("account-reset-pin", { id: id, pin: pin });
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      toast("PIN reset. " + result.sessionsRevoked + " session(s) ended.");
      orgRefresh_();
    });
}

function orgToggleAccount(id) {
  const account = (state.accounts || []).filter((a) => a.id === id)[0];
  const next = account ? !account.enabled : false;

  askConfirm(next ? "Enable this account?" : "Disable this account?",
    next ? "\"" + id + "\" will be able to sign in again."
         : "\"" + id + "\" cannot sign in, and any device already signed in as them is signed out now.",
    next ? "Enable" : "Disable",
    async () => {
      const result = await api("account-update", { id: id, enabled: next });
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      toast(id + " is now " + (next ? "enabled" : "disabled") + ".");
      orgRefresh_();
    });
}

function orgChangeRole(id) {
  const account = (state.accounts || []).filter((a) => a.id === id)[0];
  const next = account && account.role === "SUPER" ? "ORGANIZER" : "SUPER";

  askConfirm("Change this role?", "\"" + id + "\" becomes " + next +
    (next === "SUPER" ? ", which grants full access to accounts and the audit trail." : ", which removes account management.") +
    " Their sessions are ended so the change takes effect at once.",
    "Change role",
    async () => {
      const result = await api("account-update", { id: id, role: next });
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      toast(id + " is now " + result.account.role + ".");
      orgRefresh_();
    });
}

function orgRevokeSessions(id) {
  askConfirm("Sign this organiser out everywhere?", "Every device signed in as \"" + id +
    "\" must sign in again. The account and PIN are unchanged.", "Sign out", async () => {
      const result = await api("account-revoke-sessions", { id: id });
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      toast("Ended " + result.revoked + " session(s).");
      orgRefresh_();
    });
}

function orgEndSession(handle, who) {
  askConfirm("End this session?", "That device is signed out of " + (who || "this account") +
    ". It can sign in again with its PIN.", "End session", async () => {
      const result = await api("session-revoke", { handle: handle });
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      toast("Session ended.");
      orgRefresh_();
    });
}

/* ------------------------------- startup ----------------------------- */

(function start() {
  statusChips.forEach((chip) => chip.setAttribute("aria-pressed", chip.classList.contains("is-active") ? "true" : "false"));

  /* Order matters: a real session is preferred, and the recovery key is only
     used when there is no session to resume. */
  const session = readStorage(KEY_SESSION);
  if (/^[a-f0-9]{64}$/.test(session)) {
    gateRemember.checked = true;
    resumeSession(session, true);
    return;
  }

  /* The recovery key is deliberately NOT resumed on load. Signing in with an
     organiser ID and PIN is the normal path; a leftover key is only offered,
     never used on its own, so this page always starts at the login. */
  const legacy = readStorage(KEY_LEGACY);
  if (legacy && legacy.length >= 20) {
    const recovery = document.querySelector(".gate-recovery");
    if (recovery) recovery.open = true;
    gateKey.value = legacy;
    gateRemember.checked = true;
  }

  gateId.focus();
})();

/* ==================================================================
   WHATSAPP PANEL
   ------------------------------------------------------------------
   Everything here talks to the Apps Script admin endpoints:
     notif-list      -> the log + whether the provider is connected
     notif-retry     -> resend one failed message (never a sent one)
     announce-preview-> recipient count + a one-time confirmation token
     announce-send   -> sends exactly the recipients that were previewed

   States shown are the ones the provider actually reported. "Accepted by
   provider" is not "delivered": delivery and read only arrive through the
   webhook, so they are only ever displayed when a receipt was recorded.
   ================================================================== */

const waState = {
  config: null,
  preview: null,
  teamsLoaded: false,
  teams: [],
  selected: {}
};

const waStateEl = document.getElementById("waState");
const waStateFilter = document.getElementById("waStateFilter");
const waRefresh = document.getElementById("waRefresh");
const waAudience = document.getElementById("waAudience");
const waSelectedBox = document.getElementById("waSelectedBox");
const waTeamList = document.getElementById("waTeamList");
const waMessage = document.getElementById("waMessage");
const waCount = document.getElementById("waCount");
const waConsentNote = document.getElementById("waConsentNote");
const waPreviewBox = document.getElementById("waPreviewBox");
const waPreviewCount = document.getElementById("waPreviewCount");
const waPreviewList = document.getElementById("waPreviewList");
const waPreviewBlocked = document.getElementById("waPreviewBlocked");
const waPreviewBtn = document.getElementById("waPreviewBtn");
const waSendBtn = document.getElementById("waSendBtn");
const waSendResult = document.getElementById("waSendResult");
const waRows = document.getElementById("waRows");
const waEmpty = document.getElementById("waEmpty");
const waTotals = document.getElementById("waTotals");

const WA_LABELS = {
  QUEUED: "Queued",
  SENT: "Accepted by provider",
  DELIVERED: "Delivered",
  READ: "Read",
  FAILED: "Failed",
  UNCERTAIN: "Uncertain",
  SKIPPED: "Skipped"
};

function waBadgeTone(state) {
  if (state === "FAILED" || state === "UNCERTAIN") return "is-bad";
  if (state === "SKIPPED") return "is-muted";
  if (state === "DELIVERED" || state === "READ") return "is-good";
  if (state === "SENT") return "is-sent";
  return "is-muted";
}

function waRenderConfig(config) {
  waState.config = config;
  if (!config) return;

  waStateEl.className = "wa-connection";
  if (!config.configured) {
    waStateEl.classList.add("is-off");
    waStateEl.textContent = config.enabled
      ? "Not connected — the provider credentials are missing in Script Properties."
      : "Switched off — set whatsapp_enabled to yes after adding the credentials.";
    waPreviewBtn.disabled = false;
    waSendBtn.disabled = true;
    return;
  }

  waStateEl.classList.add("is-on");
  waStateEl.textContent = "Connected · " +
    (config.mode === "template" ? "approved templates" : "text mode (testing only)") +
    " · templates " + Object.keys(config.templates || {}).length;
}

async function waLoadLog(silent) {
  if (!waRows) return;
  if (!silent) waRows.innerHTML = '<tr><td colspan="6" class="wa-loading">Loading…</td></tr>';

  const result = await api("notif-list", {
    state: waStateFilter ? waStateFilter.value : "ALL",
    page: 1,
    pageSize: 25
  });

  if (!result.ok) {
    waStateEl.className = "wa-connection is-off";
    waStateEl.textContent = result.error;
    waRows.innerHTML = '<tr><td colspan="6" class="wa-loading">Could not load notifications.</td></tr>';
    return;
  }

  waRenderConfig(result.config);
  waRenderLog(result.notifications || [], result.counts || {});
}

function waRenderLog(notifications, counts) {
  waRows.innerHTML = "";
  waEmpty.hidden = notifications.length > 0;

  if (waTotals) {
    waTotals.textContent = counts.total
      ? counts.total + " total · " + (counts.SENT || 0) + " accepted · " +
        (counts.DELIVERED || 0) + " delivered · " + (counts.FAILED || 0) + " failed"
      : "";
  }

  const fragment = document.createDocumentFragment();

  notifications.forEach((n) => {
    const tr = document.createElement("tr");
    tr.dataset.notification = n.id;

    const canRetry = n.state === "FAILED" || n.state === "UNCERTAIN";
    tr.innerHTML =
      '<td class="cell-team">' + escapeHtml(n.teamName || "—") +
        "<small>" + escapeHtml(n.registrationId || "") + "</small></td>" +
      '<td class="cell-dept">' + escapeHtml(n.typeLabel) + "</td>" +
      '<td class="cell-dept">+' + escapeHtml(n.recipient || "—") + "</td>" +
      '<td><span class="badge ' + waBadgeTone(n.state) + '">' +
        escapeHtml(WA_LABELS[n.state] || n.state) + "</span>" +
        (n.error ? '<small class="wa-error">' + escapeHtml(n.error) + "</small>" : "") +
        (n.attempts > 1 ? "<small>" + n.attempts + " attempts</small>" : "") + "</td>" +
      '<td class="cell-date">' + escapeHtml(n.createdLabel || "—") + "</td>" +
      '<td class="row-open">' +
        (canRetry ? '<button class="btn btn-ghost wa-retry" type="button">Retry</button>' : "") +
      "</td>";

    fragment.appendChild(tr);
  });

  waRows.appendChild(fragment);
}

async function waRetry(id, force) {
  const result = await api("notif-retry", { id: id, force: force === true });

  if (!result.ok) {
    if (result.code === "UNCERTAIN") {
      askConfirm(
        "Resend this message?",
        "The earlier attempt may already have reached the team. Sending again can deliver the same message twice.",
        "Resend anyway",
        () => waRetry(id, true)
      );
      return;
    }
    toast(result.error, "error");
    return;
  }

  toast("Message retried: " + (WA_LABELS[result.notification.state] || result.notification.state), "ok");
  waLoadLog(true);
}

async function waLoadTeams() {
  if (waState.teamsLoaded) return;
  const result = await api("list", { page: 1, pageSize: 100, status: "ALL" });
  if (!result.ok) return;

  waState.teams = result.records || [];
  waState.teamsLoaded = true;
  waRenderTeamList();
}

function waRenderTeamList() {
  waTeamList.innerHTML = "";

  if (!waState.teams.length) {
    waTeamList.innerHTML = '<li class="hint">No teams to choose from.</li>';
    return;
  }

  const fragment = document.createDocumentFragment();
  waState.teams.forEach((team) => {
    const li = document.createElement("li");
    const consent = team.whatsappConsent === true;
    li.innerHTML =
      '<label' + (consent ? "" : ' class="is-disabled"') + ">" +
        '<input type="checkbox" data-team="' + escapeHtml(team.id) + '"' +
          (consent ? "" : " disabled") + ">" +
        "<span><strong>" + escapeHtml(team.teamName) + "</strong>" +
          " · " + escapeHtml(team.status) +
          (consent ? "" : " · no WhatsApp consent") + "</span>" +
      "</label>";
    fragment.appendChild(li);
  });
  waTeamList.appendChild(fragment);
}

async function waPreview() {
  const message = waMessage.value.trim();
  if (!message) {
    toast("Write the announcement first.", "error");
    waMessage.focus();
    return;
  }

  const audience = waAudience.value;
  const ids = audience === "SELECTED"
    ? Object.keys(waState.selected).filter((id) => waState.selected[id])
    : [];

  if (audience === "SELECTED" && ids.length === 0) {
    toast("Tick at least one team.", "error");
    return;
  }

  waPreviewBtn.disabled = true;
  waPreviewBtn.textContent = "Checking…";

  const result = await api("announce-preview", { audience: audience, message: message, ids: ids });

  waPreviewBtn.disabled = false;
  waPreviewBtn.textContent = "Preview recipients";

  if (!result.ok) {
    toast(result.error, "error");
    return;
  }

  waState.preview = result;

  waPreviewBox.hidden = false;
  waPreviewCount.textContent = result.count === 0
    ? "No team would receive this message."
    : result.count + (result.count === 1 ? " team will receive it" : " teams will receive it") +
      (result.configured ? "" : " — but WhatsApp is not connected yet");

  waPreviewList.innerHTML = (result.samples || []).map((sample) =>
    "<li><strong>" + escapeHtml(sample.team) + "</strong> · " +
    escapeHtml(sample.leader || "leader not recorded") + " · " +
    escapeHtml(sample.status) + "</li>").join("");

  const blocked = result.blocked || { noConsent: 0, noNumber: 0 };
  waPreviewBlocked.textContent =
    (blocked.noConsent ? blocked.noConsent + " skipped (no consent). " : "") +
    (blocked.noNumber ? blocked.noNumber + " skipped (no number). " : "") +
    (result.count && result.samples && result.samples.length < result.count
      ? "Showing the first " + result.samples.length + "." : "");

  waSendBtn.disabled = result.count === 0 || !result.configured;
  waSendBtn.textContent = "Send announcement";
}

function waSend() {
  if (!waState.preview || !waState.preview.token) return;

  const count = waState.preview.count;
  const token = waState.preview.token;

  askConfirm(
    "Send to " + count + (count === 1 ? " team?" : " teams?"),
    "This submits the approved announcement template to each recipient on WhatsApp. " +
    "Messages that were already sent are never repeated.",
    "Send now",
    async () => {
      waSendBtn.disabled = true;
      waSendBtn.textContent = "Sending…";

      const result = await api("announce-send", { token: token });

      waSendBtn.textContent = "Send announcement";

      if (!result.ok) {
        toast(result.error, "error");
        waSendBtn.disabled = false;
        return;
      }

      waSendResult.hidden = false;
      waSendResult.textContent =
        result.sent + " sent · " + result.failed + " failed · " +
        result.skipped + " skipped" +
        (result.duplicate ? " · " + result.duplicate + " already sent" : "");

      toast(result.sent
        ? "Announcement sent to " + result.sent + (result.sent === 1 ? " team." : " teams.")
        : "Nothing new to send.", result.sent ? "ok" : "error");

      // The preview token is single-use in this UI: prepare again before
      // another send, so an accidental second click cannot blast the list.
      waState.preview = null;
      waSendBtn.disabled = true;
      waLoadLog(true);
    }
  );
}

if (waRows) {
  waRows.addEventListener("click", (event) => {
    const button = event.target.closest(".wa-retry");
    if (!button) return;
    const row = button.closest("tr[data-notification]");
    if (row) waRetry(row.dataset.notification, false);
  });

  waRefresh.addEventListener("click", () => waLoadLog(false));
  waStateFilter.addEventListener("change", () => waLoadLog(false));

  waAudience.addEventListener("change", () => {
    const selected = waAudience.value === "SELECTED";
    waSelectedBox.hidden = !selected;
    if (selected) waLoadTeams();
    waPreviewBox.hidden = true;
    waState.preview = null;
    waSendBtn.disabled = true;
    waSendResult.hidden = true;
  });

  waTeamList.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-team]");
    if (!input) return;
    waState.selected[input.dataset.team] = input.checked;
    waPreviewBox.hidden = true;
    waState.preview = null;
    waSendBtn.disabled = true;
  });

  waMessage.addEventListener("input", () => {
    waCount.textContent = String(waMessage.value.length);
    waPreviewBox.hidden = true;
    waState.preview = null;
    waSendBtn.disabled = true;
    waSendResult.hidden = true;
  });

  waPreviewBtn.addEventListener("click", waPreview);
  waSendBtn.addEventListener("click", waSend);
}

/* ==================================================================
   TOURNAMENT BOARD (M1-M6, assignments, scoring, publication)
   ================================================================== */
const matchForm = el("matchForm");
const matchSelect = el("matchSelect");
const matchMap = el("matchMap");
const matchWhen = el("matchWhen");
const matchStatus = el("matchStatus");
const matchRoomId = el("matchRoomId");
const matchPassword = el("matchPassword");
const matchRelease = el("matchRelease");
const matchNotes = el("matchNotes");
const matchRowsEl = el("matchRows");
const matchSummaryEl = el("matchSummary");
const assignMatch = el("assignMatch");
const assignTeam = el("assignTeam");
const assignSlot = el("assignSlot");
const assignBtn = el("assignBtn");
const resultForm = el("resultForm");
const resultMatch = el("resultMatch");
const resultTeam = el("resultTeam");
const resultPlacement = el("resultPlacement");
const resultKills = el("resultKills");
const resultNotes = el("resultNotes");
const resultRowsEl = el("resultRows");
const resultSummaryEl = el("resultSummary");
const leaderboardRows = el("leaderboardRows");
const tournamentRefresh = el("tournamentRefresh");
const exportExcel = el("exportExcel");
const maxTeamsInput = el("maxTeamsInput");
const killPointsInput = el("killPointsInput");
const placementPointsInput = el("placementPointsInput");
const tieBreakersInput = el("tieBreakersInput");
const scoringSave = el("scoringSave");
const matchStage = el("matchStage");
const matchRoomLabel = el("matchRoomLabel");
const roomChartRows = el("roomChartRows");
const roomChartTitle = el("roomChartTitle");
const roomChartMeta = el("roomChartMeta");
const roomChartHint = el("roomChartHint");
const chartCopy = el("chartCopy");
const chartShare = el("chartShare");
const chartShareQualified = el("chartShareQualified");
const chartCopyAll = el("chartCopyAll");
const resultCopy = el("resultCopy");
const resultShare = el("resultShare");
const leaderboardShare = el("leaderboardShare");
const scheduleCopy = el("scheduleCopy");
const scheduleShare = el("scheduleShare");
const addRoomBtn = el("addRoomBtn");

const MATCH_MAPS = ["Bermuda", "Purgatory", "Kalahari", "Alpine", "NeXTerra", "Solara", "Bermuda Remastered", "Purgatory Remastered"];

function localInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  // The form always speaks IST, even when the organiser opens it abroad.
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(d);
    const get = (type) => (parts.find((part) => part.type === type) || {}).value || "";
    return get("year") + "-" + get("month") + "-" + get("day") + "T" + get("hour") + ":" + get("minute");
  } catch (ignored) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
}

function fillMapOptions(matches) {
  const values = MATCH_MAPS.slice();
  (matches || []).forEach((m) => { if (m.map && values.indexOf(m.map) === -1) values.push(m.map); });
  const current = matchMap.value;
  matchMap.innerHTML = values.map((map) => `<option value="${escapeHtml(map)}">${escapeHtml(map)}</option>`).join("");
  matchMap.value = values.indexOf(current) === -1 ? values[0] : current;
}

function setSelectValue(select, value) {
  const text = value || "";
  if (text && !Array.from(select.options).some((option) => option.value === text)) {
    const option = document.createElement("option");
    option.value = text;
    option.textContent = text;
    select.appendChild(option);
  }
  select.value = text;
}

function stageText(match) {
  return [match.stage || "QUALIFIER", roomShareName(match)].filter(Boolean).join(" · ");
}

function stageShareName(stage) {
  const value = String(stage || "QUALIFIER").toUpperCase();
  if (value === "KNOCKOUT 1") return "KNOCKOUT STAGE 1";
  if (value === "KNOCKOUT 2") return "KNOCKOUT STAGE 2";
  if (value === "GRAND FINAL") return "GRAND FINAL";
  return "QUALIFIER";
}

function roomShareName(match) {
  const room = String((match && match.room) || "").trim();
  if (!room) return "";
  return /^room\b/i.test(room) ? room.toUpperCase() : "ROOM " + room.toUpperCase();
}

function matchShareTitle(match) {
  return [stageShareName(match && match.stage), roomShareName(match)].filter(Boolean).join(" — ");
}

function shareWhatsApp(text, emptyMessage) {
  if (!text) return toast(emptyMessage || "There is nothing to share yet.", "error");
  const link = document.createElement("a");
  link.href = "https://wa.me/?text=" + encodeURIComponent(text);
  link.target = "_blank";
  link.rel = "noopener";
  link.click();
}

function publishedTournamentResults() {
  return ((state.tournament && state.tournament.results) || []).filter((r) => r.status === "PUBLISHED");
}

function resultTieBreakers() {
  const configured = state.tournament && state.tournament.tieBreakers;
  return Array.isArray(configured) && configured.length === 3
    ? configured
    : ["total", "kills", "placement"];
}

function resultStandings(matchId, results, tieBreakers) {
  const order = Array.isArray(tieBreakers) && tieBreakers.length === 3
    ? tieBreakers
    : resultTieBreakers();
  return (results || []).filter((r) => r.matchId === matchId).sort((a, b) => {
    for (const key of order) {
      let diff = 0;
      if (key === "total") diff = (Number(b.total) || 0) - (Number(a.total) || 0);
      else if (key === "kills") diff = (Number(b.kills) || 0) - (Number(a.kills) || 0);
      else diff = (Number(a.placement) || 999) - (Number(b.placement) || 999);
      if (diff) return diff;
    }
    return String(a.teamName || "").localeCompare(String(b.teamName || ""));
  });
}

function resultSlotMap(match) {
  const map = {};
  ((match && match.teams) || []).forEach((assignment) => { map[assignment.teamId] = assignment.slot; });
  return map;
}

function fillMatchForm(match) {
  if (!match) return;
  matchSelect.value = match.id;
  setSelectValue(matchMap, match.map || "Bermuda");
  setSelectValue(matchStage, match.stage || "QUALIFIER");
  matchRoomLabel.value = match.room || "";
  matchWhen.value = localInput(match.scheduledAt);
  matchStatus.value = match.status || "SCHEDULED";
  matchRoomId.value = match.roomId || "";
  matchPassword.value = match.roomPassword || "";
  matchRelease.value = localInput(match.releaseAt);
  matchNotes.value = match.notes || "";
  matchForm.scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderRoomChart(match, results) {
  if (!match || !roomChartRows) return;
  const standings = resultStandings(match.id, results, resultTieBreakers());
  const qualified = standings.length >= 6 ? new Set(standings.slice(0, 6).map((r) => r.teamId)) : new Set();
  const bySlot = {};
  (match.teams || []).forEach((assignment) => { bySlot[assignment.slot] = assignment; });
  const resultByTeam = {};
  standings.forEach((r) => { resultByTeam[r.teamId] = r; });

  roomChartTitle.textContent = match.id + " · " + stageText(match);
  const meta = [match.map || "Map TBD", match.scheduledLabel || "Not scheduled", match.status];
  if (match.hasRoom) meta.push(match.roomReleased ? "Room released" : "Room at " + (match.releaseLabel || "TBA"));
  roomChartMeta.textContent = meta.join(" · ");

  let rows = "";
  for (let slot = 1; slot <= 12; slot++) {
    const assignment = bySlot[slot];
    const result = assignment ? resultByTeam[assignment.teamId] : null;
    const isQualified = assignment && qualified.has(assignment.teamId);
    rows += `<tr class="${isQualified ? "chart-qualified" : ""}">
      <td><b>${slot}</b></td>
      <td class="cell-team">${assignment ? escapeHtml(assignment.teamName) : '<span class="hint">Open slot</span>'}</td>
      <td>${result ? "#" + result.placement + " · " + result.kills + " kills · <b>" + result.total + " pts</b>" : "—"}</td>
      <td>${isQualified ? '<span class="badge badge-q">QUALIFIED</span>' : (result ? '<span class="badge">PLAYED</span>' : '<span class="badge">OPEN</span>')}</td>
      <td class="cell-actions">${assignment
        ? `<button class="btn btn-ghost btn-sm" type="button" data-remove-team="${escapeHtml(assignment.teamId)}" data-remove-match="${escapeHtml(match.id)}">Remove</button>`
        : ""}</td>
    </tr>`;
  }
  roomChartRows.innerHTML = rows;
  roomChartHint.textContent = standings.length >= 6
    ? "Top 6 in the standings are marked QUALIFIED for the next stage."
    : "Enter at least 6 results to mark the top 6 qualifiers. Each room holds 12 teams.";
}

function padChartCell(value, width, alignRight) {
  const text = value == null ? "" : String(value);
  if (text.length >= width) return text;
  const fill = new Array(width - text.length + 1).join(" ");
  return alignRight ? fill + text : text + fill;
}

/* WhatsApp renders a proportional font, so columns only stay readable when every
   cell is padded to the width of its widest entry and numbers are right-aligned. */
function chartTableText(headers, rows, rightFrom) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] == null ? "" : row[index]).length))
  );
  return [headers].concat(rows).map((row) => row.map((cell, index) => {
    const padded = padChartCell(cell, widths[index], index >= rightFrom);
    return index === row.length - 1 ? padded.replace(/\s+$/, "") : padded;
  }).join("  ")).join("\n");
}

function roomChartText(match, results) {
  if (!match) return "";
  const lines = ["QQSGP FREE FIRE TOURNAMENT", "", matchShareTitle(match), ""];
  lines.push("Map: " + (match.map || "TBD"));
  lines.push("Scheduled at: " + (match.scheduledLabel || "Not scheduled"));
  if (match.hasRoom && match.roomReleased && (match.roomId || match.roomPassword)) {
    lines.push("Room ID: " + (match.roomId || "—"));
    lines.push("Password: " + (match.roomPassword || "—"));
  } else if (match.hasRoom) {
    lines.push("Room ID & password: release at " + (match.releaseLabel || "TBA"));
  } else {
    lines.push("Room ID & password: not set yet");
  }
  lines.push("");
  const bySlot = {};
  (match.teams || []).forEach((assignment) => { bySlot[assignment.slot] = assignment; });
  const resultByTeam = {};
  resultStandings(match.id, results, resultTieBreakers()).forEach((row) => { resultByTeam[row.teamId] = row; });
  const rows = [];
  for (let slot = 1; slot <= 12; slot++) {
    const assignment = bySlot[slot];
    const player = assignment ? resultByTeam[assignment.teamId] : null;
    rows.push([
      "#" + String(slot).padStart(2, "0") + ".",
      assignment ? assignment.teamName : "TBD",
      player ? (Number(player.placement) === 1 ? 1 : 0) : "-",
      player ? 1 : "-",
      player ? player.placement : "-",
      player ? player.kills : "-",
      player ? player.total : "-"
    ]);
  }
  lines.push(chartTableText(
    ["RANK", "TEAM", "BOOYAH", "MATCHES", "POS", "ELIMS", "PTS"],
    rows,
    2
  ));
  lines.push("", "Only the top 6 teams qualify for the next stage.", "Best of luck, everyone!");
  return lines.join("\n");
}

function scheduleShareText(matches) {
  const list = matches || [];
  if (!list.length) return "";
  const lines = ["QQSGP FREE FIRE TOURNAMENT", "", "MATCH SCHEDULE", ""];
  list.forEach((match) => {
    lines.push(match.id + " — " + matchShareTitle(match));
    lines.push("Map: " + (match.map || "TBD"));
    lines.push("Scheduled at: " + (match.scheduledLabel || "Not scheduled"));
    lines.push("Status: " + (match.status || "SCHEDULED"));
    if (match.hasRoom && match.roomReleased && (match.roomId || match.roomPassword)) {
      lines.push("Room ID: " + (match.roomId || "—"));
      lines.push("Password: " + (match.roomPassword || "—"));
    } else if (match.hasRoom) {
      lines.push("Room details: release at " + (match.releaseLabel || "TBA"));
    } else {
      lines.push("Room details: not set yet");
    }
    lines.push("");
  });
  return lines.join("\n").trim();
}

function resultChartText(match, results, tieBreakers) {
  if (!match) return "";
  const standings = resultStandings(match.id, results, tieBreakers);
  if (!standings.length) return "";
  const qualified = standings.length >= 6 ? new Set(standings.slice(0, 6).map((r) => r.teamId)) : new Set();
  const slots = resultSlotMap(match);
  const lines = ["QQSGP FREE FIRE TOURNAMENT", "", "RESULT — " + match.id + " — " + matchShareTitle(match), ""];
  standings.forEach((r, index) => {
    lines.push(String(index + 1).padStart(2, "0") + ". " + r.teamName +
      " (slot " + (slots[r.teamId] || "?") + ") — Placement " + r.placement +
      " · Kills " + r.kills + " · " + r.total + " pts" +
      (qualified.size ? (qualified.has(r.teamId) ? " · QUALIFIED" : " · ELIMINATED") : ""));
  });
  lines.push("", "Only the top 6 teams qualify for the next stage.");
  return lines.join("\n");
}

function qualifiedTeamsText(match, results, tieBreakers) {
  if (!match) return "";
  const standings = resultStandings(match.id, results, tieBreakers).slice(0, 6);
  if (standings.length < 6) return "";
  const slots = resultSlotMap(match);
  const lines = ["QQSGP FREE FIRE TOURNAMENT", "", "QUALIFIED TEAMS — " + matchShareTitle(match), ""];
  standings.forEach((r, index) => {
    lines.push(String(index + 1).padStart(2, "0") + ". " + r.teamName +
      (slots[r.teamId] ? " (slot " + slots[r.teamId] + ")" : "") +
      " — " + r.total + " pts");
  });
  lines.push("", "Only the top 6 teams qualify for the next stage.", "Best of luck, everyone!");
  return lines.join("\n");
}

function leaderboardShareText(board) {
  const rows = board || [];
  if (!rows.length) return "";
  const lines = ["QQSGP FREE FIRE TOURNAMENT", "", "OVERALL LEADERBOARD", ""];
  rows.forEach((row) => {
    lines.push(String(row.rank).padStart(2, "0") + ". " + row.teamName +
      " — " + row.total + " pts · " + row.kills + " kills · " + row.matches + " match" + (row.matches === 1 ? "" : "es"));
  });
  return lines.join("\n");
}

function resultAndLeaderboardText(match, results, board, tieBreakers) {
  return [resultChartText(match, results, tieBreakers), leaderboardShareText(board)].filter(Boolean).join("\n\n");
}

async function copyChart(text, okMessage) {
  if (!text) return toast("There is no chart to copy yet.", "error");
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage || "Chart copied. Paste it into WhatsApp.", "ok");
  } catch (ignored) {
    toast("This browser blocked the clipboard.", "error");
  }
}

function renderTournament() {
  const t = state.tournament;
  if (!t) return;
  const ids = t.matches.map((m) => m.id);
  fillMapOptions(t.matches);
  const keep = (select, html) => {
    const current = select.value;
    select.innerHTML = html;
    if (current) select.value = current;
  };
  keep(matchSelect, ids.map((id) => `<option>${id}</option>`).join(""));
  keep(assignMatch, ids.map((id) => `<option>${id}</option>`).join(""));
  keep(resultMatch, ids.map((id) => `<option>${id}</option>`).join(""));
  const approved = (Array.isArray(t.teams) ? t.teams : []).filter((team) => team.status === "APPROVED");
  assignTeam.innerHTML = approved.length
    ? approved.map((team) => `<option value="${escapeHtml(team.id)}">${escapeHtml(team.teamName)}</option>`).join("")
    : '<option value="">No approved teams yet</option>';
  const selectedMatch = resultMatch.value || ids[0];
  const match = t.matches.find((m) => m.id === selectedMatch);
  const eligible = match ? approved.filter((team) => match.teams.some((a) => a.teamId === team.id)) : [];
  resultTeam.innerHTML = eligible.length
    ? eligible.map((team) => `<option value="${escapeHtml(team.id)}">${escapeHtml(team.teamName)}</option>`).join("")
    : '<option value="">Assign an approved team first</option>';

  matchSummaryEl.textContent = t.matches.length + " rooms · " + approved.length + " approved teams · 12 slots per room · top 6 qualify";
  matchRowsEl.innerHTML = t.matches.map((m) => `<tr data-match="${m.id}">
    <td class="cell-team">${m.id}<small>${escapeHtml(stageText(m))}${m.map ? " · " + escapeHtml(m.map) : ""}</small></td>
    <td>${escapeHtml(m.scheduledLabel)}</td><td><span class="badge">${m.status}</span></td>
    <td>${m.hasRoom ? "Set" : "—"}<small>${m.roomReleased ? "Released" : escapeHtml(m.releaseLabel || "No release")}</small></td>
    <td>${m.teamCount}/12</td><td>${m.publishedCount}/${m.resultCount} published</td>
    <td class="cell-actions"><button class="btn btn-ghost btn-sm" data-edit-match="${m.id}" type="button">Edit</button>${
      m.removable ? `<button class="btn btn-ghost btn-sm" data-remove-room="${m.id}" type="button">Delete</button>` : ""
    }</td></tr>`).join("");

  const slots = resultSlotMap(match);
  const standings = resultStandings(selectedMatch, t.results, resultTieBreakers());
  const qualified = standings.length >= 6 ? new Set(standings.slice(0, 6).map((r) => r.teamId)) : new Set();
  resultRowsEl.innerHTML = standings.length ? standings.map((r, index) => `<tr>
    <td>#${index + 1}</td><td>${slots[r.teamId] || "—"}</td><td class="cell-team">${escapeHtml(r.teamName)}</td><td>${r.placement}</td><td>${r.kills}</td>
    <td>${r.placementPoints}</td><td>${r.killPoints}</td><td><b>${r.total}</b></td>
    <td>${qualified.size ? (qualified.has(r.teamId) ? "QUALIFIED" : "ELIMINATED") : "—"}</td><td>${r.status}</td></tr>`).join("")
    : `<tr><td colspan="10">No results entered for ${selectedMatch} yet.</td></tr>`;
  leaderboardRows.innerHTML = t.leaderboard.length ? t.leaderboard.slice(0, 20).map((row) => `<tr><td>${row.rank}</td><td class="cell-team">${escapeHtml(row.teamName)}</td><td>${row.matches}</td><td>${row.kills}</td><td><b>${row.total}</b></td></tr>`).join("")
    : '<tr><td colspan="5">The leaderboard appears after results are entered.</td></tr>';
  maxTeamsInput.value = t.maxTeams;
  killPointsInput.value = t.killPoints;
  placementPointsInput.value = (t.placementPoints || []).join(",");
  if (tieBreakersInput) setSelectValue(tieBreakersInput, (t.tieBreakers || ["total", "kills", "placement"]).join(","));
  renderRoomChart(t.matches.find((m) => m.id === (matchSelect.value || ids[0])), t.results);
  if (!matchWhen.value) fillMatchForm(t.matches[0]);
}

async function loadTournament() {
  if (!matchRowsEl) return;
  const result = await api("tournament");
  if (!result.ok) {
    matchSummaryEl.textContent = result.error || "The tournament board could not be read.";
    assignTeam.innerHTML = '<option value="">Teams unavailable — refresh</option>';
    resultTeam.innerHTML = '<option value="">Teams unavailable — refresh</option>';
    return;
  }
  state.tournament = result;
  renderTournament();
}

addRoomBtn && addRoomBtn.addEventListener("click", async () => {
  addRoomBtn.disabled = true;
  const result = await api("match-add", {});
  addRoomBtn.disabled = false;
  if (!result.ok) return toast(result.error, "error");
  toast(result.message || "Room added.", "ok");
  await loadTournament();
  if (result.match && result.match.id) {
    [matchSelect, assignMatch, resultMatch].forEach((select) => { if (select) select.value = result.match.id; });
    renderTournament();
  }
});
roomChartRows && roomChartRows.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-team]");
  if (!button) return;
  const matchId = button.dataset.removeMatch;
  const teamId = button.dataset.removeTeam;
  const name = (button.closest("tr") && button.closest("tr").querySelector(".cell-team")
    ? button.closest("tr").querySelector(".cell-team").textContent.trim() : "This team");
  if (!confirm("Remove " + name + " from " + matchId + "? Their slot becomes free for another team.")) return;
  const result = await api("match-unassign", { matchId, teamId });
  if (!result.ok) return toast(result.error, "error");
  toast(result.message || "Team removed.", "ok");
  await loadTournament();
});
matchRowsEl && matchRowsEl.addEventListener("click", async (event) => {
  const removeRoom = event.target.closest("[data-remove-room]");
  if (removeRoom && state.tournament) {
    const id = removeRoom.dataset.removeRoom;
    if (!confirm("Delete room " + id + "? Only an empty room added from the dashboard can be deleted.")) return;
    const removed = await api("match-remove", { matchId: id });
    if (!removed.ok) return toast(removed.error, "error");
    toast(removed.message || "Room deleted.", "ok");
    await loadTournament();
    return;
  }
  const button = event.target.closest("[data-edit-match]");
  if (!button || !state.tournament) return;
  const selected = state.tournament.matches.find((m) => m.id === button.dataset.editMatch);
  fillMatchForm(selected);
  if (assignMatch) assignMatch.value = selected.id;
  if (resultMatch) resultMatch.value = selected.id;
  renderTournament();
});
matchSelect && matchSelect.addEventListener("change", () => { resultMatch.value = matchSelect.value; renderTournament(); });
resultMatch && resultMatch.addEventListener("change", () => { matchSelect.value = resultMatch.value; renderTournament(); });
assignMatch && assignMatch.addEventListener("change", () => {
  matchSelect.value = assignMatch.value;
  resultMatch.value = assignMatch.value;
  renderTournament();
});
tournamentRefresh && tournamentRefresh.addEventListener("click", () => { load(); loadTournament(); });
matchForm && matchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api("match-save", {
    matchId: matchSelect.value, map: matchMap.value, stage: matchStage.value, roomLabel: matchRoomLabel.value,
    scheduledAt: matchWhen.value, status: matchStatus.value, roomId: matchRoomId.value,
    roomPassword: matchPassword.value, releaseAt: matchRelease.value, notes: matchNotes.value
  });
  if (!result.ok) return toast(result.error, "error");
  toast(result.message || "Match saved.", "ok");
  await loadTournament();
});
assignBtn && assignBtn.addEventListener("click", async () => {
  const result = await api("match-assign", { matchId: assignMatch.value, teamId: assignTeam.value, slot: assignSlot.value });
  if (!result.ok) return toast(result.error, "error");
  toast(result.message || "Team assigned.", "ok");
  assignSlot.value = "";
  await loadTournament();
});
chartCopy && chartCopy.addEventListener("click", () => {
  if (!state.tournament) return;
  const match = state.tournament.matches.find((m) => m.id === matchSelect.value);
  copyChart(roomChartText(match, state.tournament.results), "Room chart copied. Paste it into WhatsApp.");
});
chartShare && chartShare.addEventListener("click", () => {
  if (!state.tournament) return;
  const match = state.tournament.matches.find((m) => m.id === matchSelect.value);
  shareWhatsApp(roomChartText(match, state.tournament.results), "There is no room chart to share yet.");
});
chartShareQualified && chartShareQualified.addEventListener("click", () => {
  if (!state.tournament) return;
  const match = state.tournament.matches.find((m) => m.id === matchSelect.value);
  const text = qualifiedTeamsText(match, publishedTournamentResults(), resultTieBreakers());
  if (!text) return toast("Publish at least 6 results for this room before sharing qualifiers.", "error");
  shareWhatsApp(text);
});
chartCopyAll && chartCopyAll.addEventListener("click", () => {
  if (!state.tournament) return;
  const text = state.tournament.matches.map((match) => roomChartText(match, state.tournament.results)).join("\n\n————————————\n\n");
  copyChart(text, "All room charts copied.");
});
scheduleCopy && scheduleCopy.addEventListener("click", () => {
  if (!state.tournament) return;
  copyChart(scheduleShareText(state.tournament.matches), "Match schedule copied.");
});
scheduleShare && scheduleShare.addEventListener("click", () => {
  if (!state.tournament) return;
  shareWhatsApp(scheduleShareText(state.tournament.matches), "There is no schedule to share yet.");
});
resultCopy && resultCopy.addEventListener("click", () => {
  if (!state.tournament) return;
  const match = state.tournament.matches.find((m) => m.id === resultMatch.value);
  const text = resultChartText(match, publishedTournamentResults(), resultTieBreakers());
  if (!text) return toast("Publish this room's results before copying them.", "error");
  copyChart(text, "Published result chart copied.");
});
resultShare && resultShare.addEventListener("click", () => {
  if (!state.tournament) return;
  const match = state.tournament.matches.find((m) => m.id === resultMatch.value);
  const text = resultAndLeaderboardText(match, publishedTournamentResults(),
    state.tournament.publishedLeaderboard || [], resultTieBreakers());
  if (!text) return toast("Publish this room's results before sharing them.", "error");
  shareWhatsApp(text);
});
leaderboardShare && leaderboardShare.addEventListener("click", () => {
  if (!state.tournament) return;
  const text = leaderboardShareText(state.tournament.publishedLeaderboard || []);
  if (!text) return toast("Publish results before sharing the leaderboard.", "error");
  shareWhatsApp(text);
});
resultForm && resultForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api("result-save", {
    matchId: resultMatch.value, teamId: resultTeam.value,
    placement: resultPlacement.value, kills: resultKills.value, notes: resultNotes.value
  });
  if (!result.ok) return toast(result.error, "error");
  toast(result.message || "Result saved.", "ok");
  const keepMatch = resultMatch.value;
  resultForm.reset();
  resultMatch.value = keepMatch;
  await loadTournament();
});
el("resultApprove") && el("resultApprove").addEventListener("click", async () => {
  const result = await api("result-approve", { matchId: resultMatch.value });
  if (!result.ok) return toast(result.error, "error");
  toast(result.message || "Approved.", "ok");
  await loadTournament();
});
el("resultPublish") && el("resultPublish").addEventListener("click", async () => {
  if (!confirm("Publish these results to the public leaderboard?")) return;
  const result = await api("result-publish", { matchId: resultMatch.value });
  if (!result.ok) return toast(result.error, "error");
  toast(result.message || "Published.", "ok");
  await loadTournament();
});
el("resultUnpublish") && el("resultUnpublish").addEventListener("click", async () => {
  const result = await api("result-unpublish", { matchId: resultMatch.value });
  if (!result.ok) return toast(result.error, "error");
  toast(result.message || "Unpublished.", "ok");

  await loadTournament();
});
scoringSave && scoringSave.addEventListener("click", async () => {
  const result = await api("settings-set", {
    fee: feeInput.value, maxTeams: maxTeamsInput.value,
    killPoints: killPointsInput.value, placementPoints: placementPointsInput.value,
    tieBreakers: tieBreakersInput ? tieBreakersInput.value : "total,kills,placement"
  });
  if (!result.ok) return toast(result.error, "error");
  toast("Tournament settings saved.", "ok");
  loadSettings();
  await loadTournament();
});
downloadExport = async function (dataset) {
  const result = await api("export", { dataset: dataset || "registrations", status: state.status, department: state.department, q: state.query });
  if (!result.ok) return toast(result.error, "error");
  const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = result.filename || "qqsgp-export.csv";
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(result.total + " row(s) exported.", "ok");
};
exportExcel && exportExcel.addEventListener("click", async () => {
  const result = await api("export", { dataset: "registrations", format: "xlsx" });
  if (!result.ok) return toast(result.error, "error");
  const bytes = Uint8Array.from(atob(result.excel), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: result.mime || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = result.filename || "qqsgp.xlsx";
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast("Excel workbook exported.", "ok");
});
