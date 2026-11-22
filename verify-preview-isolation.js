#!/usr/bin/env node
/*
  Proves that the local preview harness is isolated from production.

  It checks, in order:
    - the harness binds to loopback and has no outbound HTTP client
    - the served test pages point at /__mock/exec, never script.google.com
    - a full mock payment marks a row PAID only in the in-memory mock
    - a direct client claim of ONLINE/PAID is refused
    - an unknown mock token writes nothing

  It does not contact Google, does not read a Sheet and does not use a secret.
  Exit code 0 means every check passed.
*/
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const HARNESS = path.join(ROOT, ".preview-server.js");
const PORT = 8790 + Math.floor(Math.random() * 80);
const BASE = "http://127.0.0.1:" + PORT;

let passed = 0;
let failed = 0;

function check(condition, message, detail) {
  if (condition) {
    passed++;
    console.log("PASS  " + message);
  } else {
    failed++;
    console.log("FAIL  " + message + (detail ? " — " + detail : ""));
  }
}

async function get(pathname) {
  const response = await fetch(BASE + pathname, {
    signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, text: await response.text() };
}

async function post(pathname, body) {
  const response = await fetch(BASE + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (ignored) {
    json = null;
  }
  return { status: response.status, body: json, text };
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const result = await get("/__mock/exec?action=config");
      if (result.status === 200 && result.text.includes('"provider"')) return true;
    } catch (ignored) {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function main() {
  check(fs.existsSync(HARNESS), "the preview harness exists");

  const source = fs.readFileSync(HARNESS, "utf8");
  check(/server\.listen\(PORT,\s*"127\.0\.0\.1"/.test(source),
    "the harness binds to 127.0.0.1 only");
  check(!/require\(\s*["'](?:node:)?https["']\s*\)/.test(source),
    "the harness does not import an HTTPS client");
  check(!/require\(\s*["'](?:node:)?http2["']\s*\)/.test(source),
    "the harness does not import HTTP/2");
  const fetchJsonBlock = (source.match(/async function fetchJson\([\s\S]*?\n}\n/) || [""])[0];
  check(Boolean(fetchJsonBlock) && !/method\s*:/.test(fetchJsonBlock),
    "the staging status checker uses GET only (no method override)");
  check(!/fetch\(\s*["'`]https?:/i.test(source),
    "no hardcoded external fetch target exists in the harness");

  const keyMatch = source.match(/const MOCK_KEY = "([^"]+)"/);
  check(Boolean(keyMatch), "the harness exposes a local-only mock key");

  const child = spawn(process.execPath, [HARNESS, ROOT, String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let harnessLog = "";
  child.stdout.on("data", (chunk) => { harnessLog += chunk.toString(); });
  child.stderr.on("data", (chunk) => { harnessLog += chunk.toString(); });

  try {
    const ready = await waitForServer();
    check(ready, "the harness answers on loopback", harnessLog.trim().slice(-200));
    if (!ready) return;

    const testScript = await get("/__test/script.js");
    check(testScript.status === 200, "the test copy of script.js is served");
    check(testScript.text.includes("http://127.0.0.1:" + PORT + "/__mock/exec"),
      "the test page talks to the local mock backend");
    check(!/script\.google\.com/.test(testScript.text),
      "the test copy contains no production backend URL");

    const testAdmin = await get("/__test/admin.js");
    check(testAdmin.status === 200 && testAdmin.text.includes("/__mock/exec"),
      "the test dashboard also talks to the local mock backend");
    check(!/script\.google\.com/.test(testAdmin.text),
      "the test dashboard contains no production backend URL");

    const testPage = await get("/__test/index.html");
    check(testPage.status === 200 && !/TEST MODE/i.test(testPage.text),
      "the test page carries no floating TEST MODE pill");
    const testPageLogin = await get("/__test/admin.html");
    check(testPageLogin.status === 200 && /Local login:/i.test(testPageLogin.text),
      "the test dashboard still shows the local login marker");

    const order = await post("/__mock/exec?action=payorder", {
      teamName: "Isolation Test",
      department: "CSE — Computer Science Engineering",
      members: [
        { name: "Iso One", whatsapp: "9000000001" },
        { name: "Iso Two", whatsapp: "9000000002" }
      ],
      whatsappConsent: false
    });
    check(order.body && order.body.ok === true && Boolean(order.body.token),
      "the mock can open an online payment draft");

    const token = order.body && order.body.token;

    const paid = await post("/__mock/pay", { token: token });
    check(paid.body && paid.body.state === "PAID",
      "the mock gateway can confirm the draft");

    const status = await post("/__mock/exec?action=paystatus", { token: token });
    check(status.body && status.body.state === "PAID",
      "the page can read the confirmed state back");

    const list = await post("/__mock/exec?action=admin", {
      action: "list",
      key: keyMatch ? keyMatch[1] : "",
      page: 1,
      pageSize: 50
    });
    const records = (list.body && list.body.records) || [];
    const row = records.find((record) => record.teamName === "Isolation Test");
    check(Boolean(row), "the mock row exists only in the mock dashboard");
    check(Boolean(row) && row.payment && row.payment.method === "ONLINE" &&
      row.payment.status === "PAID" && row.payment.provider === "YOUPI",
      "the mock row is ONLINE / PAID / YOUPI");
    check((list.body && list.body.counts && list.body.counts.paidTeams) >= 1,
      "the mock counters include the mock payment");

    const sneaky = await post("/__mock/exec", {
      teamName: "Sneaky Online",
      department: "CSE — Computer Science Engineering",
      members: [
        { name: "Sneaky One", whatsapp: "9000000003" },
        { name: "Sneaky Two", whatsapp: "9000000004" }
      ],
      payment: { method: "ONLINE", status: "PAID" }
    });
    check(sneaky.body && sneaky.body.ok === false,
      "a direct ONLINE/PAID claim is refused");

    const afterSneaky = await post("/__mock/exec?action=admin", {
      action: "list",
      key: keyMatch ? keyMatch[1] : "",
      q: "Sneaky Online",
      page: 1,
      pageSize: 50
    });
    const sneakyRows = (afterSneaky.body && afterSneaky.body.records) || [];
    check(!sneakyRows.some((record) => record.teamName === "Sneaky Online"),
      "the refused claim created no row");

    const badToken = await post("/__mock/pay", { token: "not-a-real-token" });
    check(badToken.status === 404 && badToken.body && badToken.body.ok === false,
      "an unknown mock token is refused and writes nothing");
  } finally {
    child.kill();
  }

  console.log("");
  console.log(passed + " passed, " + failed + " failed.");
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("FAIL  " + error.message);
  process.exitCode = 1;
});
