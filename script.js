/*
  IMPORTANT:
  Paste your deployed Google Apps Script Web App URL below.
  Get this from: Apps Script > Deploy > Manage deployments > Web app URL
*/
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw_-E7L9mE7xGk_Fypf6tnTvAbG4wZu9idrycpawkakihtgKndDMknDLdZnt333T3y-/exec";

const form = document.getElementById("registrationForm");
const submitBtn = document.getElementById("submitBtn");
const success = document.getElementById("success");
const newRegistration = document.getElementById("newRegistration");

const successModal = document.getElementById("successModal");
const successTeamName = document.getElementById("successTeamName");
const regLabel = document.getElementById("regLabel");
const doneSuccess = document.getElementById("doneSuccess");
const closeSuccess = document.getElementById("closeSuccess");

// Entry-fee step inside the same dialog.
const payBlock = document.getElementById("payBlock");
const payAmount = document.getElementById("payAmount");
const payChoice = document.getElementById("payChoice");
const payOnlineBtn = document.getElementById("payOnlineBtn");
const payCashBtn = document.getElementById("payCashBtn");
const payOnlinePanel = document.getElementById("payOnlinePanel");
const payCashPanel = document.getElementById("payCashPanel");
const payQr = document.getElementById("payQr");
const payGateway = document.getElementById("payGateway");
const payFrame = document.getElementById("payFrame");
const payGatewayLink = document.getElementById("payGatewayLink");
const payGatewayOpen = document.getElementById("payGatewayOpen");
const payOnlineHint = document.getElementById("payOnlineHint");
const payStatus = document.getElementById("payStatus");
const payRetryBtn = document.getElementById("payRetry");
const payOnlineBack = document.getElementById("payOnlineBack");
const payCashSubmit = document.getElementById("payCashSubmit");
const payCashAmount = document.getElementById("payCashAmount");
const payCashBack = document.getElementById("payCashBack");
const payResult = document.getElementById("payResult");

const departmentDropdown = document.getElementById("departmentDropdown");
const departmentTrigger = document.getElementById("departmentTrigger");
const departmentMenu = document.getElementById("departmentMenu");
const departmentValue = document.getElementById("departmentValue");
const departmentInput = document.getElementById("department");

const statsSection = document.getElementById("stats");
const statTeams = document.getElementById("statTeams");
const statPlayers = document.getElementById("statPlayers");
const statTeamsNote = document.getElementById("statTeamsNote");

const regStatusBox = document.getElementById("regStatusBox");
const regStatus = document.getElementById("regStatus");
const regStatusNote = document.getElementById("regStatusNote");


/* ------------------------------------------------------------------
   LIVE REGISTRATION COUNTER
   Reads { ok, teams, players, departments, generatedAt } from the
   Apps Script doGet(?action=stats) endpoint. If the backend is an
   older deployment that has no stats endpoint, the numbers stay as
   dashes instead of showing a broken value.
------------------------------------------------------------------ */
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const STAT_TEAMS_NOTE = statTeamsNote ? statTeamsNote.textContent : "";

function countUp(el, target) {
  const from = Number(el.dataset.value || 0);
  el.dataset.value = String(target);

  if (REDUCED_MOTION || from === target) {
    el.textContent = String(target);
    return;
  }

  // A short pulse on the figure itself, not on its container, so the number
  // reads as having just changed without the whole strip twitching.
  el.classList.remove("is-bumping");
  void el.offsetWidth;
  el.classList.add("is-bumping");

  const duration = 650;
  const start = performance.now();

  function frame(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = String(Math.round(from + (target - from) * eased));
    if (progress < 1) requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

/* The strip rises into place the first time it scrolls into view. The hiding
   rule is only switched on here, after the observer exists, so a failure in
   this block can never leave the live numbers permanently invisible. */
if (statsSection) {
  if (!REDUCED_MOTION && "IntersectionObserver" in window) {
    const statsReveal = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        statsReveal.unobserve(entry.target);
      });
    }, { threshold: 0.25 });

    statsSection.classList.add("is-animatable");
    statsReveal.observe(statsSection);
  } else {
    statsSection.classList.add("is-visible");
  }
}

