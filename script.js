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
    document.getElementById("department").focus();
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

newRegistration.addEventListener("click", () => {
  form.reset();
  success.classList.remove("show");
  window.scrollTo({ top: document.querySelector(".form-shell").offsetTop - 20, behavior: "smooth" });
});
