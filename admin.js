/* ==================================================================
   QQSGP organiser dashboard
   ------------------------------------------------------------------
   Talks to the Apps Script backend on POST <URL>?action=admin.
   Every request carries the dashboard key; the server checks it before
   reading anything and answers { ok: false, code: 'AUTH' } if it does
   not match. Nothing here is trusted by the server: record ids are
   hashes, statuses and note text are validated again on the other side.
   ================================================================== */

/* Must stay identical to APPS_SCRIPT_URL in script.js — both files point at
   the same Web App deployment. */
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw_-E7L9mE7xGk_Fypf6tnTvAbG4wZu9idrycpawkakihtgKndDMknDLdZnt333T3y-/exec";

const REQUEST_TIMEOUT_MS = 20000;
const AUTO_REFRESH_MS = 30000;
const PAGE_SIZE = 25;
const STATUSES = ["PENDING", "APPROVED", "REJECTED", "WAITLISTED"];

/* Session storage keeps the key for this tab only; the "keep me signed in"
   box additionally lets it survive a reload. It never leaves this browser. */
const KEY_SESSION = "qqsgp_admin_key";
const KEY_PERSIST = "qqsgp_admin_key_remembered";

/* ------------------------------ elements ------------------------------ */

const el = (id) => document.getElementById(id);

const gate = el("gate");
const gateForm = el("gateForm");
const gateKey = el("gateKey");
const gateRemember = el("gateRemember");
const gateSubmit = el("gateSubmit");
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
  REJECTED: el("statRejected")
};

const regSummary = el("regSummary");
const searchInput = el("searchInput");
const departmentFilter = el("departmentFilter");
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
const drawerContactHint = el("drawerContactHint");
const statusButtons = Array.from(drawer.querySelectorAll("[data-set-status]"));

const confirmBackdrop = el("confirmBackdrop");
const confirmTitle = el("confirmTitle");
const confirmCopy = el("confirmCopy");
const confirmCancel = el("confirmCancel");
const confirmOk = el("confirmOk");

const toasts = el("toasts");

/* -------------------------------- state ------------------------------- */

const state = {
  key: "",
  records: [],
  counts: { total: 0, players: 0, PENDING: 0, APPROVED: 0, REJECTED: 0, WAITLISTED: 0 },
  departments: [],
  page: 1,
  pageSize: PAGE_SIZE,
  total: 0,
  status: "ALL",
  department: "",
  query: "",
  openId: null,
  lastFocus: null,
  busy: false,
  autoTimer: null,
  searchTimer: null
};

/* ------------------------------- helpers ------------------------------ */

function loadStoredKey() {
  try {
    return sessionStorage.getItem(KEY_SESSION) || localStorage.getItem(KEY_PERSIST) || "";
  } catch (ignored) {
    return state.key;
  }
}

function storeKey(key, remember) {
  try {
    sessionStorage.setItem(KEY_SESSION, key);
  } catch (ignored) {}
  try {
    if (remember) localStorage.setItem(KEY_PERSIST, key);
    else localStorage.removeItem(KEY_PERSIST);
  } catch (ignored) {}
}

function forgetKey() {
  try {
    sessionStorage.removeItem(KEY_SESSION);
    localStorage.removeItem(KEY_PERSIST);
  } catch (ignored) {}
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

  const body = Object.assign({ action: action, key: state.key }, extra || {});
  const url = APPS_SCRIPT_URL + (APPS_SCRIPT_URL.includes("?") ? "&" : "?") + "action=admin";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
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

function whatsappLink(number, message) {
  const digits = String(number || "").replace(/\D/g, "");
  if (!digits) return "";
  const withCode = digits.length === 10 ? "91" + digits : digits;
  return "https://wa.me/" + withCode + (message ? "?text=" + encodeURIComponent(message) : "");
}

/* ------------------------------ sign in ------------------------------- */

async function openDashboard(key, remember) {
  state.key = key;
  gateSubmit.disabled = true;
  gateSubmit.textContent = "Checking…";
  gateError.hidden = true;

  const result = await api("list", { page: 1, pageSize: state.pageSize, status: "ALL" });

  gateSubmit.disabled = false;
  gateSubmit.textContent = "Open dashboard";

  if (!result.ok) {
    state.key = "";
    gateError.hidden = false;
    gateError.textContent = result.code === "AUTH"
      ? "That key was refused. Check it matches the value from setupAdminKey()."
      : result.error;
    gateKey.focus();
    gateKey.select();
    return;
  }

  storeKey(key, remember);
  gate.hidden = true;
  shell.hidden = false;
  applyResult(result, { keepPage: false });
  startAutoRefresh();
  refreshBtn.focus();
  // The notification log is a separate read, so a slow provider can never hold
  // up the registrations table.
  waLoadLog(true);
}

gateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const key = gateKey.value.trim();
  if (key.length < 20) {
    gateError.hidden = false;
    gateError.textContent = "The key looks too short — keys from setupAdminKey() are 64 characters.";
    return;
  }
  openDashboard(key, gateRemember.checked);
});

