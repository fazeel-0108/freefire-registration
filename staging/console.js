/* QQSGP staging console — reads only the local preview server and its mock. */
(function () {
  "use strict";

  var STATUS_URL = "/__test/staging/status";
  var TESTS_URL = "/__test/staging/run-tests";
  var GMAIL_CHECK_URL = "/__test/staging/gmail-check";
  var MOCK_ADMIN = "/__test/staging/mock-admin";

  var state = {
    status: null,
    mockFee: null,
    mockOnline: null,
    token: null,
    team: null,
    cashId: null,
    cashPaid: false,
    onlinePaid: false,
    logLines: ["Waiting for a synthetic run…"]
  };

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function rich(value) {
    return esc(value).replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return String(iso);
    return date.toLocaleString("en-GB", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  }

  function badge(status, label) {
    var text = label || ({ completed: "DONE", pending: "PENDING", blocked: "BLOCKED", failed: "FAILED" }[status] || status);
    return '<span class="chip ' + esc(status) + '">' + esc(text) + "</span>";
  }

  function statusDot(status) {
    return '<i class="status-dot ' + esc(status) + '" aria-hidden="true"></i>';
  }

  function toast(message) {
    var node = $("toast");
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { node.hidden = true; }, 4500);
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle("is-busy", busy);
  }

  async function readJson(url, options) {
    var response = await fetch(url, Object.assign({ cache: "no-store" }, options || {}));
    var text = await response.text();
    var data;
    try { data = JSON.parse(text); } catch (ignored) { data = { ok: false, error: text.slice(0, 240) }; }
    if (!response.ok && data && data.ok !== false) data.ok = false;
    return { response: response, data: data };
  }

  async function loadStatus(showToast) {
    setBusy($("refreshBtn"), true);
    $("meta").textContent = "Running read-only checks…";
    try {
      var result = await readJson(STATUS_URL);
      if (!result.response.ok || !result.data || !result.data.ok) {
        throw new Error((result.data && result.data.error) || "Status check failed.");
      }
      state.status = result.data;
      renderAll(result.data);
      if (showToast !== false) toast("Status refreshed from live checks.");
    } catch (error) {
      $("meta").textContent = "Status check failed: " + error.message;
      $("summary").innerHTML = '<article class="card tone-bad"><p class="card-label">STATUS CHECK</p><p class="card-value small">FAILED</p><p class="card-sub">' + esc(error.message) + "</p></article>";
      toast("Could not read status: " + error.message);
    } finally {
      setBusy($("refreshBtn"), false);
    }
  }

  function renderAll(data) {
    $("meta").textContent =
      "Checked " + fmtTime(data.generatedAt) +
      " · git " + (data.git && data.git.branch ? data.git.branch : "unknown") +
      " · " + (data.git && data.git.latest ? data.git.latest : "no commit information") +
      (data.git && data.git.changes != null ? " · " + data.git.changes + " changed path(s)" : "");

    renderSummary(data);
    renderDeployments(data);
    renderStaging(data);
    renderConfig(data);
    renderGmail(data);
    renderTests(data.tests);
    renderProgress(data);
    renderNext(data);
  }

  function renderSummary(data) {
    var prod = data.production || {};
    var staging = data.staging || {};
    var tests = data.tests;
    var gmail = data.gmail || {};
    var cards = [];

    var prodOnline = prod.config && prod.config.online === true;
    cards.push(card(
      "PRODUCTION BACKEND",
      prod.reachable ? (prodOnline ? "ONLINE ON" : "ONLINE OFF") : "UNREACHABLE",
      prod.reachable && prod.stats
        ? (prod.stats.teams || 0) + " teams · " + (prod.stats.players || 0) + " players"
        : (prod.error || "No public config answer."),
      prod.reachable ? (prodOnline ? "tone-warn" : "tone-ok") : "tone-bad"
    ));

    var stagingReachable = Boolean(staging.deployment && staging.deployment.reachable);
    var stagingTone = staging.configured
      ? (stagingReachable ? (staging.deployment.config && staging.deployment.config.online ? "tone-warn" : "tone-ok") : "tone-bad")
      : "tone-warn";
    cards.push(card(
      "STAGING SHEET",
      staging.configured ? (stagingReachable ? "CREATED · REACHABLE" : "CREATED · 403") : "NOT CREATED",
      staging.configured
        ? (staging.sheetName || "Staging endpoint configured.") + (stagingReachable ? "" : " · web app needs owner authorisation")
        : "Needs your Google session. Nothing was created here.",
      stagingTone
    ));

    cards.push(card(
      "APPS SCRIPT BUILD",
      staging.build && staging.build.codeMatches ? "MATCHES SOURCE" : (staging.build && staging.build.built ? "STALE" : "NOT BUILT"),
      staging.build && staging.build.codeMatches
        ? "staging/build/Code.js is byte-identical to apps-script.js."
        : "Run `node staging/prepare-staging.js` before pasting.",
      staging.build && staging.build.codeMatches ? "tone-ok" : "tone-warn"
    ));

    cards.push(card(
      "TEST SUITES",
      tests ? (tests.ok ? "ALL PASS" : "FAILURES") : "NOT RUN",
      tests
        ? tests.totalPassed + " passed · " + tests.totalFailed + " failed · " + Math.round(tests.durationMs / 100) / 10 + "s"
        : "Use “Run test suites” above.",
      tests ? (tests.ok ? "tone-ok" : "tone-bad") : "tone-warn"
    ));

    cards.push(card(
      "GMAIL OBSERVER",
      gmail.observer && gmail.observer.reachable ? "LOCAL SERVICE UP" : "NOT RUNNING",
      gmail.observer && gmail.observer.body
        ? "observed " + (gmail.observer.body.observedCount || 0) + " email(s); OAuth is not connected here."
        : "No Gmail OAuth authorization is available to this console.",
      gmail.observer && gmail.observer.reachable ? "tone-warn" : "tone-bad"
    ));

    $("summary").innerHTML = cards.join("");
  }

  function card(label, value, sub, tone) {
    return '<article class="card ' + esc(tone || "") + '">' +
      '<div class="card-head"><span class="card-label">' + esc(label) + "</span></div>" +
      '<p class="card-value">' + esc(value) + "</p>" +
      '<p class="card-sub">' + esc(sub) + "</p>" +
      "</article>";
  }

  function renderDeployments(data) {
    var prod = data.production || {};
    var old = data.obsolete || {};
    var rows = [];

    function deploymentRow(role, note, dep) {
      var config = dep && dep.config ? dep.config : {};
      var stats = dep && dep.stats ? dep.stats : {};
      var provider = config.provider || (config.service ? "legacy: " + config.service : "—");
      var online = config.online === true ? "true" : (config.online === false ? "false" : "—");
      return "<tr>" +
        "<td><strong>" + esc(role) + "</strong><br><span class=\"fine\">" + esc(note) + "</span></td>" +
        "<td><code>" + esc(dep && dep.masked ? dep.masked : "—") + "</code><br><span class=\"fine\">" + esc(dep && dep.error ? dep.error : "reachable") + "</span></td>" +
        "<td>" + esc(provider) + "</td>" +
        "<td>" + esc(online) + "</td>" +
        "<td>" + esc(stats.teams != null ? stats.teams : "—") + "</td>" +
        "<td>" + esc(stats.lastRegistration || "—") + "</td>" +
        "</tr>";
    }

    rows.push(deploymentRow("Current", "script.js:6 + admin.js:18", prod));
    rows.push(deploymentRow("Obsolete", "removed in commit " + (old.removedBy || "b91d788"), old));
    $("deployRows").innerHTML = rows.join("");

    var chip = $("deployChip");
    if (prod.reachable && prod.adminUsesSameUrl) {
      chip.className = "chip completed";
      chip.textContent = "SITE + DASHBOARD AGREE";
    } else if (prod.reachable) {
      chip.className = "chip failed";
      chip.textContent = "URL MISMATCH";
    } else {
      chip.className = "chip failed";
      chip.textContent = "UNREACHABLE";
    }

    var callout = $("deployCallout");
    if (prod.reachable && old.reachable) {
      var prodTeams = prod.stats ? prod.stats.teams : null;
      var oldTeams = old.stats ? old.stats.teams : null;
      callout.hidden = false;
      callout.className = "callout info";
      callout.innerHTML = "Both deployments answer, but they do not read the same data (" +
        esc(prodTeams) + " teams vs " + esc(oldTeams) + "). The obsolete deployment is not referenced by any current file. " +
        "No deployment was archived.";
    } else if (!prod.adminUsesSameUrl) {
      callout.hidden = false;
      callout.className = "callout danger";
      callout.textContent = "The site and dashboard use different Apps Script URLs. Do not change production; inspect script.js and admin.js first.";
    } else {
      callout.hidden = true;
    }
  }

  function renderStaging(data) {
    var staging = data.staging || {};
    var build = staging.build || {};
    var dep = staging.deployment;
    var configured = Boolean(staging.configured);
    var reachable = Boolean(dep && dep.reachable);
    var separate = configured && dep && data.production && dep.url !== data.production.url;

    var items = [
      {
        title: "Staging Google Sheet",
        status: configured ? "completed" : "blocked",
        detail: configured
          ? "Created in Google Drive: " + (staging.sheetName || "QQSGP STAGING") + ". This console cannot open it; confirm it is empty and separate from production."
          : "No staging Sheet exists in this workspace. Copy production with File → Make a copy; never edit production."
      },
      {
        title: "Staging Apps Script project",
        status: configured ? (reachable ? "completed" : "pending") : "blocked",
        detail: configured
          ? (reachable
              ? "The separate staging project is deployed and answering."
              : "Separate project exists and the clean build is pushed. The web app returns HTTP 403 until the owner authorises it in the editor.")
          : "Create it from the staging Sheet via Extensions → Apps Script. A Google session is required."
      },
      {
        title: "Build copy",
        status: build.codeMatches ? "completed" : (build.built ? "failed" : "pending"),
        detail: build.codeMatches
          ? "staging/build/Code.js is byte-identical to apps-script.js."
          : "Run `node staging/prepare-staging.js`; a stale copy must not be pasted."
      },
      {
        title: "Manifest",
        status: build.manifestMatches ? "completed" : "pending",
        detail: build.manifestMatches
          ? "staging/appsscript.json matches the built manifest."
          : "Build the manifest with staging/prepare-staging.js."
      },
      {
        title: "Staging-only diagnostic",
        status: build.stagingCheck ? "completed" : "pending",
        detail: build.stagingCheck
          ? "StagingCheck.gs is present; run stagingTarget() after setting sheet_id."
          : "Rebuild the staging folder to add StagingCheck.gs."
      },
      {
        title: "Project linked for clasp",
        status: build.claspLinked ? "completed" : "pending",
        detail: build.claspLinked
          ? "staging/build/.clasp.json exists. Never point it at production."
          : "Optional. Set STAGING_SCRIPT_ID and rerun prepare-staging.js."
      },
      {
        title: "Staging deployment",
        status: configured ? (reachable ? "completed" : "failed") : "blocked",
        detail: configured
          ? (reachable
              ? "The /exec endpoint answered config and stats."
              : ((dep && dep.error) || "No answer from the staging endpoint.") + ((dep && /403/.test(dep.error || "")) ? " — Google is refusing anonymous execution until the owner authorises the script." : ""))
          : "Set STAGING_EXEC_URL or staging/.staging.json after deploying."
      },
      {
        title: "Separate from production",
        status: configured ? (separate ? "completed" : "failed") : "pending",
        detail: configured
          ? (separate ? "The staging URL is not the production URL." : "The staging URL equals the production URL. Stop.")
          : "Cannot compare until a staging URL exists."
      }
    ];

    $("stagingChecklist").innerHTML = items.map(function (item) {
      return '<div class="check-row">' +
        statusDot(item.status) +
        '<div class="check-title">' + esc(item.title) + "</div>" +
        '<div class="check-detail">' + esc(item.detail) + "</div>" +
        badge(item.status) +
        "</div>";
    }).join("");

    var chip = $("stagingChip");
    chip.className = "chip " + (configured ? (reachable ? "completed" : "failed") : "blocked");
    chip.textContent = configured ? (reachable ? "ENDPOINT REACHABLE" : "CREATED · NEEDS AUTHORISATION") : "BLOCKED · NO GOOGLE SESSION";

    var buildList = [
      ["staging/prepare-staging.js", "Builds Code.js, the manifest and StagingCheck.gs.", build.built],
      ["staging/check-staging.js", "Read-only validator; refuses the production URL.", true],
      ["staging/appsscript.json", "V8 · Asia/Kolkata · Execute as Me · Anyone.", build.manifestMatches],
      ["staging/build/", "Generated, gitignored, contains no Sheet ID.", build.built]
    ];
    $("buildList").innerHTML = buildList.map(function (item) {
      return "<li><span class=\"status-dot " + (item[2] ? "completed" : "pending") + "\"></span><span><strong>" +
        esc(item[0]) + "</strong> — " + esc(item[1]) + "</span></li>";
    }).join("");

    var steps = (data.nextActions || []).slice(0, 5);
    $("googleSteps").innerHTML = steps.map(function (step) {
      return "<li>" + rich(step) + "</li>";
    }).join("");

    var callout = $("stagingCallout");
    if (staging.error) {
      callout.hidden = false;
      callout.className = "callout danger";
      callout.textContent = staging.error;
    } else if (!configured) {
      callout.hidden = false;
      callout.className = "callout warning";
      callout.textContent = "No staging /exec URL is configured, so the deployed staging checks cannot run yet. The local build, manifest and test suites are still real.";
    } else {
      callout.hidden = true;
    }
  }

  function renderConfig(data) {
    var prod = (data.production && data.production.config) || {};
    var staging = (data.staging && data.staging.deployment && data.staging.deployment.config) || {};
    var stagingConfigured = Boolean(data.staging && data.staging.configured);
    var prodOffline = prod.online === false;
    var stagingOffline = staging.online === false;

    function present(flag, online) {
      if (!flag) return "—";
      if (online === true) return "Present (online:true)";
      if (online === false) return "Unknown — offline";
      return "—";
    }

    var rows = [
      ["`online` flag", prod.online === true ? "true" : (prod.online === false ? "false" : "—"), stagingConfigured ? (staging.online === true ? "true" : (staging.online === false ? "false" : "—")) : "—", "The only switch the page reads."],
      ["Entry fee", prod.fee != null ? "₹" + prod.fee : "—", stagingConfigured && staging.fee != null ? "₹" + staging.fee : "—", "From the Settings tab; snapshotted per row."],
      ["Provider", prod.provider || "—", stagingConfigured ? (staging.provider || "—") : "—", "YouPI is the only online provider."],
      ["`youpi_base_url`", present(prod.provider, prod.online), stagingConfigured ? present(staging.provider, staging.online) : "—", "Required only when online is meant to be on."],
      ["`youpi_merchant_id`", present(prod.provider, prod.online), stagingConfigured ? present(staging.provider, staging.online) : "—", "Merchant UUID; never shown here."],
      ["`youpi_merchant_key`", present(prod.provider, prod.online), stagingConfigured ? present(staging.provider, staging.online) : "—", "Webhook secret; kept server-side."],
      ["Minimum verification", prod.minVerification != null ? "L" + prod.minVerification : "—", stagingConfigured && staging.minVerification != null ? "L" + staging.minVerification : "—", "Gmail-only normally reaches L1; the default minimum is L2."],
      ["`?action=payorder`", prodOffline ? "PAYMENT_OFFLINE" : (prod.online === true ? "Open to orders" : "—"), stagingConfigured ? (stagingOffline ? "PAYMENT_OFFLINE" : (staging.online === true ? "Open to orders" : "—")) : "—", "Offline gate returns before reading the body."],
      ["Gmail OAuth", "Not connected here", "Not connected here", "Needs a Google Cloud client and the YouPI admin consent flow."]
    ];

    $("configRows").innerHTML = rows.map(function (row) {
      return "<tr><td><strong>" + esc(row[0].replace(/`/g, "")) + "</strong></td><td>" + esc(row[1]) + "</td><td>" + esc(row[2]) + "</td><td>" + esc(row[3]) + "</td></tr>";
    }).join("");

    $("configNote").textContent = prod.online === false
      ? "Production reports online:false. That proves at least one of youpi_base_url, youpi_merchant_id or youpi_merchant_key is missing or invalid; it does not reveal which one. This console never asks for the values."
      : "Production does not currently prove that all three properties are valid. The console never asks for their values.";

    var chip = $("configChip");
    if (prod.online === false) {
      chip.className = "chip completed";
      chip.textContent = "PRODUCTION SAFELY OFF";
    } else if (prod.online === true) {
      chip.className = "chip pending";
      chip.textContent = "PRODUCTION ONLINE ON";
    } else {
      chip.className = "chip failed";
      chip.textContent = "UNKNOWN";
    }
  }

  function renderGmail(data) {
    var gmail = data.gmail || {};
    var observer = gmail.observer || {};
    var api = gmail.paymentApi || {};
    var body = observer.body || {};

    var items = [
      ["Gmail observer :6003", observer.reachable ? "reachable" : "not running", observer.reachable ? "health answered" : (observer.error || "no service")],
      ["Payment API :6100", api.reachable ? "reachable" : "not running", api.reachable ? "health answered" : (api.error || "no service")],
      ["Poller observed count", observer.reachable ? String(body.observedCount || 0) : "—", observer.reachable ? ("last poll " + (body.lastPollAt ? fmtTime(body.lastPollAt) : "—")) : "start the local stack"],
      ["OAuth credentials", "unknown", "YouPI stores them server-side; this console has no admin token."]
    ];
    $("gmailStatus").innerHTML = items.map(function (item) {
      return "<li><span><strong>" + esc(item[0]) + "</strong> — " + esc(item[1]) + "<br><span class=\"fine\">" + esc(item[2]) + "</span></span></li>";
    }).join("");

    var rules = [
      "Accepted senders are official Indian bank alert domains (.bank.in/.fin.in or the bank list in verification-pipeline.js).",
      "FamPay/FamApp notifications from a non-bank domain are rejected as INVALID_EMAIL_DOMAIN.",
      "Gmail-only confirmation is normally verification level 1; this backend defaults to level 2.",
      "A Gmail notification is evidence for matching, never a PAID command. Apps Script still asks YouPI for the owner-verified status.",
      "A real Gmail authorization needs a Google Cloud OAuth client, gmail.readonly consent and a refresh token; none is connected here."
    ];
    $("gmailRules").innerHTML = rules.map(function (rule) {
      return "<li><span>" + esc(rule) + "</span></li>";
    }).join("");

    $("gmailNote").textContent = gmail.note || "No Gmail connector is available in this workspace.";

    var chip = $("gmailChip");
    chip.className = "chip " + (observer.reachable ? "pending" : "blocked");
    chip.textContent = observer.reachable ? "LOCAL SERVICE UP" : "NOT RUNNING";

    renderGmailCheck(gmail.check);
  }

  function renderGmailCheck(check) {
    var container = $("gmailCheckResults");
    var chip = $("gmailCheckChip");
    if (!container) return;

    if (!check) {
      container.innerHTML = '<p class="muted">No Gmail check has run in this preview session. Press “Run live Gmail check” to execute YouPI\u2019s suites.</p>';
      chip.className = "chip blocked";
      chip.textContent = "NOT RUN";
      return;
    }

    if (check.unavailable) {
      chip.className = "chip blocked";
      chip.textContent = "UNAVAILABLE";
      container.innerHTML = '<div class="test-summary"><strong>Check could not run.</strong> ' +
        esc(check.error || "No local YouPI checkout was found.") +
        "<br><span class=\"fine\">Checked " + esc(fmtTime(check.ranAt)) + "</span></div>";
      return;
    }

    chip.className = "chip " + (check.ok ? "completed" : "failed");
    chip.textContent = check.ok ? "ALL PASS" : "FAILURES";

    var summary = '<div class="test-summary">' +
      "<strong>" + (check.ok ? "All checked suites passed." : "One or more checked suites failed.") + "</strong> " +
      esc(check.totalPassed) + " passed, " + esc(check.totalFailed) + " failed · " +
      esc(fmtTime(check.ranAt)) + "</div>";

    var suites = (check.suites || []).map(function (suite) {
      var tail = (suite.tail || []).join("\n");
      return '<div class="test-suite">' +
        '<span class="name">' + esc(suite.label || suite.file) + "<br><span class=\"fine\">" + esc(suite.file) + "</span></span>" +
        '<span class="num ' + (suite.exitCode === 0 ? "ok" : "bad") + '">exit ' + esc(suite.exitCode) + "</span>" +
        '<span class="num ' + ((suite.failed || 0) === 0 ? "ok" : "bad") + '">' + esc(suite.passed == null ? "?" : suite.passed) + " passed · " + esc(suite.failed == null ? "?" : suite.failed) + " failed</span>" +
        '<span class="num duration">' + Math.round((suite.durationMs || 0) / 100) / 10 + "s</span>" +
        "<details><summary>Show actual output tail</summary><pre>" + esc(tail || "no output") + "</pre></details>" +
        "</div>";
    }).join("");

    var findings = (check.findings || []).length
      ? '<ul class="plain-list">' + check.findings.map(function (finding) {
          return "<li><span>" + esc(finding) + "</span></li>";
        }).join("") + "</ul>"
      : "";

    container.innerHTML = summary + findings + suites;
  }

  async function runGmailCheck() {
    setBusy($("gmailCheckBtn"), true);
    $("gmailCheckChip").className = "chip pending";
    $("gmailCheckChip").textContent = "RUNNING";
    try {
      var result = await readJson(GMAIL_CHECK_URL, { method: "POST" });
      if (!result.response.ok) throw new Error((result.data && result.data.error) || "Gmail check failed.");
      renderGmailCheck(result.data);
      toast(result.data.ok ? "Gmail and verification suites passed." : "Gmail check reported failures.");
      await loadStatus(false);
    } catch (error) {
      toast("Could not run the Gmail check: " + error.message);
      $("gmailCheckChip").className = "chip failed";
      $("gmailCheckChip").textContent = "ERROR";
    } finally {
      setBusy($("gmailCheckBtn"), false);
    }
  }

  function renderTests(tests) {
    var container = $("testResults");
    var chip = $("testsChip");

    if (!tests) {
      container.innerHTML = '<p class="muted">No suite has been run in this preview session. Press “Run test suites” to execute them now.</p>';
      chip.className = "chip blocked";
      chip.textContent = "NOT RUN";
      return;
    }

    chip.className = "chip " + (tests.ok ? "completed" : "failed");
    chip.textContent = tests.ok ? "ALL PASS" : "FAILURES";

    var summary = '<div class="test-summary">' +
      "<strong>" + (tests.ok ? "All suites passed." : "One or more suites failed.") + "</strong> " +
      esc(tests.totalPassed) + " passed, " + esc(tests.totalFailed) + " failed · " +
      esc(fmtTime(tests.finishedAt)) + " · " + (Math.round(tests.durationMs / 100) / 10) + "s" +
      "</div>";

    var suites = (tests.suites || []).map(function (suite) {
      var tail = (suite.tail || []).join("\n");
      return '<div class="test-suite">' +
        '<span class="name">' + esc(suite.file) + "</span>" +
        '<span class="num ' + (suite.exitCode === 0 ? "ok" : "bad") + '">exit ' + esc(suite.exitCode) + "</span>" +
        '<span class="num ' + ((suite.failed || 0) === 0 ? "ok" : "bad") + '">' + esc(suite.passed == null ? "?" : suite.passed) + " passed · " + esc(suite.failed == null ? "?" : suite.failed) + " failed</span>" +
        '<span class="num duration">' + Math.round((suite.durationMs || 0) / 100) / 10 + "s</span>" +
        "<details><summary>Show actual output tail</summary><pre>" + esc(tail || "no output") + "</pre></details>" +
        "</div>";
    }).join("");

    container.innerHTML = summary + suites;
  }

  function renderProgress(data) {
    var stages = data.stages || [];
    var counts = { completed: 0, pending: 0, blocked: 0, failed: 0 };
    stages.forEach(function (stage) { counts[stage.status] = (counts[stage.status] || 0) + 1; });

    $("progressList").innerHTML = stages.map(function (stage) {
      return '<li class="progress-item">' +
        '<span class="progress-n">' + String(stage.n).padStart(2, "0") + "</span>" +
        '<span class="progress-title">' + esc(stage.title) + (stage.needsUser ? '<br><span class="fine">needs your action</span>' : "") + "</span>" +
        '<span class="progress-detail">' + esc(stage.detail) + "</span>" +
        badge(stage.status) +
        "</li>";
    }).join("");

    var chip = $("progressChip");
    chip.className = "chip " + (counts.failed ? "failed" : (counts.blocked ? "blocked" : "completed"));
    chip.textContent = counts.completed + " done · " + counts.pending + " pending · " + counts.blocked + " blocked";
  }

  function renderNext(data) {
    $("nextActions").innerHTML = (data.nextActions || []).map(function (action) {
      return "<li>" + rich(action) + "</li>";
    }).join("");
  }

  async function runTests() {
    setBusy($("testsBtn"), true);
    $("testsChip").className = "chip pending";
    $("testsChip").textContent = "RUNNING";
    try {
      var result = await readJson(TESTS_URL, { method: "POST" });
      if (!result.response.ok) throw new Error((result.data && result.data.error) || "Test run failed.");
      renderTests(result.data);
      toast(result.data.ok ? "Test suites passed." : "Test suites reported failures.");
      await loadStatus(false);
    } catch (error) {
      toast("Could not run tests: " + error.message);
      $("testsChip").className = "chip failed";
      $("testsChip").textContent = "ERROR";
    } finally {
      setBusy($("testsBtn"), false);
    }
  }

  function log(line) {
    var stamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
    state.logLines.push("[" + stamp + "] " + line);
    if (state.logLines.length > 80) state.logLines.shift();
    $("synLog").textContent = state.logLines.join("\n");
    $("synLog").scrollTop = $("synLog").scrollHeight;
  }

  function teamName() {
    return ($("synTeam").value || "").trim();
  }

  function syntheticBody(team) {
    return {
      teamName: team,
      department: "CSE — Computer Science Engineering",
      members: [
        { name: ($("synP1").value || "").trim(), whatsapp: ($("synW1").value || "").trim() },
        { name: ($("synP2").value || "").trim(), whatsapp: ($("synW2").value || "").trim() }
      ],
      whatsappConsent: false
    };
  }

  async function findSyntheticRow(team) {
    var result = await readJson(MOCK_ADMIN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list", q: team, page: 1, pageSize: 10 })
    });
    if (!result.data || !result.data.ok) return null;
    return (result.data.records || []).filter(function (record) {
      return record.teamName === team;
    })[0] || null;
  }

  function showRow(record, label) {
    var payment = record.payment || {};
    $("synRow").hidden = false;
    $("synRow").innerHTML = "<strong>" + esc(label) + "</strong><br>" +
      "approval: " + esc(record.status) + " · " +
      esc(payment.method || "CASH") + " / " + esc(payment.status || "PENDING") + " · " +
      "₹" + esc(payment.entryFee != null ? payment.entryFee : "—") +
      (payment.provider ? " · " + esc(payment.provider) : "") +
      (payment.verifiedAt ? " · " + esc(payment.verifiedAt) : "");
  }

  async function cashRegister() {
    var team = teamName();
    if (!team) { toast("Enter a synthetic team name."); return; }
    log("POST /__mock/exec (cash synthetic) for " + team);
    var result = await readJson("/__mock/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(syntheticBody(team))
    });
    log("response: " + JSON.stringify(result.data));
    if (!result.data || !result.data.ok) {
      toast((result.data && result.data.error) || "The mock refused the team.");
      return;
    }
    var row = await findSyntheticRow(team);
    if (!row) { toast("Row was accepted but not found in the mock list."); return; }
    state.cashId = row.id;
    state.cashPaid = false;
    $("markPaidBtn").disabled = false;
    showRow(row, "Synthetic cash row");
    log("found row " + row.id.slice(0, 8) + "… · " + (row.payment.method || "CASH") + " / " + (row.payment.status || "PENDING"));
    $("syntheticHint").textContent = "Cash row is PENDING until an organiser marks it paid. It exists only in memory.";
    toast("Synthetic cash row created in the local mock.");
  }

  async function startOnline() {
    var team = teamName();
    if (!team) { toast("Enter a synthetic team name."); return; }
    if (state.mockOnline === false) { toast("The mock is currently offline."); return; }
    log("POST /__mock/exec?action=payorder for " + team);
    var result = await readJson("/__mock/exec?action=payorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(syntheticBody(team))
    });
    log("response: " + JSON.stringify(result.data));
    if (!result.data || !result.data.ok) {
      toast((result.data && result.data.error) || "Could not start the mock payment.");
      return;
    }
    state.token = result.data.token;
    state.team = team;
    state.onlinePaid = false;
    $("confirmBtn").disabled = false;
    var checkout = result.data.checkoutUrl
      ? '<a href="' + esc(result.data.checkoutUrl) + '" target="_blank" rel="noopener">Open mock checkout</a>'
      : "No checkout URL";
    $("syntheticHint").innerHTML = "Draft opened for ₹" + esc(result.data.amount) + ". " + checkout +
      '. Nothing is registered until the mock gateway confirms it.';
    toast("Mock payment draft opened. No money moved.");
  }

  async function confirmOnline() {
    if (!state.token) { toast("Start a mock online payment first."); return; }
    log("POST /__mock/pay (simulated gateway confirmation)");
    var paid = await readJson("/__mock/pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: state.token })
    });
    log("gateway: " + JSON.stringify(paid.data));
    if (!paid.data || paid.data.state !== "PAID") {
      toast("The mock gateway did not return PAID.");
      return;
    }
    var poll = await readJson("/__mock/exec?action=paystatus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: state.token })
    });
    log("status: " + JSON.stringify(poll.data));
    var row = await findSyntheticRow(state.team);
    if (row) showRow(row, "Synthetic online row");
    $("confirmBtn").disabled = true;
    state.onlinePaid = true;
    $("syntheticHint").textContent = "Mock gateway confirmed the draft. This is a local simulation, not a real payment.";
    toast("Mock payment verified and row read back.");
    await loadStatus(false);
  }

  async function markCashPaid() {
    if (!state.cashId) { toast("Register a synthetic cash row first."); return; }
    log("POST mock-admin payment-status -> PAID");
    var result = await readJson(MOCK_ADMIN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "payment-status",
        id: state.cashId,
        paymentStatus: "PAID",
        expectedPayment: "PENDING",
        note: "Synthetic console check"
      })
    });
    log("response: " + JSON.stringify(result.data).slice(0, 500));
    if (!result.data || !result.data.ok) {
      toast((result.data && result.data.error) || "Could not mark the mock row paid.");
      return;
    }
    state.cashPaid = true;
    $("markPaidBtn").disabled = true;
    showRow(result.data.record, "Synthetic cash row (marked paid)");
    toast("Mock cash row marked PAID by the organiser path.");
  }

  async function loadMockMeta() {
    try {
      var result = await readJson("/__mock/exec?action=config");
      if (!result.data || result.data.ok === false) return;
      state.mockFee = result.data.fee;
      state.mockOnline = result.data.online === true;
      $("mockFee").textContent = "₹" + state.mockFee;
      if (!state.mockOnline) {
        $("onlineBtn").disabled = true;
        $("syntheticHint").textContent = "The local mock currently reports online:false; only cash can be tested.";
      }
    } catch (error) {
      $("mockFee").textContent = "—";
    }
  }

  function bind() {
    $("refreshBtn").addEventListener("click", function () { loadStatus(true); });
    $("testsBtn").addEventListener("click", runTests);
    $("gmailCheckBtn").addEventListener("click", function () { runGmailCheck(); });
    $("cashBtn").addEventListener("click", function () { cashRegister().catch(function (e) { toast(e.message); }); });
    $("onlineBtn").addEventListener("click", function () { startOnline().catch(function (e) { toast(e.message); }); });
    $("confirmBtn").addEventListener("click", function () { confirmOnline().catch(function (e) { toast(e.message); }); });
    $("markPaidBtn").addEventListener("click", function () { markCashPaid().catch(function (e) { toast(e.message); }); });
    $("clearLogBtn").addEventListener("click", function () {
      state.logLines = ["Log cleared."];
      $("synLog").textContent = state.logLines[0];
    });
  }

  function init() {
    bind();
    var stamp = new Date().toISOString().slice(11, 19).replace(/[:]/g, "");
    $("synTeam").value = "STAGING SYNTHETIC " + stamp;
    $("synLog").textContent = state.logLines.join("\n");
    loadMockMeta();
    loadStatus(false);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