function renderStats(data) {
  statsSection.classList.remove("is-offline");
  countUp(statTeams, data.teams);
  countUp(statPlayers, data.players);

  if (statTeamsNote) {
    const hasCapacity = typeof data.capacity === "number" && data.capacity > 0 &&
                        typeof data.slotsLeft === "number";
    statTeamsNote.textContent = hasCapacity
      ? data.slotsLeft + " slot" + (data.slotsLeft === 1 ? "" : "s") + " left of " + data.capacity
      : STAT_TEAMS_NOTE;
  }

  renderRegStatus(data);
}

/*
  Open / closed is read from the backend, never invented: the stats endpoint
  reports capacity and slotsLeft, and a capacity of 0 means the organisers have
  not set a limit at all (the form still accepts entries). If the numbers are
  missing the strip stays silent rather than promising a status.
*/
function renderRegStatus(data) {
  if (!regStatusBox || !regStatus) return;

  const capacity = typeof data.capacity === "number" ? data.capacity : null;
  const slotsLeft = typeof data.slotsLeft === "number" ? data.slotsLeft : null;
  if (capacity === null) return;

  const open = capacity === 0 || (slotsLeft !== null && slotsLeft > 0);

  regStatus.classList.toggle("is-open", open);
  regStatus.classList.toggle("is-closed", !open);
  regStatus.innerHTML = "<i aria-hidden=\"true\"></i>" +
    (open ? "Registration open" : "Registration closed");

  if (regStatusNote) {
    if (!open) regStatusNote.textContent = "All slots are taken";
    else if (capacity > 0 && slotsLeft !== null) {
      regStatusNote.textContent = slotsLeft + " of " + capacity + " slots left";
    } else regStatusNote.textContent = "No team limit set";
  }

  regStatusBox.hidden = false;
}

function markStatsOffline() {
  statsSection.classList.add("is-offline");
  [statTeams, statPlayers].forEach(el => {
    el.textContent = "—";
    el.dataset.value = "0";
  });
  if (statTeamsNote) statTeamsNote.textContent = "Updates automatically";
  // No answer from the server means no open/closed claim on the hero either.
  if (regStatusBox) regStatusBox.hidden = true;
}

/* Apps Script pays a cold-start cost on the first request after a deploy, and a
   cold start can run well past any sane timeout. A single slow load used to
   leave the board showing dashes until someone manually refreshed, so the call
   now retries a couple of times before giving up. */
const STATS_TIMEOUT_MS = 20000;
const STATS_MAX_ATTEMPTS = 3;

async function loadStats(attempt = 1) {
  if (!statsSection) return;

  if (APPS_SCRIPT_URL.includes("PASTE_YOUR")) {
    markStatsOffline();
    return;
  }

  const url = APPS_SCRIPT_URL + (APPS_SCRIPT_URL.includes("?") ? "&" : "?") + "action=stats";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATS_TIMEOUT_MS);

  try {
    const response = await fetch(url, { method: "GET", cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("Server returned status " + response.status);

    const data = JSON.parse(await response.text());
    if (!data || data.ok !== true || typeof data.teams !== "number") {
      throw new Error("Stats endpoint not available yet");
    }

    renderStats(data);
  } catch (error) {
    if (attempt < STATS_MAX_ATTEMPTS) {
      // Leave the last known-good numbers in place while we try again.
      setTimeout(() => loadStats(attempt + 1), 1500 * attempt);
      return;
    }
    markStatsOffline();
    console.warn("Live counter unavailable:", error.message);
  } finally {
    clearTimeout(timer);
  }
}

loadStats();

/* The board says "live from the tournament sheet", so it has to keep looking.
   The server caches counters for 20 seconds and a registration clears that
   cache, but a page already open on someone's phone never asked again — it
   sat on the numbers from whenever they loaded it. Polling here means a new
   team appears on its own, without anyone thinking to refresh.
   Hidden tabs stop polling, so a page left in the background costs nothing. */
const STATS_REFRESH_MS = 20000;
let statsRefreshInFlight = false;

async function refreshStats() {
  if (statsRefreshInFlight || document.visibilityState === "hidden") return;
  statsRefreshInFlight = true;
  try {
    await loadStats();
  } finally {
    statsRefreshInFlight = false;
  }
}

setInterval(refreshStats, STATS_REFRESH_MS);

// Coming back to the tab should feel instant, not up to 20 seconds stale.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshStats();
});


