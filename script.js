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
const doneSuccess = document.getElementById("doneSuccess");
const closeSuccess = document.getElementById("closeSuccess");

const departmentDropdown = document.getElementById("departmentDropdown");
const departmentTrigger = document.getElementById("departmentTrigger");
const departmentMenu = document.getElementById("departmentMenu");
const departmentValue = document.getElementById("departmentValue");
const departmentInput = document.getElementById("department");

const statsSection = document.getElementById("stats");
const statTeams = document.getElementById("statTeams");
const statPlayers = document.getElementById("statPlayers");
const statTeamsNote = document.getElementById("statTeamsNote");


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
}

function markStatsOffline() {
  statsSection.classList.add("is-offline");
  [statTeams, statPlayers].forEach(el => {
    el.textContent = "—";
    el.dataset.value = "0";
  });
  if (statTeamsNote) statTeamsNote.textContent = "Updates automatically";
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

const ERROR_ICON =
  '<svg viewBox="0 0 52 52" aria-hidden="true">' +
  '<circle cx="26" cy="26" r="20" fill="none" stroke-width="4"></circle>' +
  '<line x1="19" y1="26" x2="33" y2="26" stroke-width="4" stroke-linecap="round"></line>' +
  '</svg>';

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
  doneSuccess.focus();
}

function showSuccessPopup(teamName) {
  successModal.classList.remove("is-error");
  modalTitle.textContent = SUCCESS_TITLE;
  modalDescription.textContent = SUCCESS_DESCRIPTION;
  modalIcon.innerHTML = SUCCESS_ICON;
  successTeamName.textContent = teamName;
  openResultPopup();
}

function showErrorPopup(message) {
  successModal.classList.add("is-error");
  modalTitle.textContent = "Submission Failed";
  modalDescription.textContent = playerFacingError(message);
  modalIcon.innerHTML = ERROR_ICON;
  // Keep the raw server wording for debugging without showing it to a player.
  console.error("Submission failed:", message);
  openResultPopup();
}

function closeSuccessPopup() {
  successModal.classList.remove("show");
  successModal.setAttribute("aria-hidden", "true");
  form.reset();
  success.classList.remove("show");
  window.scrollTo({ top: document.querySelector(".form-shell").offsetTop - 20, behavior: "smooth" });
}

doneSuccess.addEventListener("click", closeSuccessPopup);
closeSuccess.addEventListener("click", closeSuccessPopup);

successModal.addEventListener("click", (event) => {
  if (event.target === successModal) {
    closeSuccessPopup();
  }
});


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

  const data = {
    submittedAt: new Date().toISOString(),
    teamName,
    department,
    confirmed: true,
    leaderName: members[0].name,
    leaderWhatsApp: members[0].whatsapp,
    members
  };

  submitBtn.disabled = true;
  submitBtn.querySelector("span").textContent = "SUBMITTING...";

  try {
    const result = await submitToAppsScript(data);
    if (result && result.ok) {
      showSuccessPopup(teamName);
      loadStats();
    } else {
      showErrorPopup(result && result.error ? result.error : "Server rejected the submission. Check the Apps Script Executions tab for details.");
    }
  } catch (e) {
    showErrorPopup("Network error: " + e.message + ". Check the console and Apps Script Executions tab.");
    console.error("Submit error:", e);
  } finally {
    submitBtn.disabled = false;
    submitBtn.querySelector("span").textContent = "SUBMIT TEAM";
  }
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
