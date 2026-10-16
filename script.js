/*
  IMPORTANT:
  Paste your deployed Google Apps Script Web App URL below.
  Get this from: Apps Script > Deploy > Manage deployments > Web app URL
*/
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxqAaaPFNI-w54JFWzJby1ToNH1IpBjW2l-xocXBxIH0KcPGg2kyoM9BIQJ6PkiKEUi/exec";

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

async function loadStats() {
  if (!statsSection) return;

  if (APPS_SCRIPT_URL.includes("PASTE_YOUR")) {
    markStatsOffline();
    return;
  }

  const url = APPS_SCRIPT_URL + (APPS_SCRIPT_URL.includes("?") ? "&" : "?") + "action=stats";
  const controller = new AbortController();
  // Apps Script can be slow on a cold start, so allow a generous window.
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, { method: "GET", cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("Server returned status " + response.status);

    const data = JSON.parse(await response.text());
    if (!data || data.ok !== true || typeof data.teams !== "number") {
      throw new Error("Stats endpoint not available yet");
    }

    renderStats(data);
  } catch (error) {
    markStatsOffline();
    console.warn("Live counter unavailable:", error.message);
  } finally {
    clearTimeout(timer);
  }
}

loadStats();


function showSuccessPopup(teamName) {
  successTeamName.textContent = teamName;
  successModal.classList.add("show");
  successModal.setAttribute("aria-hidden", "false");
  doneSuccess.focus();
}

function showErrorPopup(message) {
  successTeamName.textContent = "Submission Error";
  document.querySelector(".success-description").textContent = message;
  document.querySelector(".success-check").innerHTML =
    '<svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="20" fill="none" stroke="#ff6b6b" stroke-width="3"/><line x1="20" y1="26" x2="32" y2="26" stroke="#ff6b6b" stroke-width="3" stroke-linecap="round"/><line x1="26" y1="20" x2="26" y2="32" stroke="#ff6b6b" stroke-width="3" stroke-linecap="round"/></svg>';
  successModal.classList.add("show");
  successModal.setAttribute("aria-hidden", "false");
  doneSuccess.focus();
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

  const members = names.map((nameInput, index) => ({
    player: index + 1,
    name: nameInput.value.trim(),
    whatsapp: index < 2 ? phones[index].value.trim() : ""
  }));

  const missingName = members.some(m => !m.name);
  const invalidPhone = members.slice(0, 2).some(m => !/^\d{10}$/.test(m.whatsapp));

  if (missingName) {
    alert("Please enter a name for every player.");
    return;
  }

  if (invalidPhone) {
    const badPlayer = members.slice(0, 2).find(m => !/^\d{10}$/.test(m.whatsapp));
    alert(`Please enter a valid 10-digit WhatsApp number for Player ${badPlayer.player}.`);
    const phoneFields = document.querySelectorAll(".member-phone");
    phoneFields[badPlayer.player - 1]?.focus();
    return;
  }

  const data = {
    submittedAt: new Date().toISOString(),
    teamName,
    department,
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