/* ------------------------------------------------------------------
   RESULT POPUP
   One dialog serves both outcomes, so every success-only string has to be
   put back before it is shown again. Without that, a failure left the
   "Registration Submitted!" heading sitting directly above an error.
------------------------------------------------------------------ */
const modalIcon = document.querySelector(".success-check");
const modalTitle = document.getElementById("successTitle");
const modalDescription = document.querySelector(".success-description");

const SUCCESS_ICON = modalIcon.innerHTML;
const SUCCESS_TITLE = modalTitle.textContent;
const SUCCESS_DESCRIPTION = modalDescription.textContent;

/**
 * The backend states its rules (a duplicate team, closed registration) in plain
 * language meant for the player, so those pass through untouched. An internal
 * fault is not the player's to interpret, and because the row may already have
 * been written before the failure, the wording promises neither outcome.
 */
function playerFacingError(message) {
  const text = String(message == null ? "" : message).trim();
  if (!text) return "The submission could not be completed. Please try again.";
  if (!/^server error/i.test(text)) return text;
  return "Something went wrong on our side, so we could not confirm your entry. " +
         "Please check with the organiser before submitting again.";
}

function openResultPopup() {
  successModal.classList.add("show");
  successModal.setAttribute("aria-hidden", "false");
  // Hold the page still behind the dialog. Without this a phone kept the
  // document scrolled under the overlay and the popup read as "somewhere up
  // there", so people had to scroll back to the top to find it.
  document.documentElement.classList.add("modal-open");
  document.body.classList.add("modal-open");
  // preventScroll: focusing DONE must never move the document sideways or up.
  if (doneSuccess && doneSuccess.focus) doneSuccess.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------
   ENTRY FEE — one live fee, two honest outcomes

   Cash    -> the row is saved as PENDING; an organiser confirms receipt.
   Online  -> the page opens a provider order and shows its UPI QR. Nothing
              is registered until the provider confirms, server to server,
              that the exact fee was captured. There is no "I have paid"
              button, and a typed reference proves nothing.

   The fee itself comes from the sheet (action=config), never from a constant
   in this file, so the page and the backend cannot disagree about it.
------------------------------------------------------------------ */
const pending = { data: null, busy: false, done: false };

const PAY_POLL_MS = 3000;
const PAY_MAX_POLLS = 400;
let payPoller = null;
let paySession = null;      // { token, expiresAt } of the payment being watched
let payPollCount = 0;
let siteConfig = {
  fee: null,
  online: false,
  provider: "",
  hosted: false,
  label: "",
  minVerification: 0
};

/**
 * Nothing about a previous attempt may survive on the payment panel: no stale
 * QR, and no gateway checkout page still loading behind a new one. The iframe
 * is emptied rather than hidden, so a cancelled attempt really stops.
 */
function resetOnlineVisuals() {
  if (payQr) {
    payQr.hidden = true;
    payQr.removeAttribute("src");
  }
  if (payGateway) payGateway.hidden = true;
  if (payFrame) payFrame.removeAttribute("src");
  if (payGatewayLink) payGatewayLink.hidden = true;
  if (payGatewayOpen) payGatewayOpen.hidden = true;
}

/**
 * The gateway's checkout page is shown as the gateway serves it. On a narrow
 * screen the modal would squeeze it into a column a few characters wide, so
 * the stylesheet swaps the frame for a full-width button and the page keeps
 * polling; the payment still happens entirely on the gateway's own page.
 */
function showHostedCheckout(url) {
  if (!payGateway) return false;
  payGateway.hidden = false;
  if (payGatewayLink) {
    payGatewayLink.hidden = false;
    payGatewayLink.href = url;
  }
  if (payGatewayOpen) {
    payGatewayOpen.hidden = false;
    payGatewayOpen.href = url;
  }
  if (payFrame) payFrame.src = url;
  return true;
}

function payPanel(name) {
  payChoice.hidden = name !== "choice";
  payOnlinePanel.hidden = name !== "online";
  payCashPanel.hidden = name !== "cash";
}

function paySay(message, kind) {
  if (!payResult) return;
  payResult.hidden = !message;
  payResult.textContent = message || "";
  payResult.classList.remove("is-ok", "is-error");
  if (kind) payResult.classList.add("is-" + kind);
}

/** The line under the QR. It is the only text that may appear there. */
function setPayStatus(message, kind) {
  if (!payStatus) return;
  payStatus.hidden = !message;
  payStatus.textContent = message || "";
  payStatus.classList.remove("is-waiting", "is-error", "is-ok");
  if (kind) payStatus.classList.add("is-" + kind);
}

function applyFee(fee) {
  const value = Number(fee);
  if (!value || value < 1) return;
  siteConfig.fee = value;
  if (payAmount) payAmount.textContent = "₹" + value;
  if (payCashAmount) payCashAmount.textContent = "₹" + value;
}

function stopPolling() {
  if (payPoller) {
    clearInterval(payPoller);
    payPoller = null;
  }
}

function resetPaymentStep() {
  stopPolling();
  paySession = null;
  payPollCount = 0;
  pending.data = null;
  pending.busy = false;
  pending.done = false;
  if (!payBlock) return;
  payBlock.hidden = true;
  payPanel("choice");
  paySay("", "");
  setPayStatus("", "");
  resetOnlineVisuals();
  if (payRetryBtn) payRetryBtn.hidden = true;
}

/**
 * Opens the fee step for a team whose details have passed validation but
 * have NOT been sent anywhere yet. Nothing is registered until the team
 * picks Cash or confirms the UPI payment.
 */
function openPaymentStep(data) {
  if (!payBlock) return;

  pending.data = data;
  pending.busy = false;
  pending.done = false;
  paySession = null;
  payPollCount = 0;
  stopPolling();

  applyFee(siteConfig.fee);
  if (payCashSubmit) {
    payCashSubmit.disabled = false;
    payCashSubmit.textContent = "Submit — I'll pay cash";
  }

  successModal.classList.remove("is-error");
  modalTitle.textContent = "Choose your payment";
  modalDescription.textContent =
    "Your team details are checked. Pay the entry fee to submit the registration.";
  modalIcon.innerHTML = SUCCESS_ICON;
  successTeamName.textContent = data.teamName;

  // Nothing has been saved at this point, so the dialog must not say the team
  // is registered yet, and the close button is a cancel.
  if (regLabel) regLabel.textContent = "YOUR TEAM";
  if (doneSuccess) doneSuccess.innerHTML = 'CANCEL <span aria-hidden="true">×</span>';

  payPanel("choice");
  paySay("", "");
  setPayStatus("", "");
  resetOnlineVisuals();
  if (payRetryBtn) payRetryBtn.hidden = true;
  payBlock.hidden = false;
  openResultPopup();
}

/**
 * CASH ONLY. The online path never posts a registration: the server writes
 * that row itself, after the provider confirms the money. A cash row is saved
 * as PENDING and stays that way until an organiser receives the notes.
 */
async function completeCashRegistration() {
  if (pending.busy || pending.done || !pending.data) return;

  pending.busy = true;
  const button = payCashSubmit;
  const label = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = "Submitting…";
  }
  paySay("", "");

  try {
    const result = await submitToAppsScript(Object.assign({}, pending.data, {
      payment: { method: "CASH" }
    }));

    if (!result || !result.ok) {
      throw new Error(result && result.error
        ? result.error
        : "The server could not save your registration.");
    }

    pending.done = true;
    payPanel("none");

    if (regLabel) regLabel.textContent = "TEAM REGISTERED";
    if (doneSuccess) doneSuccess.innerHTML = 'DONE <span aria-hidden="true">↗</span>';

    modalTitle.textContent = "Registration Submitted!";
    modalDescription.textContent =
      "Your team is registered. The entry fee stays Pending until an organiser receives your cash.";

    const fee = result.payment && result.payment.entryFee
      ? result.payment.entryFee
      : siteConfig.fee;

    paySay(
      "Pay ₹" + (fee || "the entry fee") + " in cash to any tournament organiser. " +
        "Your payment changes to Paid only when they confirm they received it.",
      "ok"
    );

    loadStats();
  } catch (error) {
    // The registration was not saved. Keep the team's details and let them
    // choose again; no success is shown on a failed save.
    paySay("We could not save that just now. " + error.message + " Nothing was lost — try again.", "error");
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  } finally {
    pending.busy = false;
  }
}

