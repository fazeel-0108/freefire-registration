#!/usr/bin/env node
/*
  Read-only check for a STAGING Apps Script deployment.

  Usage:
    node staging/check-staging.js https://script.google.com/macros/s/<id>/exec

  It only performs GET requests for ?action=config and ?action=stats. It never
  sends credentials, never posts, and never touches the staging Sheet's rows.
  It refuses to run against the production deployment used by script.js.
*/
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TIMEOUT_MS = 30000;

let passed = 0;
let failed = 0;
let warned = 0;

function pass(message) {
  passed++;
  console.log("PASS  " + message);
}

function fail(message) {
  failed++;
  console.log("FAIL  " + message);
}

function warn(message) {
  warned++;
  console.log("WARN  " + message);
}

function productionUrl() {
  try {
    const source = fs.readFileSync(path.join(ROOT, "script.js"), "utf8");
    const match = source.match(/const APPS_SCRIPT_URL\s*=\s*"([^"]+)"/);
    return match ? match[1] : "";
  } catch (ignored) {
    return "";
  }
}

async function getJson(url) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (ignored) {
    body = null;
  }
  return { status: response.status, body, text };
}

async function main() {
  const raw = String(process.argv[2] || "").trim();
  if (!raw) {
    console.log("Usage: node staging/check-staging.js <staging /exec URL>");
    process.exitCode = 2;
    return;
  }

  let url;
  try {
    url = new URL(raw);
  } catch (ignored) {
    fail("That is not a valid URL.");
    process.exitCode = 1;
    return;
  }

  if (url.protocol !== "https:" || url.hostname !== "script.google.com") {
    fail("Expected an https://script.google.com/macros/s/.../exec URL.");
  }
  if (!/\/exec\/?$/.test(url.pathname)) {
    fail("The URL must end in /exec (a web app deployment, not the editor).");
  }
  if (failed > 0) {
    process.exitCode = 1;
    return;
  }

  const production = productionUrl();
  if (production && raw.replace(/\/+$/, "") === production.replace(/\/+$/, "")) {
    fail("That is the PRODUCTION deployment used by script.js. Refusing to check it as staging.");
  } else if (production) {
    pass("This URL is not the production deployment in script.js.");
  } else {
    warn("Could not read the production URL from script.js.");
  }

  if (failed > 0) {
    process.exitCode = 1;
    return;
  }

  const base = raw.replace(/\?.*$/, "").replace(/\/+$/, "");

  let config;
  try {
    config = await getJson(base + "?action=config");
  } catch (error) {
    fail("The staging deployment did not answer: " + error.message);
    process.exitCode = 1;
    return;
  }

  if (config.status === 200 && config.body && config.body.ok === true) {
    pass("The deployment answered ?action=config with ok:true.");
  } else {
    fail("?action=config did not return the expected JSON (HTTP " + config.status + "). " +
      "Check that the deployment is a Web app set to Anyone, not a login page.");
  }

  const data = config.body || {};
  if (data.provider === "YOUPI") {
    pass("provider is YOUPI (the consolidated payment code is deployed).");
  } else {
    warn("provider is " + JSON.stringify(data.provider) + "; expected YOUPI on current code.");
  }

  if (Number(data.fee) > 0) {
    pass("entry fee is a positive number (₹" + Number(data.fee) + ").");
  } else {
    fail("entry fee is missing or invalid.");
  }

  if (data.online === false) {
    pass("online:false — no online payment is offered yet, which is correct before merchant setup.");
  } else if (data.online === true) {
    warn("online:true — this staging deployment is offering online payment. Only expected after a merchant test.");
  } else {
    fail("online is not a boolean; the deployment may be old or broken.");
  }

  if (data.hosted === true) {
    pass("hosted:true — the page expects YouPI's hosted checkout.");
  } else {
    warn("hosted is not true; check that the current apps-script.js was deployed.");
  }

  let stats;
  try {
    stats = await getJson(base + "?action=stats");
  } catch (error) {
    fail("The staging deployment did not answer ?action=stats: " + error.message);
    process.exitCode = 1;
    return;
  }

  if (stats.status === 200 && stats.body && stats.body.ok === true) {
    pass("?action=stats answered ok:true (" + Number(stats.body.teams || 0) + " teams, " +
      Number(stats.body.players || 0) + " players, last entry " +
      (stats.body.lastRegistration || "none") + ").");
    if (Number(stats.body.teams || 0) === 0) {
      pass("The staging Sheet looks empty, as a fresh copy should.");
    } else {
      warn("The staging Sheet already has rows. Confirm they are synthetic test rows.");
    }
  } else {
    fail("?action=stats did not return JSON. If it says 'No spreadsheet found', the sheet_id property is missing.");
  }

  console.log("");
  console.log(passed + " passed, " + failed + " failed, " + warned + " warning(s).");
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("FAIL  " + error.message);
  process.exitCode = 1;
});