signOutBtn.addEventListener("click", () => {
  forgetKey();
  state.key = "";
  state.records = [];
  stopAutoRefresh();
  closeDrawer();
  shell.hidden = true;
  gate.hidden = false;
  gateKey.value = "";
  gateKey.focus();
  toast("Signed out. The key was cleared from this browser.");
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
    q: state.query
  });

  state.busy = false;
  refreshBtn.disabled = false;

  if (!result.ok) {
    handleFailure(result, opts);
    return;
  }

  applyResult(result, { keepPage: true });

  /* Keep the open drawer in step with fresh data; close it if the record
     was changed by someone else and no longer exists in the list. */
  if (state.openId) {
    const still = state.records.filter((record) => record.id === state.openId)[0];
    if (still) fillDrawer(still);
    else closeDrawer();
  }
}

function handleFailure(result, opts) {
  if (result.code === "AUTH") {
    stopAutoRefresh();
    forgetKey();
    state.key = "";
    shell.hidden = true;
    gate.hidden = false;
    gateError.hidden = false;
    gateError.textContent = "This session is no longer authorised. The server refused the key — it may have been regenerated, or too many wrong attempts locked it for a few minutes.";
    gateKey.focus();
    return;
  }

  setRefreshState("error", result.code === "TIMEOUT" ? "Timed out" : "Offline");

  if (state.records.length === 0) {
    showState("Could not load registrations", result.error);
  }
  if (!opts.silent) toast(result.error, "error");
}

/* ------------------------------- render ------------------------------- */

function renderStats() {
  const counts = state.counts;
  stats.teams.textContent = counts.total;
  stats.teamsNote.textContent = counts.total === 1 ? "Team submitted" : "Teams submitted";
  stats.players.textContent = counts.players;
  stats.PENDING.textContent = counts.PENDING || 0;
  stats.APPROVED.textContent = counts.APPROVED || 0;
  stats.WAITLISTED.textContent = counts.WAITLISTED || 0;
  stats.REJECTED.textContent = counts.REJECTED || 0;
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
      state.total === 0 && !state.query && state.status === "ALL" && !state.department
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

  const leader = (record.players || [])[0] || {};
  drawerContactHint.textContent = leader.whatsapp
    ? "Copy a message and send it from your own WhatsApp to " + leader.name + " (+" + leader.whatsapp + ")."
    : "No WhatsApp number is stored for this team, so there is nothing to message.";
  copyMessageBtn.disabled = !leader.whatsapp;
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

async function changeStatus(nextStatus) {
  const record = findRecord(state.openId);
  if (!record) return;
  if (STATUSES.indexOf(nextStatus) === -1) {
    toast("That is not a valid status.", "error");
    return;
  }
  if (record.status === nextStatus) return;

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
    fillDrawer(result.record);
    renderRowsOnly();
    toast(record.teamName + " is now " + result.record.status + ".", "ok");
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

statusButtons.forEach((button) => {
  button.addEventListener("click", () => changeStatus(button.dataset.setStatus));
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
  const leader = (record.players || [])[0];
  if (!leader) return;

  const lines = [
    "QQSGP Free Fire Championship — " + record.teamName,
    "",
    "Hi " + leader.name + ", this is the tournament organising team.",
    "Your squad (" + record.playerCount + " players) is currently " + record.status + ".",
    "",
    "Please make sure every player is ready at the reporting time and shares the same in-game names as registered."
  ];

  const message = lines.join("\n");

  try {
    await navigator.clipboard.writeText(message);
    toast("Message copied. Paste it into WhatsApp and send it yourself.", "ok");
  } catch (ignored) {
    toast("This browser blocked the clipboard. The message starts: " + lines[2], "error");
  }
});

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
  if (!document.hidden && state.key) load({ silent: true });
});

/* ------------------------------- startup ----------------------------- */

(function start() {
  statusChips.forEach((chip) => chip.setAttribute("aria-pressed", chip.classList.contains("is-active") ? "true" : "false"));

  const stored = loadStoredKey();
  if (stored && stored.length >= 20) {
    gateKey.value = stored;
    gateRemember.checked = true;
    openDashboard(stored, true);
  } else {
    gateKey.focus();
  }
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