/* ------------------------------------------------------------------
   ONLINE PAYMENT
   The page opens an order, shows the QR and then waits. It cannot say
   "paid": only the backend, asking the provider with a secret the browser
   never sees, can turn a QR into a registered team.
------------------------------------------------------------------ */

async function startOnlinePayment() {
  if (!pending.data || pending.done) return;

  payPanel("online");
  paySay("", "");
  stopPolling();
  paySession = null;
  payPollCount = 0;

  resetOnlineVisuals();
  if (payRetryBtn) payRetryBtn.hidden = true;

  if (!siteConfig.online) {
    setPayStatus(
      "Online payment is not switched on yet. Choose Cash — an organiser will collect the fee at the venue.",
      "error"
    );
    return;
  }

  pending.busy = true;
  setPayStatus("Opening your payment…", "waiting");

  try {
    const result = await postAction("payorder", pending.data);
    if (!result || !result.ok) {
      throw new Error(result && result.error ? result.error : "The payment could not be started.");
    }
    paySession = { token: result.token, expiresAt: result.expiresAt || "" };
    if (result.amount) applyFee(result.amount);

    if (result.hosted && result.checkoutUrl) {
      // YouPI PG: the gateway's own checkout page IS the payment interface.
      // Nothing is drawn here, and the team is still not registered.
      showHostedCheckout(result.checkoutUrl);
      setPayStatus(
        "Pay on the secure payment page above. Your team is registered automatically once the gateway confirms the payment.",
        "waiting"
      );
    } else if (result.qrImageUrl) {
      payQr.src = result.qrImageUrl;
      payQr.hidden = false;
      setPayStatus(
        "Scan the QR with any UPI app. Your team is registered automatically once the payment is confirmed.",
        "waiting"
      );
    } else {
      throw new Error("The payment page did not arrive. Please try again.");
    }

    startPaymentPolling();
  } catch (error) {
    paySession = null;
    resetOnlineVisuals();
    setPayStatus(playerFacingError(error.message), "error");
    if (payRetryBtn) payRetryBtn.hidden = false;
  } finally {
    pending.busy = false;
  }
}

