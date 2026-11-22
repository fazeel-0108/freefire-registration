#!/usr/bin/env node
/*
  Builds a pushable STAGING Apps Script folder from the tracked backend.

  What it does:
    - copies ../apps-script.js to staging/build/Code.js
    - copies staging/appsscript.json to staging/build/
    - optionally writes staging/build/.clasp.json when STAGING_SCRIPT_ID is set
    - writes a setup checklist that never contains an ID or a secret

  What it never does:
    - writes to .clasp-push/ (the production clasp folder)
    - touches production Script Properties, deployments or the live site
    - puts a spreadsheet ID or a merchant secret into any file

  The staging project id comes from STAGING_SCRIPT_ID, so nothing private is
  committed. A project id equal to the production one is refused.
*/
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BUILD = path.join(__dirname, "build");
const SOURCE = path.join(ROOT, "apps-script.js");
const MANIFEST = path.join(__dirname, "appsscript.json");
const PRODUCTION_CLASP = path.join(ROOT, ".clasp-push", ".clasp.json");

function fail(message) {
  console.error("FAIL  " + message);
  process.exit(1);
}

function mask(value) {
  if (!value) return "(not set)";
  return value.slice(0, 4) + "..." + value.slice(-4);
}

if (!fs.existsSync(SOURCE)) fail("apps-script.js not found at the repository root.");
if (!fs.existsSync(MANIFEST)) fail("staging/appsscript.json is missing.");

// A Sheet ID baked into the source would follow the code into every copy and
// defeat the per-project sheet_id property. Refuse rather than build that.
const code = fs.readFileSync(SOURCE, "utf8");
if (!/SHEET_ID:\s*(''|"")\s*,/.test(code)) {
  fail("CONFIG.SHEET_ID is not empty in apps-script.js. The Sheet ID must stay in the sheet_id Script Property, never in code.");
}

let productionId = "";
if (fs.existsSync(PRODUCTION_CLASP)) {
  try {
    productionId = String(JSON.parse(fs.readFileSync(PRODUCTION_CLASP, "utf8")).scriptId || "");
  } catch (error) {
    fail("Could not read .clasp-push/.clasp.json: " + error.message);
  }
}

const stagingId = String(process.env.STAGING_SCRIPT_ID || "").trim();

if (stagingId && !/^[A-Za-z0-9_-]{20,}$/.test(stagingId)) {
  fail("STAGING_SCRIPT_ID does not look like an Apps Script project id.");
}
if (stagingId && productionId && stagingId === productionId) {
  fail("STAGING_SCRIPT_ID is the production project id. Refusing to build a folder that could overwrite production.");
}

fs.mkdirSync(BUILD, { recursive: true });
fs.copyFileSync(SOURCE, path.join(BUILD, "Code.js"));
fs.copyFileSync(MANIFEST, path.join(BUILD, "appsscript.json"));

// A tiny staging-only diagnostic. It prints the target Sheet's NAME and row
// count, never its ID, so a wrong binding is visible before any test row is
// written. It is a separate file, so Code.js stays byte-identical to the
// tracked backend.
const stagingCheck = [
  "/* STAGING-ONLY diagnostic. Never add this file to the production project. */",
  "function stagingTarget() {",
  "  var book = openBook_();",
  "  if (!book) {",
  "    throw new Error('No spreadsheet found. Set the sheet_id Script Property to the STAGING Sheet.');",
  "  }",
  "  var name = book.getName();",
  "  var sheet = book.getSheetByName(CONFIG.SHEET_NAME);",
  "  var rows = sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;",
  "  var verdict = /staging|do not take payments/i.test(name) ? 'STAGING' : 'NOT STAGING - STOP';" ,
  "  var result = { verdict: verdict, name: name, registrationRows: rows };",
  "  console.log(JSON.stringify(result));",
  "  return result;",
  "}",
  ""
].join("\n");
fs.writeFileSync(path.join(BUILD, "StagingCheck.gs"), stagingCheck);

const claspPath = path.join(BUILD, ".clasp.json");
if (stagingId) {
  fs.writeFileSync(
    claspPath,
    JSON.stringify({ scriptId: stagingId, rootDir: "." }, null, 2) + "\n"
  );
} else if (fs.existsSync(claspPath)) {
  // A previous run's id must not be reused silently for another project.
  fs.unlinkSync(claspPath);
}

const checklist = [
  "QQSGP STAGING — setup checklist",
  "",
  "Project: " + (stagingId ? mask(stagingId) : "not linked yet (set STAGING_SCRIPT_ID and rerun)"),
  "Production project seen by this build: " + (productionId ? mask(productionId) : "not found locally"),
  "",
  "1. The staging script must be a SEPARATE Apps Script project.",
  "2. In that project: Project Settings -> Script Properties -> add",
  "     sheet_id = <the ID from your STAGING Sheet URL>",
  "   The deployed web app has no active spreadsheet, so this property is required.",
  "3. Do NOT add youpi_base_url / youpi_merchant_id / youpi_merchant_key yet.",
  "   Online payment stays off until the local YouPI instance and merchant are ready.",
  "4. Deploy -> New deployment -> Web app.",
  "     Execute as: Me",
  "     Who has access: Anyone",
  "5. In the editor, run stagingTarget() once. It prints the target Sheet's NAME",
  "   and row count (never its ID). Expected verdict: STAGING, registrationRows: 0.",
  "6. Copy the /exec URL and run:",
  "     node staging/check-staging.js <that URL>",
  "   Expected: reachable, provider YOUPI, online:false, staging stats.",
  "7. Only after that: register one cash team and confirm the row lands in the",
  "   STAGING Sheet, not the production one.",
  "",
  "Never paste the Sheet ID, the merchant key or the admin key into a tracked",
  "file, chat or screenshot.",
  ""
].join("\n");

fs.writeFileSync(path.join(BUILD, "STAGING-SETUP.txt"), checklist);

const files = fs.readdirSync(BUILD).sort().join(", ");
console.log("Staging build ready.");
console.log("  folder : staging/build");
console.log("  files  : " + files);
console.log("  project: " + (stagingId ? mask(stagingId) : "not linked"));
console.log("Next: read staging/build/STAGING-SETUP.txt (no secrets in it).");

if (!stagingId) {
  console.log("Tip: STAGING_SCRIPT_ID=<id> node staging/prepare-staging.js creates .clasp.json for clasp.");
}
if (!productionId) {
  console.log("Warning: .clasp-push/.clasp.json was not readable, so the production-id collision check was skipped.");
}