function startPaymentPolling() {
  stopPolling();
  payPollCount = 0;
  payPoller = setInterval(checkPayment, PAY_POLL_MS);
  checkPayment();
}

async function checkPayment() {
  if (!paySession || pending.done) {
    stopPolling();
    return;
  }

  payPollCount += 1;
  if (payPollCount > PAY_MAX_POLLS) {
    stopPolling();
    setPayStatus("This payment window has closed. Start again for a fresh QR.", "error");
    if (payRetryBtn) payRetryBtn.hidden = false;
    return;
  }

  try {
    const result = await postAction("paystatus", { token: paySession.token });
    if (!result || !result.ok) return; // a blip: keep waiting, assume nothing

    if (result.state === "PAID") {
      stopPolling();
      finishVerifiedRegistration(result);
      return;
    }

    if (result.state === "EXPIRED") {
      stopPolling();
      setPayStatus("This payment window has closed. Start again for a fresh one.", "error");
      if (payRetryBtn) payRetryBtn.hidden = false;
      return;
    }

    if (result.state === "REVIEW") {
      stopPolling();
      setPayStatus(result.error || "An organiser needs to check this payment.", "error");
      return;
    }

    if (result.state === "CANCELLED") {
      stopPolling();
      paySession = null;
      payPanel("choice");
    }
  } catch (ignored) {
    // Offline for a moment. The next tick asks again; nothing is assumed.
  }
}

function finishVerifiedRegistration(result) {
  paySession = null;
  pending.done = true;
  payPanel("none");

  if (regLabel) regLabel.textContent = "TEAM REGISTERED";
  if (doneSuccess) doneSuccess.innerHTML = 'DONE <span aria-hidden="true">↗</span>';

  successModal.classList.remove("is-error");
  modalIcon.innerHTML = SUCCESS_ICON;
  modalTitle.textContent = "Registered & Paid";
  modalDescription.textContent =
    "The payment was verified by the provider, and your team was saved automatically.";
  if (successTeamName && result.team) successTeamName.textContent = result.team;

  const amount = result.amount ? "₹" + result.amount : "The entry fee";
  paySay(
    amount + " received and verified." +
      (result.registrationId ? " Registration ID: " + result.registrationId + "." : ""),
    "ok"
  );

  loadStats();
}

async function cancelOnlinePayment() {
  const token = paySession && paySession.token;

  stopPolling();
  paySession = null;
  payPollCount = 0;
  resetOnlineVisuals();
  if (payRetryBtn) payRetryBtn.hidden = true;
  setPayStatus("", "");
  payPanel("choice");

  if (token) {
    try {
      await postAction("paycancel", { token: token });
    } catch (ignored) {
      // The QR simply expires on its own; the team is not registered either way.
    }
  }
}

if (payOnlineBtn) payOnlineBtn.addEventListener("click", startOnlinePayment);
if (payCashBtn) payCashBtn.addEventListener("click", () => { payPanel("cash"); paySay("", ""); });
if (payOnlineBack) payOnlineBack.addEventListener("click", cancelOnlinePayment);
if (payCashBack) payCashBack.addEventListener("click", () => payPanel("choice"));
if (payCashSubmit) payCashSubmit.addEventListener("click", completeCashRegistration);
if (payRetryBtn) payRetryBtn.addEventListener("click", startOnlinePayment);

function closeSuccessPopup() {
  // A team that closes before choosing has NOT been registered, so their
  // typing must survive: only a completed registration clears the form.
  const registered = pending.done;

  successModal.classList.remove("show");
  successModal.setAttribute("aria-hidden", "true");
  document.documentElement.classList.remove("modal-open");
  document.body.classList.remove("modal-open");
  resetPaymentStep();
  if (registered) {
    form.reset();
    success.classList.remove("show");
  }
  window.scrollTo({ top: document.querySelector(".form-shell").offsetTop - 20, behavior: "smooth" });
}

doneSuccess.addEventListener("click", closeSuccessPopup);
closeSuccess.addEventListener("click", closeSuccessPopup);

successModal.addEventListener("click", (event) => {
  if (event.target === successModal) {
    closeSuccessPopup();
  }
});


/**
 * One POST to an action on the same Web App URL. text/plain keeps the request
 * a "simple" CORS request, which Apps Script answers without a preflight.
 */
async function postAction(action, payload) {
  const url = APPS_SCRIPT_URL + (APPS_SCRIPT_URL.includes("?") ? "&" : "?") +
    "action=" + encodeURIComponent(action);

  const response = await fetch(url, {
    method: "POST",
    mode: "cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload || {})
  });

  if (!response.ok) {
    throw new Error("Server returned status " + response.status);
  }

  return JSON.parse(await response.text());
}

async function getAction(action) {
  const url = APPS_SCRIPT_URL + (APPS_SCRIPT_URL.includes("?") ? "&" : "?") +
    "action=" + encodeURIComponent(action);
  const response = await fetch(url, { method: "GET", cache: "no-store" });
  if (!response.ok) throw new Error("Server returned status " + response.status);
  return JSON.parse(await response.text());
}

/*
  The fee is whatever the sheet says, and online payment is only offered when
  the provider is actually configured on the server. Until then the page says
  so and Cash still works - it never pretends a payment can be verified.
*/
async function loadConfig() {
  if (APPS_SCRIPT_URL.includes("PASTE_YOUR")) return;

  try {
    const data = await getAction("config");
    if (!data || data.ok !== true) return;
    siteConfig = {
      fee: typeof data.fee === "number" ? data.fee : null,
      online: data.online === true,
      provider: data.provider || "",
      hosted: data.hosted === true,
      label: data.label || "",
      minVerification: Number(data.minVerification) || 0
    };
    applyFee(data.fee);

    // The button says what will actually happen: a QR on this page, or the
    // gateway's own secure checkout page.
    if (payOnlineHint) {
      payOnlineHint.textContent = siteConfig.hosted
        ? (siteConfig.label || "Secure checkout")
        : "UPI QR";
    }
  } catch (error) {
    console.warn("Fee/online configuration unavailable:", error.message);
  }
}

loadConfig();

// Submit via fetch() with text/plain to avoid CORS preflight.
// Google Apps Script accepts this and returns CORS-friendly response.
async function submitToAppsScript(data) {
  const payload = JSON.stringify(data);

  const response = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    mode: "cors",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: payload
  });

  if (!response.ok) {
    throw new Error("Server returned status " + response.status);
  }

  const text = await response.text();
  const result = JSON.parse(text);
  return result;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (APPS_SCRIPT_URL.includes("PASTE_YOUR")) {
    alert("First connect the form to your Google Apps Script Web App URL in script.js.");
    return;
  }

  const teamName = document.getElementById("teamName").value.trim();
  const department = document.getElementById("department").value;

  if (!teamName) {
    alert("Please enter a team name.");
    document.getElementById("teamName").focus();
    return;
  }

  if (!department) {
    alert("Please select your department.");
    departmentDropdown.classList.add("is-invalid");
    departmentTrigger.focus();
    return;
  }

  const names = [...document.querySelectorAll(".member-name")];
  const phones = [...document.querySelectorAll(".member-phone")];

  if (names.length !== 4) {
    alert("Form structure error: expected 4 player name fields.");
    return;
  }
  if (phones.length !== 2) {
    alert("Form structure error: expected 2 phone fields.");
    return;
  }

  // A squad may register short-handed. Only the first two players are required,
  // but names must run from the top downwards, with no gaps in between.
  // The gap is reported before the count: leaving the first name blank while a
  // later one is filled should say which name is missing, not just "too few".
  const typedNames = names.map(input => input.value.trim());
  const playerCount = typedNames.filter(Boolean).length;

  for (let i = 0; i < typedNames.length; i++) {
    if (!typedNames[i] && typedNames.slice(i + 1).some(Boolean)) {
      alert(`Please fill Player ${i + 1}'s name before Player ${i + 2}.`);
      names[i].focus();
      return;
    }
  }

  if (playerCount < 2) {
    alert("Enter at least 2 players.");
    names[0].focus();
    return;
  }

  const members = typedNames.slice(0, playerCount).map((name, index) => ({
    player: index + 1,
    name,
    whatsapp: index < 2 ? phones[index].value.trim() : ""
  }));

  const badPhone = members.slice(0, 2).find(m => !/^\d{10}$/.test(m.whatsapp));

  if (badPhone) {
    alert(`Please enter a valid 10-digit WhatsApp number for Player ${badPhone.player}.`);
    phones[badPhone.player - 1]?.focus();
    return;
  }

  // One shared number means the organisers can only reach one of the two.
  if (members[0].whatsapp === members[1].whatsapp) {
    alert("Player 1 and Player 2 cannot use the same WhatsApp number.");
    phones[1].focus();
    return;
  }

  // The confirmation tick used to be enforced by the browser's own "required"
  // bubble — the one message on this form whose wording we do not control. The
  // rule lives here now, so it still gates the submission and reads properly.
  const consent = document.getElementById("confirm");
  if (consent && !consent.checked) {
    alert("Please tick the confirmation box to confirm your team details are correct.");
    consent.focus();
    return;
  }

  // Optional WhatsApp opt-in. Only a ticked box counts, and the server stores
  // the value with a timestamp so an organiser can prove when it was given.
  const consentBox = document.getElementById("whatsappConsent");
  const whatsappConsent = !!(consentBox && consentBox.checked);

  const data = {
    submittedAt: new Date().toISOString(),
    teamName,
    department,
    confirmed: true,
    leaderName: members[0].name,
    leaderWhatsApp: members[0].whatsapp,
    whatsappConsent,
    consentAt: whatsappConsent ? new Date().toISOString() : "",
    members
  };

  // The fee step comes first. The registration is only sent to the server
  // once the team confirms online payment or chooses cash.
  openPaymentStep(data);
});

function cleanPhone(value) {
  return value.replace(/\D/g, "").slice(0, 10);
}

document.querySelectorAll(".member-phone").forEach(input => {
  input.addEventListener("input", () => {
    input.value = cleanPhone(input.value);
  });
});

/* ------------------------------------------------------------------
   DEPARTMENT DROPDOWN
   A custom listbox replaces the native <select>, whose popup menu
   cannot be styled. The chosen value is written into the hidden
   #department input, so the rest of the form is unchanged.
------------------------------------------------------------------ */
const departmentOptions = departmentMenu
  ? [...departmentMenu.querySelectorAll('[role="option"]')]
  : [];
const DEPARTMENT_PLACEHOLDER = departmentValue.textContent;
let activeOptionIndex = -1;

function openDepartmentMenu() {
  departmentDropdown.classList.add("is-open");
  departmentTrigger.setAttribute("aria-expanded", "true");
}

function closeDepartmentMenu() {
  departmentDropdown.classList.remove("is-open");
  departmentTrigger.setAttribute("aria-expanded", "false");
  departmentTrigger.removeAttribute("aria-activedescendant");
  departmentOptions.forEach(option => option.classList.remove("is-active"));
  activeOptionIndex = -1;
}

function highlightOption(index) {
  if (!departmentOptions.length) return;

  if (index < 0) index = departmentOptions.length - 1;
  if (index >= departmentOptions.length) index = 0;

  departmentOptions.forEach(option => option.classList.remove("is-active"));

  activeOptionIndex = index;
  const option = departmentOptions[index];
  option.classList.add("is-active");
  departmentTrigger.setAttribute("aria-activedescendant", option.id);
  option.scrollIntoView({ block: "nearest" });
}

function chooseDepartment(option) {
  departmentInput.value = option.dataset.value;
  departmentValue.textContent = option.textContent.trim();
  departmentValue.classList.remove("placeholder");
  departmentDropdown.classList.remove("is-invalid");

  departmentOptions.forEach(item => {
    item.setAttribute("aria-selected", item === option ? "true" : "false");
  });

  closeDepartmentMenu();
  departmentTrigger.focus();
}

function resetDepartmentDropdown() {
  departmentInput.value = "";
  departmentValue.textContent = DEPARTMENT_PLACEHOLDER;
  departmentValue.classList.add("placeholder");
  departmentOptions.forEach(option => option.setAttribute("aria-selected", "false"));
  closeDepartmentMenu();
  departmentDropdown.classList.remove("is-invalid");
}

if (departmentDropdown && departmentTrigger && departmentMenu) {
  departmentOptions.forEach((option, index) => {
    option.id = "departmentOption" + index;
    option.setAttribute("aria-selected", "false");

    // Stop the mousedown from moving focus, otherwise the trigger blurs and
    // the blur guard closes the menu before this option's click can be handled.
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => chooseDepartment(option));
    option.addEventListener("mousemove", () => {
      if (activeOptionIndex !== index) highlightOption(index);
    });
  });

  departmentTrigger.addEventListener("click", () => {
    if (departmentDropdown.classList.contains("is-open")) closeDepartmentMenu();
    else openDepartmentMenu();
  });

  departmentTrigger.addEventListener("keydown", (event) => {
    const isOpen = departmentDropdown.classList.contains("is-open");

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (isOpen && activeOptionIndex > -1) chooseDepartment(departmentOptions[activeOptionIndex]);
      else if (isOpen) closeDepartmentMenu();
      else openDepartmentMenu();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) {
        openDepartmentMenu();
        highlightOption(event.key === "ArrowDown" ? 0 : departmentOptions.length - 1);
        return;
      }
      highlightOption(activeOptionIndex + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }

    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      closeDepartmentMenu();
    }
  });

  // Close on outside click, and on Tab away.
  document.addEventListener("click", (event) => {
    if (!departmentDropdown.contains(event.target)) closeDepartmentMenu();
  });
  departmentTrigger.addEventListener("blur", () => {
    setTimeout(() => {
      if (!departmentDropdown.contains(document.activeElement)) closeDepartmentMenu();
    }, 150);
  });

  form.addEventListener("reset", resetDepartmentDropdown);
}

newRegistration.addEventListener("click", () => {
  form.reset();
  success.classList.remove("show");
  window.scrollTo({ top: document.querySelector(".form-shell").offsetTop - 20, behavior: "smooth" });
});
