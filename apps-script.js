/*
  ================================================================
  QQSGP FREE FIRE TOURNAMENT — REGISTRATION BACKEND
  Quli Qutub Shah Government Polytechnic
  ================================================================

  WHAT THIS SCRIPT DOES
  ---------------------
  • Receives team registrations from the website (doPost).
  • Stores every team as one clean row in the "Registrations" sheet.
  • Serves live counters to the website (doGet ?action=stats).
  • Formats the sheet automatically so it looks organised, not messy.

  SETUP (do this once)
  --------------------
  1. Open your Google Sheet.
  2. Extensions -> Apps Script.
  3. Delete everything and paste this whole file.
  4. Optional: put your email in CONFIG.ORGANIZER_EMAIL.
  5. Optional: set CONFIG.MAX_TEAMS to limit team slots (0 = no limit).
  6. Click Deploy -> Manage deployments -> edit (pencil) the existing
     deployment -> Version: New version -> Deploy.
     (Use "New version" on the SAME deployment so the website URL
      stays the same and you do not have to edit script.js.)
  7. Open the sheet and reload it. The "Tournament" menu appears.

  IMPORTANT
  ---------
  After pasting an update you must deploy a NEW VERSION, otherwise the
  website keeps talking to the old code and the counters stay as dashes.
  ================================================================
*/

var CONFIG = {
  // Tab that holds the registrations. Created automatically if missing.
  SHEET_NAME: 'Registrations',

  // Leave '' when this script is bound to the sheet (normal case).
  // Paste a spreadsheet ID here only for a standalone script.
  SHEET_ID: '',

  // Optional: receive an email for every registration.
  ORGANIZER_EMAIL: '',

  // Optional: maximum number of teams. 0 = unlimited.
  MAX_TEAMS: 0,

  // How long the website counter may reuse a cached result (seconds).
  STATS_CACHE_SECONDS: 20,

  // How long a submission waits for its turn before giving up.
  LOCK_TIMEOUT_MS: 15000,

  // --- Admin dashboard ---------------------------------------------
  // The dashboard key lives in Script Properties, never in this file and never
  // in the published website. Run setupAdminKey() once from the editor (see
  // ADMIN.md) and paste the value it prints into the dashboard once.
  ADMIN_KEY_PROPERTY: 'admin_key',
  // Wrong keys allowed before the dashboard is locked out for a while.
  ADMIN_MAX_FAILS: 8,
  ADMIN_LOCK_SECONDS: 600,
  ADMIN_PAGE_SIZE: 25,
  ADMIN_NOTE_LIMIT: 500,

  // --- WhatsApp notifications (optional) ---------------------------
  // Credentials are NOT here. They live in Script Properties, so they are
  // never in this file, the repository or the published website. The exact
  // property names and setup steps are in WHATSAPP.md.
  NOTIF_SHEET_NAME: 'Notifications',
  WHATSAPP_MAX_ATTEMPTS: 3,
  WHATSAPP_RETRY_BACKOFF_SECONDS: 60,
  WHATSAPP_PER_MINUTE_LIMIT: 25,
  WHATSAPP_ANNOUNCE_MAX: 900,

  // Two identical announcements to the same recipients inside this window are
  // the same announcement: a double click (or a hasty preview/send/preview/send)
  // cannot message the same teams twice. A deliberate reminder later gets a
  // new window and is sent again.
  WHATSAPP_ANNOUNCE_WINDOW_MINUTES: 10
};

// Column order. The website sends exactly this data; Status and Note are
// appended by this script and are never sent by a public registration.
var HEADERS = [
  'Timestamp',
  'Team Name',
  'Department',
  'Player 1 Name', 'Player 1 WhatsApp',
  'Player 2 Name', 'Player 2 WhatsApp',
  'Player 3 Name',
  'Player 4 Name',
  'Status',
  'Note',
  'WhatsApp Consent',
  'Consent At'
];

// Organiser workflow states. A blank status on an older row reads as PENDING.
var STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WAITLISTED'];

// A squad may register short-handed: 2 to 4 players is a valid entry.
var MIN_PLAYERS = 2;
var MAX_PLAYERS = 4;

var DEPARTMENTS = [
  'CSE — Computer Science Engineering',
  'EEE — Electrical & Electronics Engineering',
  'Mechanical Engineering',
  'Printing Technology',
  'Electronics & Communication Engineering',
  'Civil Engineering'
];

// 1-based column numbers (kept in one place so nothing drifts).
var COL = {
  TIMESTAMP: 1, TEAM: 2, DEPARTMENT: 3,
  P1: 4, P1_WA: 5, P2: 6, P2_WA: 7, P3: 8, P4: 9,
  STATUS: 10, NOTE: 11,
  CONSENT: 12, CONSENT_AT: 13
};

// Only players 1 and 2 give a WhatsApp number.
var PHONE_COLUMNS = [COL.P1_WA, COL.P2_WA];
var NAME_COLUMNS = [COL.P1, COL.P2, COL.P3, COL.P4];

var COLUMN_WIDTHS = [160, 170, 280, 135, 150, 135, 150, 135, 135, 110, 260];

// A calm, record-like palette. The brand lime survives only as one thin rule
// under the header and on the tab. Lime text on near-black read as cheap, and
// the green-tinted stripes muddied the data instead of separating it.
var THEME = {
  headerBg: '#1f2933',
  headerText: '#ffffff',
  headerRule: '#b8ff39',
  rowEven: '#ffffff',
  rowOdd: '#f7f8fa',
  border: '#e4e7eb',
  bodyText: '#1c2430',
  tab: '#1f2933',
  duplicateBg: '#fdecec',
  duplicateText: '#b3261e'
};

// Includes the sheet name so renaming the tab can never serve stale counters.
var CACHE_KEY_STATS = 'qqsgp_stats_v2_' + CONFIG.SHEET_NAME;
var PROP_FORMATTED = 'qqsgp_sheet_format_v2';


/* ================================================================
   WEB ENTRY POINTS
   ================================================================ */

/**
 * GET requests.
 *   ?action=stats  -> live counters for the website.
 *   (no action)    -> a small health/info response.
 */
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'info';

  try {
    // Meta calls this once to verify the webhook URL. It must answer the raw
    // challenge string, not JSON.
    if (action === 'webhook') {
      return whatsappWebhookVerify_(e);
    }

    if (action === 'stats') {
      return jsonResponse_(getStats_());
    }

    return jsonResponse_({
      ok: true,
      service: 'QQSGP Free Fire Registration',
      status: 'running',
      endpoints: ['?action=stats', '?action=webhook']
    });
  } catch (error) {
    return errorResponse_('Server error: ' + messageOf_(error));
  }
}

/**
 * POST requests — a new team registration.
 * Always answers with JSON: { ok: true } or { ok: false, error: '...' }.
 */
function doPost(e) {
  // Administrative traffic arrives on the same URL but is routed first and is
  // answered only after the server checks the key. A public registration never
  // reaches any admin code, and an admin call never falls through to the
  // registration path.
  var route = (e && e.parameter && e.parameter.action) || '';

  // Delivery receipts from Meta. Authenticated by signature, never by the
  // dashboard key, and it can only update notification statuses.
  if (route === 'webhook') {
    try {
      return whatsappWebhookEvent_(e);
    } catch (error) {
      console.error('Webhook failed: ' + messageOf_(error));
      return jsonResponse_({ ok: false });
    }
  }

  if (route === 'admin') {
    try {
      return jsonResponse_(adminHandle_(e));
    } catch (error) {
      return errorResponse_('Server error: ' + messageOf_(error));
    }
  }

  var lock = null;

  try {
    // 1. Read the body (JSON from fetch, or form-encoded payload).
    var body = readBody_(e);
    if (!body.ok) return errorResponse_(body.error);

    // 2. Validate everything before touching the sheet.
    var checked = validateRegistration_(body.value);
    if (!checked.ok) return errorResponse_(checked.error);

    // 3. One writer at a time, so two teams never collide.
    lock = LockService.getScriptLock();
    if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
      return errorResponse_('The server is busy. Please try again in a few seconds.');
    }

    var sheet = getSheet_();
    ensureHeaders_(sheet);

    // 4. Rules.
    if (CONFIG.MAX_TEAMS > 0 && countTeams_(sheet) >= CONFIG.MAX_TEAMS) {
      return errorResponse_('All ' + CONFIG.MAX_TEAMS + ' team slots are taken. Registration is closed.');
    }
    if (hasTeamRegisteredToday_(sheet, checked.value.teamName)) {
      return errorResponse_('A team named "' + checked.value.teamName + '" has already registered today.');
    }

    // 5. Write the row.
    var rowNumber = appendRegistration_(sheet, checked.value);
    refreshBodyStyles_(sheet);
    clearStatsCache_();

    var stats = collectStats_(sheet);

    lock.releaseLock();
    lock = null;

    // 6. Email the organizer (never allowed to break a registration).
    notifyOrganizer_(checked.value, rowNumber);

    // 7. Optional "entry received" WhatsApp message. Off unless the organisers
    //    switch it on, and it can never fail the registration either.
    maybeSendReceipt_(sheet, rowNumber);

    return jsonResponse_({
      ok: true,
      team: checked.value.teamName,
      row: rowNumber,
      teams: stats.teams,
      players: stats.players
    });

  } catch (error) {
    return errorResponse_('Server error: ' + messageOf_(error));

  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (ignored) {}
    }
  }
}


/* ================================================================
   SENDING DATA TO THE WEBSITE
   ================================================================ */

/** Live counters, cached briefly so the sheet is not hit on every page view. */
function getStats_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CACHE_KEY_STATS);

  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (ignored) {
      // Corrupt cache entry — fall through and rebuild it.
    }
  }

  var sheet = getSheet_();
  ensureHeaders_(sheet);

  var stats = collectStats_(sheet);
  var payload = {
    ok: true,
    teams: stats.teams,
    players: stats.players,
    departments: stats.departments,
    byDepartment: stats.byDepartment,
    lastRegistration: stats.lastRegistration,
    capacity: CONFIG.MAX_TEAMS,
    slotsLeft: CONFIG.MAX_TEAMS > 0 ? Math.max(CONFIG.MAX_TEAMS - stats.teams, 0) : null,
    generatedAt: new Date().toISOString()
  };

  try {
    cache.put(CACHE_KEY_STATS, JSON.stringify(payload), CONFIG.STATS_CACHE_SECONDS);
  } catch (ignored) {
    // A cache failure must never break the response.
  }

  return payload;
}

function clearStatsCache_() {
  try {
    CacheService.getScriptCache().remove(CACHE_KEY_STATS);
  } catch (ignored) {}
}

function jsonResponse_(object) {
  return ContentService
    .createTextOutput(JSON.stringify(object))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse_(message) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: message }))
    .setMimeType(ContentService.MimeType.JSON);
}


/* ================================================================
   READING AND VALIDATING THE SUBMISSION
   ================================================================ */

function readBody_(e) {
  // The website sends JSON in the request body. A plain HTML form POST instead
  // arrives url-encoded, and then postData.contents holds the encoded body
  // ('payload=%7B...') while the decoded JSON shows up in e.parameter.payload.
  // Both are tried in order and the first one that parses as a JSON object
  // wins, so neither sender is told its data is unreadable.
  var candidates = [];

  if (e && e.postData && e.postData.contents) {
    candidates.push(e.postData.contents);
  }
  if (e && e.parameter && e.parameter.payload) {
    candidates.push(e.parameter.payload);
  }

  if (candidates.length === 0) return { ok: false, error: 'No data received.' };

  var parsedSomething = false;

  for (var i = 0; i < candidates.length; i++) {
    try {
      var parsed = JSON.parse(candidates[i]);
      parsedSomething = true;
      if (parsed && typeof parsed === 'object') {
        return { ok: true, value: parsed };
      }
    } catch (ignored) {
      // Not JSON — fall through and try the next candidate.
    }
  }

  // Valid JSON that is not an object (a bare number, string, boolean or null)
  // is a different mistake from an unparseable body, and reads differently.
  if (parsedSomething) return { ok: false, error: 'The submitted data is not valid.' };
  return { ok: false, error: 'The submitted data is not valid JSON.' };
}

function validateRegistration_(payload) {
  // --- Team name ---
  var teamName = cleanText_(payload.teamName);
  if (!teamName) return { ok: false, error: 'Team name is required.' };
  if (teamName.length < 2 || teamName.length > 40) {
    return { ok: false, error: 'Team name must be between 2 and 40 characters.' };
  }
  if (hasMarkup_(teamName)) {
    return { ok: false, error: 'Team name contains characters that are not allowed.' };
  }

  // --- Department ---
  var department = cleanText_(payload.department);
  if (!department) return { ok: false, error: 'Department is required.' };
  if (DEPARTMENTS.indexOf(department) === -1) {
    return { ok: false, error: 'Please choose a department from the list.' };
  }

  // --- Players ---
  // Not every squad fields a full four, so anything from 2 to 4 is accepted.
  var playerCount = (payload.members && Object.prototype.toString.call(payload.members) === '[object Array]')
    ? payload.members.length
    : -1;
  if (playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    return {
      ok: false,
      error: 'Enter between ' + MIN_PLAYERS + ' and ' + MAX_PLAYERS + ' players.'
    };
  }

  var members = [];
  for (var i = 0; i < playerCount; i++) {
    var member = payload.members[i];
    if (!member || typeof member !== 'object') {
      return { ok: false, error: 'Player ' + (i + 1) + ' details are missing.' };
    }

    var name = cleanText_(member.name);
    if (!name) {
      return { ok: false, error: 'Player ' + (i + 1) + ' name is required.' };
    }
    if (name.length < 2 || name.length > 50) {
      return { ok: false, error: 'Player ' + (i + 1) + ' name must be between 2 and 50 characters.' };
    }
    if (hasMarkup_(name)) {
      return { ok: false, error: 'Player ' + (i + 1) + ' name contains characters that are not allowed.' };
    }

    // Players 1 and 2 must give a 10-digit WhatsApp number.
    var whatsapp = '';
    if (i < 2) {
      whatsapp = cleanText_(member.whatsapp).replace(/\D/g, '');
      if (!/^\d{10}$/.test(whatsapp)) {
        return { ok: false, error: 'Player ' + (i + 1) + ' WhatsApp number must be exactly 10 digits.' };
      }
      if (/^0{10}$/.test(whatsapp)) {
        return { ok: false, error: 'Player ' + (i + 1) + ' WhatsApp number is not valid.' };
      }
    }

    members.push({ name: name, whatsapp: whatsapp });
  }

  // The two contact numbers must differ. A shared number is almost always a
  // typo, and it leaves the organisers with only one reachable person.
  if (members[0].whatsapp === members[1].whatsapp) {
    return {
      ok: false,
      error: 'Player 1 and Player 2 cannot use the same WhatsApp number.'
    };
  }

  // --- WhatsApp consent -------------------------------------------------
  // Optional and opt-in. Only a literal true counts, so a missing field, a
  // string "true" from a hand-made request, or an unchecked box are all NO.
  // The timestamp is kept so an organiser can show when consent was given.
  var consent = payload.whatsappConsent === true;

  return {
    ok: true,
    value: {
      teamName: teamName,
      department: department,
      members: members,
      whatsappConsent: consent,
      consentAt: consent ? new Date() : ''
    }
  };
}

function cleanText_(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function hasMarkup_(value) {
  return /[<>]|&lt;|&gt;|%3C|%3E|javascript:/i.test(value);
}

function messageOf_(error) {
  if (!error) return 'unknown error';
  return error.message ? error.message : String(error);
}


/* ================================================================
   SHEET ACCESS
   ================================================================ */

function getSheet_() {
  var spreadsheet;

  if (CONFIG.SHEET_ID) {
    spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  } else {
    spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  }

  if (!spreadsheet) {
    throw new Error('No spreadsheet found. Open this script from Extensions > Apps Script inside your Google Sheet.');
  }

  var sheet = spreadsheet.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(CONFIG.SHEET_NAME);
  }

  return sheet;
}

/** Writes the header row if it is missing or does not match HEADERS. */
function ensureHeaders_(sheet) {
  var width = HEADERS.length;

  // Make sure the sheet is wide enough before writing.
  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }

  var neededColumns = sheet.getMaxColumns();

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, width).setValues([HEADERS]);
    applySheetFormatting_(sheet);
    return;
  }

  var current = sheet.getRange(1, 1, 1, width).getValues()[0];
  var matches = true;

  for (var i = 0; i < width; i++) {
    if (cleanText_(current[i]) !== HEADERS[i]) { matches = false; break; }
  }

  if (!matches) {
    sheet.getRange(1, 1, 1, width).setValues([HEADERS]);
  }

  // Clear leftover header labels from older versions of this script.
  if (neededColumns > width) {
    var leftovers = sheet.getRange(1, width + 1, 1, neededColumns - width).getValues()[0];
    var hasLeftover = leftovers.some(function (value) { return cleanText_(value) !== ''; });
    if (hasLeftover) {
      sheet.getRange(1, width + 1, 1, neededColumns - width).clearContent();
    }
  }

  ensureFormattingApplied_(sheet);
}

function countTeams_(sheet) {
  return Math.max(sheet.getLastRow() - 1, 0);
}

/** True when the same team name was already submitted today. */
function hasTeamRegisteredToday_(sheet, teamName) {
  var rows = countTeams_(sheet);
  if (rows === 0) return false;

  var names = sheet.getRange(2, COL.TEAM, rows, 1).getValues();
  var stamps = sheet.getRange(2, COL.TIMESTAMP, rows, 1).getValues();
  var today = dayKey_(new Date());
  var target = teamName.toLowerCase();

  for (var i = 0; i < rows; i++) {
    if (cleanText_(names[i][0]).toLowerCase() !== target) continue;

    var stamp = stamps[i][0];
    if (Object.prototype.toString.call(stamp) === '[object Date]' && dayKey_(stamp) === today) {
      return true;
    }
  }

  return false;
}

function dayKey_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Appends one registration row and returns its row number. */
function appendRegistration_(sheet, registration) {
  var members = registration.members;

  var row = [
    new Date(),
    registration.teamName,
    registration.department,
    members[0].name, members[0].whatsapp,
    members[1].name, members[1].whatsapp,
    // A short-handed squad simply leaves the later columns empty.
    members[2] ? members[2].name : '',
    members[3] ? members[3].name : '',
    'PENDING',
    '',
    registration.whatsappConsent ? 'YES' : 'NO',
    registration.consentAt || ''
  ];

  var target = sheet.getLastRow() + 1;

  // Set the timestamp format FIRST, so the Date is never stored as text.
  sheet.getRange(target, COL.TIMESTAMP).setNumberFormat('dd mmm yyyy, hh:mm AM/PM');
  sheet.getRange(target, 1, 1, HEADERS.length).setValues([row]);

  return target;
}

function notifyOrganizer_(registration, rowNumber) {
  if (!CONFIG.ORGANIZER_EMAIL) return;

  try {
    var lines = registration.members.map(function (member, index) {
      var phone = member.whatsapp ? ' | WhatsApp: ' + member.whatsapp : '';
      return 'Player ' + (index + 1) + ': ' + member.name + phone;
    });

    var body = [
      'New Free Fire Tournament Registration',
      '',
      'Team: ' + registration.teamName,
      'Department: ' + registration.department,
      'Sheet row: ' + rowNumber,
      '',
      lines.join('\n')
    ].join('\n');

    MailApp.sendEmail(
      CONFIG.ORGANIZER_EMAIL,
      'New Free Fire Team: ' + registration.teamName,
      body
    );
  } catch (error) {
    // A failed email must never fail the registration itself.
    console.error('Email notification failed: ' + messageOf_(error));
  }
}


/* ================================================================
   LIVE COUNTERS
   ================================================================ */

function collectStats_(sheet) {
  var rows = countTeams_(sheet);
  var teams = 0;
  var players = 0;
  var byDepartment = {};
  var lastRegistration = '';
  var lastStamp = null;

  if (rows > 0) {
    var width = Math.min(HEADERS.length, sheet.getMaxColumns());
    var values = sheet.getRange(2, 1, rows, width).getValues();

    for (var i = 0; i < values.length; i++) {
      var row = values[i];

      // A rejected team keeps its row as evidence but must not inflate the
      // public board, so it is excluded here and only counted for the organiser.
      if (normaliseStatus_(row[COL.STATUS - 1]) === 'REJECTED') continue;

      teams++;

      for (var n = 0; n < NAME_COLUMNS.length; n++) {
        var column = NAME_COLUMNS[n];
        if (column <= width && cleanText_(row[column - 1]) !== '') players++;
      }

      var department = cleanText_(row[COL.DEPARTMENT - 1]);
      if (department) {
        byDepartment[department] = (byDepartment[department] || 0) + 1;
      }

      lastStamp = row[COL.TIMESTAMP - 1];
    }

    if (Object.prototype.toString.call(lastStamp) === '[object Date]') {
      // NOTE: the am/pm marker must be a lowercase 'a'. SimpleDateFormat treats
      // every unquoted letter as a pattern letter, so 'AM/PM' throws
      // "Invalid argument" and took the whole stats response down with it.
      lastRegistration = Utilities.formatDate(
        lastStamp, Session.getScriptTimeZone(), 'dd MMM, hh:mm a'
      );
    }
  }

  return {
    teams: teams,
    players: players,
    departments: Object.keys(byDepartment).length,
    byDepartment: byDepartment,
    lastRegistration: lastRegistration
  };
}


/* ================================================================
   SHEET FORMATTING
   Every function here is safe to run again at any time.
   ================================================================ */

function ensureFormattingApplied_(sheet) {
  // Formatting is a convenience: if anything here fails, a registration
  // must still go through untouched.
  try {
    var properties = PropertiesService.getDocumentProperties();

    if (properties.getProperty(PROP_FORMATTED) === 'yes') return;

    applySheetFormatting_(sheet);
    properties.setProperty(PROP_FORMATTED, 'yes');
  } catch (error) {
    console.error('Sheet formatting skipped: ' + messageOf_(error));
  }
}

/** Full styling pass: header, columns, widths, colours, validation. */
function applySheetFormatting_(sheet) {
  var width = HEADERS.length;

  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }

  // --- Header row ---
  var header = sheet.getRange(1, 1, 1, width);
  header
    .setValues([HEADERS])
    .setBackground(THEME.headerBg)
    .setFontColor(THEME.headerText)
    .setFontWeight('bold')
    .setFontSize(10)
    .setVerticalAlignment('middle')
    .setHorizontalAlignment('left')
    .setWrap(false);
  // A single hairline in the brand colour does the branding that neon text used
  // to shout, and keeps the header readable when this sheet is printed.
  header.setBorder(null, null, true, null, null, null,
    THEME.headerRule, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.setRowHeight(1, 36);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);
  sheet.setTabColor(THEME.tab);

  // --- Column widths ---
  for (var i = 0; i < width; i++) {
    sheet.setColumnWidth(i + 1, COLUMN_WIDTHS[i]);
  }

  // --- Body formatting across the whole working area ---
  var bodyRows = Math.max(sheet.getMaxRows() - 1, 1);
  var body = sheet.getRange(2, 1, bodyRows, width);

  body.setVerticalAlignment('middle');
  body.setFontSize(10);
  body.setFontColor(THEME.bodyText);
  body.setNumberFormat('@');

  // Timestamps read like a real date, names read like names.
  sheet.getRange(2, COL.TIMESTAMP, bodyRows, 1).setNumberFormat('dd mmm yyyy, hh:mm AM/PM');
  sheet.getRange(2, COL.TIMESTAMP, bodyRows, 1).setHorizontalAlignment('left');
  sheet.getRange(2, COL.TEAM, bodyRows, 1).setFontWeight('bold');
  sheet.getRange(2, COL.DEPARTMENT, bodyRows, 1).setWrap(true);

  // The department dropdown is installed by refreshBodyStyles_, which also runs
  // on every registration, so its range always matches the registered rows.

  // --- Highlight a WhatsApp number that appears in more than one team ---
  applyDuplicateRules_(sheet, width);

  // --- Row stripes, borders and the department dropdown ---
  refreshBodyStyles_(sheet);
}

/** Alternating row colours + light separators, applied only to real data rows. */
function refreshBodyStyles_(sheet) {
  var rows = countTeams_(sheet);

  // Called before the early return so an emptied sheet still loses stale arrows.
  refreshDepartmentDropdown_(sheet);

  if (rows === 0) return;

  var width = HEADERS.length;
  var backgrounds = [];

  for (var r = 0; r < rows; r++) {
    var colour = (r % 2 === 0) ? THEME.rowEven : THEME.rowOdd;
    var line = [];
    for (var c = 0; c < width; c++) line.push(colour);
    backgrounds.push(line);
  }

  var range = sheet.getRange(2, 1, rows, width);
  range.setBackgrounds(backgrounds);
  range.setBorder(null, null, true, null, true, null, THEME.border, SpreadsheetApp.BorderStyle.SOLID);
}

/**
 * Keeps the department dropdown on the registered rows and nowhere else.
 * A validated blank cell draws a small dropdown arrow, so covering the whole
 * column stamped hundreds of arrows onto empty rows and made a tidy record look
 * broken. Runs on every write, so the range always tracks the real data.
 */
function refreshDepartmentDropdown_(sheet) {
  var bodyRows = Math.max(sheet.getMaxRows() - 1, 1);
  var dataRows = Math.min(Math.max(countTeams_(sheet), 0), bodyRows);

  if (dataRows > 0) {
    var departmentRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(DEPARTMENTS, true)
      .setAllowInvalid(true)
      .setHelpText('Pick a department from the list.')
      .build();
    sheet.getRange(2, COL.DEPARTMENT, dataRows, 1).setDataValidation(departmentRule);
  }

  // Drop any arrows a previous run (or the old script) left on empty rows.
  var staleRows = bodyRows - dataRows;
  if (staleRows > 0) {
    sheet.getRange(2 + dataRows, COL.DEPARTMENT, staleRows, 1).clearDataValidations();
  }
}

function applyDuplicateRules_(sheet, width) {
  var rows = Math.max(sheet.getMaxRows() - 1, 1);
  var rules = [];

  // Same number inside the Player 1 WhatsApp column, or between the two.
  var firstRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(
      '=AND($' + columnLetter_(COL.P1_WA) + '2<>"",' +
      'COUNTIF($' + columnLetter_(COL.P1_WA) + '$2:$' + columnLetter_(COL.P1_WA) + ',$' + columnLetter_(COL.P1_WA) + '2)+' +
      'COUNTIF($' + columnLetter_(COL.P2_WA) + '$2:$' + columnLetter_(COL.P2_WA) + ',$' + columnLetter_(COL.P1_WA) + '2)>1)'
    )
    .setBackground(THEME.duplicateBg)
    .setFontColor(THEME.duplicateText)
    .setRanges([sheet.getRange(2, COL.P1_WA, rows, 1)])
    .build();
  rules.push(firstRule);

  var secondRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(
      '=AND($' + columnLetter_(COL.P2_WA) + '2<>"",' +
      'COUNTIF($' + columnLetter_(COL.P1_WA) + '$2:$' + columnLetter_(COL.P1_WA) + ',$' + columnLetter_(COL.P2_WA) + '2)+' +
      'COUNTIF($' + columnLetter_(COL.P2_WA) + '$2:$' + columnLetter_(COL.P2_WA) + ',$' + columnLetter_(COL.P2_WA) + '2)>1)'
    )
    .setBackground(THEME.duplicateBg)
    .setFontColor(THEME.duplicateText)
    .setRanges([sheet.getRange(2, COL.P2_WA, rows, 1)])
    .build();
  rules.push(secondRule);

  sheet.setConditionalFormatRules(rules);
}

function columnLetter_(columnNumber) {
  var letter = '';
  var number = columnNumber;

  while (number > 0) {
    var remainder = (number - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    number = Math.floor((number - 1) / 26);
  }

  return letter;
}


/* ================================================================
   SHEET MENU
   Reload the sheet after installing this script to see the menu.
   ================================================================ */

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Tournament')
      .addItem('Apply sheet formatting', 'menuApplyFormatting')
      .addItem('Show registration stats', 'menuShowStats')
      .addItem('Repair header row', 'menuRepairHeader')
      .addSeparator()
      .addItem('Clear stats cache', 'menuClearCache')
      .addToUi();
  } catch (error) {
    // Running onOpen outside a spreadsheet UI context is harmless.
    console.log('Menu not created: ' + messageOf_(error));
  }
}

function menuApplyFormatting() {
  var sheet = getSheet_();
  applySheetFormatting_(sheet);
  PropertiesService.getDocumentProperties().setProperty(PROP_FORMATTED, 'yes');
  showAlert_('Formatting applied', 'The "' + CONFIG.SHEET_NAME + '" sheet now uses the tournament layout.');
}

function menuRepairHeader() {
  var sheet = getSheet_();
  ensureHeaders_(sheet);
  applySheetFormatting_(sheet);
  showAlert_('Header repaired', 'The header row was rebuilt and the sheet was re-formatted.');
}

function menuShowStats() {
  var stats = getStats_();
  var lines = [
    'Teams registered: ' + stats.teams,
    'Players registered: ' + stats.players,
    'Departments represented: ' + stats.departments,
    'Last entry: ' + (stats.lastRegistration || 'none yet')
  ];

  if (CONFIG.MAX_TEAMS > 0) {
    lines.push('Slots left: ' + stats.slotsLeft + ' of ' + CONFIG.MAX_TEAMS);
  }

  var departments = Object.keys(stats.byDepartment || {});
  if (departments.length) {
    lines.push('');
    lines.push('By department:');
    departments
      .sort(function (a, b) { return stats.byDepartment[b] - stats.byDepartment[a]; })
      .forEach(function (name) { lines.push('  • ' + name + ': ' + stats.byDepartment[name]); });
  }

  showAlert_('Tournament stats', lines.join('\n'));
}

function menuClearCache() {
  clearStatsCache_();
  showAlert_('Cache cleared', 'The website counters will refresh on the next page load.');
}

function showAlert_(title, message) {
  try {
    SpreadsheetApp.getUi().alert(title, message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (error) {
    console.log(title + ': ' + message);
  }
}


/* ================================================================
   ONE-TIME SETUP HELPER
   Run this from the Apps Script editor if you ever want to rebuild
   the sheet layout from scratch.
   ================================================================ */

function setupSheet() {
  var sheet = getSheet_();
  ensureHeaders_(sheet);
  applySheetFormatting_(sheet);
  PropertiesService.getDocumentProperties().setProperty(PROP_FORMATTED, 'yes');
  clearStatsCache_();
  console.log('Sheet layout is ready.');
}


/* ================================================================
   ADMIN DASHBOARD API
   ----------------------------------------------------------------
   Everything in this section is reachable only through
   POST ?action=admin with a JSON body, and every call is authorised
   on the server before any sheet data is read. The dashboard key
   lives in Script Properties -- it is not in this file, not in the
   website, and not in the repository.

   A caller can never name a row: records are addressed by a hash of
   their timestamp and team name, which is recomputed here and
   matched against the sheet. Unknown ids simply do not match.
   ================================================================ */

var STATUS_DEFAULT = 'PENDING';
var ADMIN_FAILS_KEY = 'qqsgp_admin_fails';
var ADMIN_LOCK_KEY = 'qqsgp_admin_lock';

/** Blank (older rows) is a pending entry; anything unknown is treated the same. */
function normaliseStatus_(value) {
  var status = cleanText_(value).toUpperCase();
  return STATUSES.indexOf(status) === -1 ? STATUS_DEFAULT : status;
}

function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

/** Opaque, stable record id. One-way: it reveals nothing about the row. */
function recordId_(stamp, teamName) {
  var base = (isDate_(stamp) ? String(stamp.getTime()) : cleanText_(stamp)) + '|' + cleanText_(teamName);
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, base);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '').slice(0, 22);
}

/* ---------------------------- authorisation ---------------------------- */

function constantTimeEquals_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Deny by default. No key configured means no dashboard for anyone.
 * Repeated wrong keys lock the endpoint for a while, so guessing is slow.
 */
function adminAuthorized_(key) {
  var expected = '';
  try {
    expected = PropertiesService.getScriptProperties().getProperty(CONFIG.ADMIN_KEY_PROPERTY) || '';
  } catch (ignored) {
    expected = '';
  }
  if (expected.length < 20) return false;

  var cache = CacheService.getScriptCache();
  if (cache.get(ADMIN_LOCK_KEY) === '1') return false;
  if (typeof key !== 'string' || key.length === 0) return false;

  if (!constantTimeEquals_(key, expected)) {
    var fails = Number(cache.get(ADMIN_FAILS_KEY) || 0) + 1;
    cache.put(ADMIN_FAILS_KEY, String(fails), CONFIG.ADMIN_LOCK_SECONDS);
    if (fails >= CONFIG.ADMIN_MAX_FAILS) {
      cache.put(ADMIN_LOCK_KEY, '1', CONFIG.ADMIN_LOCK_SECONDS);
    }
    return false;
  }

  cache.remove(ADMIN_FAILS_KEY);
  return true;
}

/* ------------------------------ records ------------------------------ */

function adminSheet_() {
  var sheet = getSheet_();
  ensureHeaders_(sheet);
  return sheet;
}

function recordFromRow_(rowNumber, row) {
  var stamp = row[COL.TIMESTAMP - 1];
  var teamName = cleanText_(row[COL.TEAM - 1]);
  var players = [];

  for (var n = 0; n < NAME_COLUMNS.length; n++) {
    var name = cleanText_(row[NAME_COLUMNS[n] - 1]);
    if (!name) continue;
    players.push({
      name: name,
      whatsapp: n < PHONE_COLUMNS.length ? cleanText_(row[PHONE_COLUMNS[n] - 1]) : ''
    });
  }

  return {
    id: recordId_(stamp, teamName),
    row: rowNumber,
    timestamp: isDate_(stamp) ? stamp.toISOString() : '',
    timestampLabel: isDate_(stamp)
      ? Utilities.formatDate(stamp, Session.getScriptTimeZone(), 'dd MMM yyyy, hh:mm a')
      : cleanText_(stamp),
    teamName: teamName,
    department: cleanText_(row[COL.DEPARTMENT - 1]),
    players: players,
    playerCount: players.length,
    status: normaliseStatus_(row[COL.STATUS - 1]),
    note: cleanText_(row[COL.NOTE - 1]),
    // Blank on rows that predate the consent column, which reads as "no".
    whatsappConsent: cleanText_(row[COL.CONSENT - 1]).toUpperCase() === 'YES',
    consentAt: isDate_(row[COL.CONSENT_AT - 1]) ? row[COL.CONSENT_AT - 1].toISOString() : ''
  };
}

function readRecords_(sheet) {
  var rows = countTeams_(sheet);
  if (rows === 0) return [];

  var width = HEADERS.length;
  var values = sheet.getRange(2, 1, rows, width).getValues();
  var records = [];

  for (var i = 0; i < values.length; i++) {
    records.push(recordFromRow_(i + 2, values[i]));
  }

  return records;
}

function adminCounts_(records) {
  var counts = { total: 0, players: 0, PENDING: 0, APPROVED: 0, REJECTED: 0, WAITLISTED: 0 };

  for (var i = 0; i < records.length; i++) {
    counts.total++;
    counts.players += records[i].playerCount;
    counts[records[i].status] = (counts[records[i].status] || 0) + 1;
  }

  return counts;
}

function filterRecords_(records, payload) {
  var status = cleanText_(payload.status).toUpperCase();
  var department = cleanText_(payload.department);
  var query = cleanText_(payload.q).toLowerCase();

  return records.filter(function (record) {
    if (status && status !== 'ALL' && record.status !== status) return false;
    if (department && record.department !== department) return false;
    if (!query) return true;

    if (record.teamName.toLowerCase().indexOf(query) !== -1) return true;
    if (record.department.toLowerCase().indexOf(query) !== -1) return true;
    if (record.id.toLowerCase().indexOf(query) !== -1) return true;

    for (var i = 0; i < record.players.length; i++) {
      if (record.players[i].name.toLowerCase().indexOf(query) !== -1) return true;
    }

    return false;
  });
}

function uniqueDepartments_(records) {
  var seen = {};
  var list = [];

  for (var i = 0; i < records.length; i++) {
    var name = records[i].department;
    if (!name || seen[name]) continue;
    seen[name] = true;
    list.push(name);
  }

  list.sort();
  return list;
}

/* ------------------------------ actions ------------------------------ */

function adminHandle_(e) {
  var body = readBody_(e);
  if (!body.ok) return { ok: false, code: 'BODY', error: body.error };

  var payload = body.value || {};
  if (!payload || typeof payload !== 'object') {
    return { ok: false, code: 'BODY', error: 'The submitted data is not valid.' };
  }

  if (!adminAuthorized_(payload.key)) {
    return { ok: false, code: 'AUTH', error: 'Wrong or missing dashboard key.' };
  }

  var action = cleanText_(payload.action);
  if (action === 'list') return adminList_(payload);
  if (action === 'status') return adminSetStatus_(payload);
  if (action === 'note') return adminSaveNote_(payload);
  if (action === 'export') return adminExport_(payload);

  // WhatsApp: configuration, log, retry, and announcements.
  if (action === 'notif-config') return adminNotifConfig_();
  if (action === 'notif-list') return adminNotifList_(payload);
  if (action === 'notif-retry') return adminNotifRetry_(payload);
  if (action === 'announce-preview') return adminAnnouncePreview_(payload);
  if (action === 'announce-send') return adminAnnounceSend_(payload);

  return { ok: false, code: 'ACTION', error: 'Unknown dashboard action.' };
}

function adminList_(payload) {
  var sheet = adminSheet_();
  var all = readRecords_(sheet);
  var filtered = filterRecords_(all, payload);

  // Newest first, so the team that just registered is the one on top.
  filtered.sort(function (a, b) {
    if (!a.timestamp || !b.timestamp) return b.row - a.row;
    return a.timestamp < b.timestamp ? 1 : (a.timestamp > b.timestamp ? -1 : b.row - a.row);
  });

  var pageSize = Math.min(Math.max(Number(payload.pageSize) || CONFIG.ADMIN_PAGE_SIZE, 1), 100);
  var page = Math.max(Number(payload.page) || 1, 1);
  var start = (page - 1) * pageSize;

  return {
    ok: true,
    records: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page: page,
    pageSize: pageSize,
    counts: adminCounts_(all),
    departments: uniqueDepartments_(all),
    generatedAt: new Date().toISOString()
  };
}

/** Shared path for status and note changes: lookup, staleness check, write. */
function adminUpdate_(payload, change) {
  var id = cleanText_(payload.id);
  if (!/^[A-Za-z0-9_-]{10,44}$/.test(id)) {
    return { ok: false, code: 'ID', error: 'Unknown registration.' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { ok: false, code: 'BUSY', error: 'The sheet is busy. Try again in a moment.' };
  }

  try {
    var sheet = adminSheet_();
    var rows = countTeams_(sheet);
    if (rows === 0) return { ok: false, code: 'ID', error: 'That registration no longer exists.' };

    var width = HEADERS.length;
    var values = sheet.getRange(2, 1, rows, width).getValues();
    var targetRow = -1;

    for (var i = 0; i < values.length; i++) {
      var candidate = recordId_(values[i][COL.TIMESTAMP - 1], cleanText_(values[i][COL.TEAM - 1]));
      if (candidate === id) { targetRow = i + 2; break; }
    }

    if (targetRow === -1) {
      return { ok: false, code: 'ID', error: 'That registration no longer exists.' };
    }

    var current = recordFromRow_(targetRow, values[targetRow - 2]);
    var expected = cleanText_(payload.expectedStatus).toUpperCase();
    if (expected && current.status !== expected) {
      return {
        ok: false,
        code: 'STALE',
        error: 'This team was changed somewhere else. Reload and try again.',
        record: current
      };
    }

    change(sheet, targetRow, current);
    clearStatsCache_();

    var after = sheet.getRange(targetRow, 1, 1, width).getValues()[0];
    var fresh = recordFromRow_(targetRow, after);

    return { ok: true, record: fresh, counts: adminCounts_(readRecords_(sheet)) };
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function adminSetStatus_(payload) {
  var status = cleanText_(payload.status).toUpperCase();
  if (STATUSES.indexOf(status) === -1) {
    return { ok: false, code: 'STATUS', error: 'Unknown status.' };
  }

  var result = adminUpdate_(payload, function (sheet, rowNumber) {
    sheet.getRange(rowNumber, COL.STATUS).setValue(status);
  });

  if (!result.ok) return result;

  // The status is already saved at this point. A WhatsApp failure below is
  // reported, never rolled back, and never turned into a failed status change.
  result.notification = queueStatusNotification_(result.record, status);
  return result;
}

function adminSaveNote_(payload) {
  var note = cleanText_(payload.note);

  if (note.length > CONFIG.ADMIN_NOTE_LIMIT) {
    return { ok: false, code: 'NOTE', error: 'Note must be ' + CONFIG.ADMIN_NOTE_LIMIT + ' characters or fewer.' };
  }
  if (hasMarkup_(note)) {
    return { ok: false, code: 'NOTE', error: 'Note contains characters that are not allowed.' };
  }

  return adminUpdate_(payload, function (sheet, rowNumber) {
    sheet.getRange(rowNumber, COL.NOTE).setValue(note);
  });
}

function csvCell_(value) {
  var text = cleanText_(value);
  if (/[",\n\r]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

function adminExport_(payload) {
  var sheet = adminSheet_();
  var records = filterRecords_(readRecords_(sheet), payload);

  var lines = [[
    'Timestamp', 'Team Name', 'Department',
    'Player 1', 'Player 1 WhatsApp', 'Player 2', 'Player 2 WhatsApp',
    'Player 3', 'Player 4', 'Status', 'Note', 'Record ID'
  ].map(csvCell_).join(',')];

  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var players = [];
    for (var n = 0; n < 4; n++) players.push(r.players[n] ? r.players[n].name : '');

    lines.push([
      r.timestampLabel,
      r.teamName,
      r.department,
      players[0],
      r.players[0] ? r.players[0].whatsapp : '',
      players[1],
      r.players[1] ? r.players[1].whatsapp : '',
      players[2],
      players[3],
      r.status,
      r.note,
      r.id
    ].map(csvCell_).join(','));
  }

  return {
    ok: true,
    filename: 'qqsgp-registrations-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd-HHmm') + '.csv',
    csv: lines.join('\r\n'),
    total: records.length
  };
}

/* --------------------------- setup helpers --------------------------- */

/**
 * Run this ONCE from the Apps Script editor. It creates the dashboard key and
 * prints it to the execution log. Copy the key into the dashboard when it asks.
 * Running it again invalidates the previous key.
 */
function setupAdminKey() {
  var key = (Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  PropertiesService.getScriptProperties().setProperty(CONFIG.ADMIN_KEY_PROPERTY, key);

  try {
    var cache = CacheService.getScriptCache();
    cache.remove(ADMIN_LOCK_KEY);
    cache.remove(ADMIN_FAILS_KEY);
  } catch (ignored) {}

  console.log('Dashboard key created. Paste it into admin.html once and keep it private:\n' + key);
  return key;
}

/** Confirms the key exists, without ever printing it. */
function adminStatus() {
  var key = PropertiesService.getScriptProperties().getProperty(CONFIG.ADMIN_KEY_PROPERTY) || '';
  console.log(key.length >= 20
    ? 'Dashboard key is configured (' + key.length + ' characters).'
    : 'No dashboard key yet. Run setupAdminKey() first.');
}

/* ================================================================
   WHATSAPP NOTIFICATIONS  (optional module)
   ----------------------------------------------------------------
   Official WhatsApp Business Cloud API only. Nothing here touches
   WhatsApp Web, a browser session or an unofficial bridge.

   Every credential is read from Script Properties at call time and
   is never written into a response, a sheet cell or a log line.
   The names are listed in WHATSAPP.md.

   Shape of the flow:
     status saved in the sheet
       -> notification row created (deterministic id = no duplicates)
       -> message submitted to Meta
       -> provider message id + delivery state stored
       -> webhook events move SENT -> DELIVERED -> READ
   A WhatsApp failure never changes a team's status. A status change
   that failed to save never sends anything.
   ================================================================ */

/* Script Property names. Values are never printed or returned. */
var WA_PROP = {
  TOKEN: 'whatsapp_token',
  PHONE_ID: 'whatsapp_phone_number_id',
  API_VERSION: 'whatsapp_api_version',
  VERIFY_TOKEN: 'whatsapp_verify_token',
  ENABLED: 'whatsapp_enabled',
  MODE: 'whatsapp_mode',
  LANGUAGE: 'whatsapp_template_lang',
  TEMPLATE_PREFIX: 'whatsapp_template_prefix',
  RECEIPT: 'whatsapp_send_receipt',
  TEST_NUMBER: 'whatsapp_test_number'
};

var NOTIF_HEADERS = [
  'Notification ID', 'Created', 'Registration ID', 'Team Name', 'Recipient',
  'Type', 'Template', 'Related Status', 'Body', 'Provider Message ID',
  'Delivery Status', 'Attempts', 'Last Attempt', 'Error', 'Updated'
];

var NOTIF_COL = {
  ID: 1, CREATED: 2, REGISTRATION: 3, TEAM: 4, RECIPIENT: 5, TYPE: 6,
  TEMPLATE: 7, RELATED: 8, BODY: 9, PROVIDER: 10, STATE: 11,
  ATTEMPTS: 12, LAST: 13, ERROR: 14, UPDATED: 15
};

/* Statuses a notification row can hold. Delivered/read only ever come from a
   webhook event; nothing here guesses that a message was delivered. */
var NOTIF_STATES = ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNCERTAIN', 'SKIPPED'];

var STATE_RANK = { SENT: 1, DELIVERED: 2, READ: 3 };

/* Which notification a status change produces. PENDING produces none. */
var STATUS_NOTIFICATION = {
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  WAITLISTED: 'WAITLISTED'
};

/* Template variables in order. The approved template must declare the same
   number of placeholders; WHATSAPP.md carries the exact body to submit. */
var WA_VARS = {
  REGISTRATION_RECEIVED: ['leader', 'team', 'id'],
  APPROVED: ['leader', 'team', 'id'],
  REJECTED: ['leader', 'team', 'id'],
  WAITLISTED: ['leader', 'team', 'id'],
  ANNOUNCEMENT: ['leader', 'team', 'message']
};

var WA_TEMPLATE_SUFFIX = {
  REGISTRATION_RECEIVED: 'registration_received',
  APPROVED: 'team_approved',
  REJECTED: 'team_rejected',
  WAITLISTED: 'team_waitlisted',
  ANNOUNCEMENT: 'announcement'
};

var WA_TYPE_LABEL = {
  REGISTRATION_RECEIVED: 'Registration received',
  APPROVED: 'Team approved',
  REJECTED: 'Team rejected',
  WAITLISTED: 'Team waitlisted',
  ANNOUNCEMENT: 'Announcement'
};

/* Fallback wording, used for text mode and stored as the audit body. */
function waText_(type, record, message) {
  var leader = leaderOf_(record);
  var name = leader.name || 'there';
  var team = record.teamName || 'your team';
  var id = record.id || '';
  var idLine = id ? ' Registration ID: ' + id + '.' : '';

  if (type === 'APPROVED') {
    return 'Hello ' + name + ', congratulations! Your team ' + team +
      ' has been approved for the QQSGP Free Fire Championship.' + idLine +
      ' Watch for match schedules and reporting instructions. ' +
      '- QQSGP Tournament Organizers';
  }
  if (type === 'REJECTED') {
    return 'Hello ' + name + ', the registration status of your team ' + team +
      ' for the QQSGP Free Fire Championship has been updated.' + idLine +
      ' Please contact the tournament organizers if you need clarification. ' +
      '- QQSGP Tournament Organizers';
  }
  if (type === 'WAITLISTED') {
    return 'Hello ' + name + ', your team ' + team +
      ' has been placed on the waiting list for the QQSGP Free Fire Championship.' + idLine +
      ' We will notify you if your registration status changes. ' +
      '- QQSGP Tournament Organizers';
  }
  if (type === 'ANNOUNCEMENT') {
    return 'Hello ' + name + ', an important QQSGP Free Fire Championship ' +
      'announcement for your team ' + team + ': ' + message + '. ' +
      '- QQSGP Tournament Organizers';
  }
  return 'Hello ' + name + ', your team ' + team +
    ' is registered for the QQSGP Free Fire Championship.' + idLine +
    ' We will message you once the organizers review it. ' +
    '- QQSGP Tournament Organizers';
}

/* ------------------------------ config ------------------------------ */

function waProp_(name, fallback) {
  var value = '';
  try {
    value = PropertiesService.getScriptProperties().getProperty(name) || '';
  } catch (ignored) {
    value = '';
  }
  value = String(value).trim();
  return value === '' ? (fallback === undefined ? '' : fallback) : value;
}

function waConfig_() {
  var token = waProp_(WA_PROP.TOKEN);
  var phoneId = waProp_(WA_PROP.PHONE_ID);
  var enabled = waProp_(WA_PROP.ENABLED).toLowerCase();
  var mode = waProp_(WA_PROP.MODE, 'template').toLowerCase();
  var on = enabled === 'yes' || enabled === 'true';

  return {
    token: token,
    phoneId: phoneId,
    version: waProp_(WA_PROP.API_VERSION, 'v21.0'),
    language: waProp_(WA_PROP.LANGUAGE, 'en'),
    prefix: waProp_(WA_PROP.TEMPLATE_PREFIX, 'qqsgp'),
    verifyToken: waProp_(WA_PROP.VERIFY_TOKEN),
    // Opt-in on/off switch, so the module can be installed before the account
    // is ready and switched on with one property.
    enabled: on,
    mode: mode === 'text' ? 'text' : 'template',
    sendReceipt: waProp_(WA_PROP.RECEIPT).toLowerCase() === 'yes',
    configured: token !== '' && phoneId !== '' && on
  };
}

function waTemplateName_(type) {
  var override = waProp_('whatsapp_tpl_' + type.toLowerCase());
  if (override) return override;
  var cfg = waConfig_();
  return cfg.prefix + '_' + (WA_TEMPLATE_SUFFIX[type] || 'message');
}

/* ------------------------------ helpers ----------------------------- */

function leaderOf_(record) {
  if (record && record.players && record.players.length) return record.players[0];
  return { name: '', whatsapp: '' };
}

/** Digits only, with the Indian country code added to a bare 10-digit number. */
function normalisePhone_(value) {
  var digits = String(value === null || value === undefined ? '' : value).replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  else if (digits.length === 11 && digits.charAt(0) === '0') digits = '91' + digits.slice(1);
  else if (digits.length === 12 && digits.indexOf('91') === 0) digits = digits;
  if (!/^[1-9]\d{7,14}$/.test(digits)) return '';
  return digits;
}

function shorter_(value, limit) {
  var text = cleanText_(value);
  var max = limit || 300;
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function notifId_(a, b) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(a) + '|' + String(b)
  );
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '').slice(0, 22);
}

/* --------------------------- notification log --------------------------- */

function notifSheet_() {
  var spreadsheet = CONFIG.SHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('No spreadsheet found for the notification log.');

  var sheet = spreadsheet.getSheetByName(CONFIG.NOTIF_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(CONFIG.NOTIF_SHEET_NAME);

  var width = NOTIF_HEADERS.length;
  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, width).setValues([NOTIF_HEADERS]);
    try { sheet.setFrozenRows(1); } catch (ignored) {}
  }

  return sheet;
}

function notifFromRow_(rowNumber, row) {
  var created = row[NOTIF_COL.CREATED - 1];
  var last = row[NOTIF_COL.LAST - 1];
  var updated = row[NOTIF_COL.UPDATED - 1];
  var tz = Session.getScriptTimeZone();

  function label(value) {
    if (!isDate_(value)) return cleanText_(value);
    return Utilities.formatDate(value, tz, 'dd MMM yyyy, hh:mm a');
  }

  var type = cleanText_(row[NOTIF_COL.TYPE - 1]);

  return {
    row: rowNumber,
    id: cleanText_(row[NOTIF_COL.ID - 1]),
    created: isDate_(created) ? created.toISOString() : '',
    createdLabel: label(created),
    registrationId: cleanText_(row[NOTIF_COL.REGISTRATION - 1]),
    teamName: cleanText_(row[NOTIF_COL.TEAM - 1]),
    recipient: cleanText_(row[NOTIF_COL.RECIPIENT - 1]),
    type: type,
    typeLabel: WA_TYPE_LABEL[type] || type,
    template: cleanText_(row[NOTIF_COL.TEMPLATE - 1]),
    relatedStatus: cleanText_(row[NOTIF_COL.RELATED - 1]),
    body: cleanText_(row[NOTIF_COL.BODY - 1]),
    providerMessageId: cleanText_(row[NOTIF_COL.PROVIDER - 1]),
    state: cleanText_(row[NOTIF_COL.STATE - 1]).toUpperCase() || 'QUEUED',
    attempts: Number(row[NOTIF_COL.ATTEMPTS - 1] || 0),
    // Raw ISO copy for calculations; the label is for humans.
    lastAttempt: isDate_(last) ? last.toISOString() : '',
    lastAttemptLabel: label(last),
    error: cleanText_(row[NOTIF_COL.ERROR - 1]),
    updatedLabel: label(updated)
  };
}

function readNotifications_(sheet) {
  var rows = sheet.getLastRow() - 1;
  if (rows <= 0) return [];
  var values = sheet.getRange(2, 1, rows, NOTIF_HEADERS.length).getValues();
  var list = [];
  for (var i = 0; i < values.length; i++) list.push(notifFromRow_(i + 2, values[i]));
  return list;
}

function findNotificationById_(id) {
  if (!id) return null;
  var list = readNotifications_(notifSheet_());
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function appendNotification_(n) {
  var sheet = notifSheet_();
  var row = sheet.getLastRow() + 1;

  sheet.getRange(row, NOTIF_COL.CREATED).setNumberFormat('dd mmm yyyy, hh:mm AM/PM');
  sheet.getRange(row, NOTIF_COL.LAST).setNumberFormat('dd mmm yyyy, hh:mm AM/PM');
  sheet.getRange(row, NOTIF_COL.UPDATED).setNumberFormat('dd mmm yyyy, hh:mm AM/PM');

  sheet.getRange(row, 1, 1, NOTIF_HEADERS.length).setValues([[
    n.id, n.created, n.registrationId, n.teamName, n.recipient,
    n.type, n.template, n.relatedStatus, n.body, n.providerMessageId,
    n.state, n.attempts || 0, n.lastAttempt || '', n.error || '', n.updated || n.created
  ]]);

  return row;
}

function updateNotification_(rowNumber, patch) {
  var sheet = notifSheet_();
  var fields = [
    [NOTIF_COL.PROVIDER, 'providerMessageId'],
    [NOTIF_COL.STATE, 'state'],
    [NOTIF_COL.ATTEMPTS, 'attempts'],
    [NOTIF_COL.LAST, 'lastAttempt'],
    [NOTIF_COL.ERROR, 'error'],
    [NOTIF_COL.BODY, 'body'],
    [NOTIF_COL.UPDATED, 'updated']
  ];

  for (var i = 0; i < fields.length; i++) {
    var key = fields[i][1];
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    sheet.getRange(rowNumber, fields[i][0]).setValue(patch[key]);
  }
}

/* ------------------------------- delivery ------------------------------ */

/**
 * Submits one message. Returns { state, providerMessageId, error }.
 *
 *   SENT      -> the provider accepted the request (an id came back)
 *   FAILED    -> the provider rejected it, or a 4xx/5xx answered
 *   UNCERTAIN -> the connection failed; the request may or may not have
 *                arrived. Never retried automatically.
 */
function deliverWhatsApp_(cfg, recipient, type, templateName, vars, body) {
  if (!cfg.configured) {
    return { state: 'SKIPPED', error: 'WhatsApp is not configured on the server.' };
  }

  var url = 'https://graph.facebook.com/' + cfg.version + '/' + cfg.phoneId + '/messages';
  var payload;

  if (cfg.mode === 'text') {
    // Development/testing only. Meta allows free-form text inside an open
    // 24-hour customer service window; business-initiated messages need an
    // approved template. WHATSAPP.md explains when this is acceptable.
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: { preview_url: false, body: body }
    };
  } else {
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'template',
      template: {
        name: templateName,
        language: { code: cfg.language },
        components: [{ type: 'body', parameters: (vars || []).map(function (v) {
          return { type: 'text', text: String(v) };
        }) }]
      }
    };
  }

  var response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + cfg.token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (error) {
    return {
      state: 'UNCERTAIN',
      error: shorter_('No response from the provider: ' + messageOf_(error))
    };
  }

  var code = response.getResponseCode();
  var text = response.getContentText() || '';
  var parsed = null;
  try { parsed = JSON.parse(text); } catch (ignored) { parsed = null; }

  if (code >= 200 && code < 300 && parsed && parsed.messages && parsed.messages[0] && parsed.messages[0].id) {
    return { state: 'SENT', providerMessageId: String(parsed.messages[0].id), error: '' };
  }

  var detail = 'HTTP ' + code;
  if (parsed && parsed.error) {
    detail = cleanText_(parsed.error.message || '') || detail;
    if (parsed.error.code) detail += ' (code ' + parsed.error.code + ')';
  }

  return { state: 'FAILED', error: shorter_(detail) };
}

/**
 * Creates the notification row for one team and one type, then sends it.
 * Deterministic ids mean a double click, a retry or a repeated webhook can
 * never produce a second message for the same event.
 */
function createAndSendNotification_(record, type, message, announcementId) {
  var cfg = waConfig_();

  // Not configured at all: record nothing, so the log does not fill up with
  // rows that were never eligible to send.
  if (!cfg.configured) {
    return { attempted: false, state: 'DISABLED', reason: 'WhatsApp is not configured on the server.' };
  }

  var leader = leaderOf_(record);
  var recipient = normalisePhone_(leader.whatsapp);
  var base = announcementId || (record.id + '|' + type + '|' + record.status);
  var id = notifId_(base, type === 'ANNOUNCEMENT' ? record.id : recipient);

  var existing = findNotificationById_(id);
  if (existing) {
    return {
      attempted: false, id: existing.id, state: existing.state,
      duplicate: true, providerMessageId: existing.providerMessageId, error: existing.error
    };
  }

  var templateName = waTemplateName_(type);
  var body = waText_(type, record, message || '');

  var row = {
    id: id,
    created: new Date(),
    registrationId: record.id || '',
    teamName: record.teamName || '',
    recipient: recipient,
    type: type,
    template: cfg.mode === 'text' ? 'text' : templateName,
    relatedStatus: type === 'ANNOUNCEMENT' ? '' : record.status,
    body: body,
    providerMessageId: '',
    state: 'QUEUED',
    attempts: 0,
    lastAttempt: '',
    error: '',
    updated: new Date()
  };

  if (!record.whatsappConsent) {
    row.state = 'SKIPPED';
    row.error = 'No WhatsApp consent recorded for this team.';
    appendNotification_(row);
    return { attempted: false, id: id, state: 'SKIPPED', reason: row.error };
  }

  if (!recipient) {
    row.state = 'SKIPPED';
    row.error = 'No valid WhatsApp number on the registration.';
    appendNotification_(row);
    return { attempted: false, id: id, state: 'SKIPPED', reason: row.error };
  }

  var notificationRow = appendNotification_(row);

  var vars = WA_VARS[type] ? WA_VARS[type].map(function (key) {
    if (key === 'leader') return leader.name || 'there';
    if (key === 'team') return record.teamName || 'your team';
    if (key === 'id') return record.id || '';
    return message || '';
  }) : [];

  var result = deliverWhatsApp_(cfg, recipient, type, templateName, vars, body);

  updateNotification_(notificationRow, {
    state: result.state,
    providerMessageId: result.providerMessageId || '',
    attempts: 1,
    lastAttempt: new Date(),
    error: result.error || '',
    updated: new Date()
  });

  return {
    attempted: true,
    id: id,
    row: notificationRow,
    state: result.state,
    providerMessageId: result.providerMessageId || '',
    error: result.error || '',
    body: body
  };
}

/** Called only after the status change has been written to the sheet. */
function queueStatusNotification_(record, status) {
  var type = STATUS_NOTIFICATION[status];
  if (!type) return { attempted: false, state: 'NONE' };
  try {
    return createAndSendNotification_(record, type, '', '');
  } catch (error) {
    // A broken notification must never turn a saved status change into an
    // error the organiser sees as "nothing happened".
    console.error('Notification failed: ' + messageOf_(error));
    return { attempted: false, state: 'ERROR', reason: messageOf_(error) };
  }
}

/** Optional "we received your entry" receipt. Off unless switched on. */
function maybeSendReceipt_(sheet, rowNumber) {
  var cfg = waConfig_();
  if (!cfg.configured || !cfg.sendReceipt) return null;

  try {
    var values = sheet.getRange(rowNumber, 1, 1, HEADERS.length).getValues()[0];
    var record = recordFromRow_(rowNumber, values);
    return createAndSendNotification_(record, 'REGISTRATION_RECEIVED', '', '');
  } catch (error) {
    console.error('Receipt failed: ' + messageOf_(error));
    return null;
  }
}

/* --------------------------- webhook receipts --------------------------- */

/**
 * Meta's verification handshake. Answers the raw challenge, so it cannot use
 * the JSON helper.
 */
function whatsappWebhookVerify_(e) {
  var params = (e && e.parameter) || {};
  var challenge = cleanText_(params['hub.challenge']);
  var token = String(params['hub.verify_token'] || '');
  var expected = waConfig_().verifyToken;

  var text = ContentService.createTextOutput();
  if (!expected || !constantTimeEquals_(token, expected)) {
    text.setContent('forbidden');
    return text;
  }
  text.setContent(challenge);
  return text;
}

/**
 * Delivery receipts. Apps Script does not expose request headers, so the
 * X-Hub-Signature-256 header Meta sends cannot be checked here. The endpoint is
 * instead protected by a long random token in the URL (`k`), which Meta echoes
 * back on every call, and it can only move a notification's delivery state.
 */
function whatsappWebhookEvent_(e) {
  var cfg = waConfig_();
  var params = (e && e.parameter) || {};
  var secret = cfg.verifyToken;

  if (!secret || !constantTimeEquals_(String(params.k || ''), secret)) {
    return jsonResponse_({ ok: false, error: 'Not authorised.' });
  }

  var raw = (e && e.postData && e.postData.contents) || '';
  if (!raw) return jsonResponse_({ ok: true, ignored: true });

  var payload;
  try {
    payload = JSON.parse(raw);
  } catch (ignored) {
    return jsonResponse_({ ok: false, error: 'Unreadable payload.' });
  }

  var updated = 0;
  try {
    var entries = payload.entry || [];
    for (var i = 0; i < entries.length; i++) {
      var changes = entries[i].changes || [];
      for (var c = 0; c < changes.length; c++) {
        var value = changes[c].value || {};
        var statuses = value.statuses || [];
        for (var s = 0; s < statuses.length; s++) {
          if (applyDeliveryStatus_(statuses[s])) updated++;
        }
      }
    }
  } catch (error) {
    console.error('Webhook parse failed: ' + messageOf_(error));
    return jsonResponse_({ ok: false });
  }

  return jsonResponse_({ ok: true, updated: updated });
}

function applyDeliveryStatus_(status) {
  var wamid = cleanText_(status && status.id);
  var state = cleanText_(status && status.status).toLowerCase();
  if (!wamid || !state) return false;

  var mapped = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' }[state];
  if (!mapped) return false;

  var sheet = notifSheet_();
  var list = readNotifications_(sheet);
  var target = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].providerMessageId === wamid) { target = list[i]; break; }
  }
  if (!target) return false;

  // Never walk a message backwards (a late 'delivered' must not undo 'read').
  if (STATE_RANK[target.state] && STATE_RANK[mapped] && STATE_RANK[mapped] < STATE_RANK[target.state]) {
    return false;
  }

  var error = '';
  if (mapped === 'FAILED' && status.errors && status.errors.length) {
    var first = status.errors[0] || {};
    error = shorter_((first.title || 'Delivery failed') + (first.detail ? ': ' + first.detail : ''));
  }

  updateNotification_(target.row, {
    state: mapped,
    error: error || target.error,
    updated: new Date()
  });
  return true;
}

/* ------------------------------ admin API ------------------------------ */

function adminNotifConfig_() {
  var cfg = waConfig_();
  var templates = {};
  for (var type in WA_VARS) {
    if (Object.prototype.hasOwnProperty.call(WA_VARS, type)) templates[type] = waTemplateName_(type);
  }

  return {
    ok: true,
    configured: cfg.configured,
    enabled: cfg.enabled,
    mode: cfg.mode,
    apiVersion: cfg.version,
    language: cfg.language,
    receiptEnabled: cfg.sendReceipt,
    webhookReady: cfg.verifyToken !== '',
    templates: templates,
    maxAttempts: CONFIG.WHATSAPP_MAX_ATTEMPTS,
    retryBackoffSeconds: CONFIG.WHATSAPP_RETRY_BACKOFF_SECONDS
  };
}

function adminNotifList_(payload) {
  var sheet = notifSheet_();
  var all = readNotifications_(sheet);
  var state = cleanText_(payload.state).toUpperCase();
  var type = cleanText_(payload.type).toUpperCase();
  var query = cleanText_(payload.q).toLowerCase();

  var filtered = all.filter(function (n) {
    if (state && state !== 'ALL' && n.state !== state) return false;
    if (type && type !== 'ALL' && n.type !== type) return false;
    if (!query) return true;
    return n.teamName.toLowerCase().indexOf(query) !== -1 ||
      n.recipient.indexOf(query) !== -1 ||
      n.registrationId.toLowerCase().indexOf(query) !== -1 ||
      n.body.toLowerCase().indexOf(query) !== -1;
  });

  filtered.sort(function (a, b) {
    if (!a.created || !b.created) return b.row - a.row;
    return a.created < b.created ? 1 : (a.created > b.created ? -1 : b.row - a.row);
  });

  var counts = { total: all.length, SENT: 0, DELIVERED: 0, READ: 0, FAILED: 0, UNCERTAIN: 0, SKIPPED: 0, QUEUED: 0 };
  for (var i = 0; i < all.length; i++) {
    counts[all[i].state] = (counts[all[i].state] || 0) + 1;
  }

  var pageSize = Math.min(Math.max(Number(payload.pageSize) || CONFIG.ADMIN_PAGE_SIZE, 1), 100);
  var page = Math.max(Number(payload.page) || 1, 1);
  var start = (page - 1) * pageSize;

  return {
    ok: true,
    notifications: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page: page,
    pageSize: pageSize,
    counts: counts,
    config: adminNotifConfig_()
  };
}

function adminNotifRetry_(payload) {
  var id = cleanText_(payload.id);
  if (!/^[A-Za-z0-9_-]{10,44}$/.test(id)) {
    return { ok: false, code: 'ID', error: 'Unknown notification.' };
  }

  var notification = findNotificationById_(id);
  if (!notification) return { ok: false, code: 'ID', error: 'Unknown notification.' };

  if (notification.state === 'SENT' || notification.state === 'DELIVERED' || notification.state === 'READ') {
    return { ok: false, code: 'ALREADY_SENT', error: 'This message was already accepted by the provider. It was not sent again.' };
  }
  if (notification.state === 'SKIPPED') {
    return { ok: false, code: 'SKIPPED', error: notification.error || 'This notification was skipped and cannot be retried.' };
  }
  if (notification.state === 'UNCERTAIN' && payload.force !== true) {
    return {
      ok: false,
      code: 'UNCERTAIN',
      error: 'The earlier attempt may already have reached the team. Confirm a resend to avoid a duplicate message.'
    };
  }
  if (notification.attempts >= CONFIG.WHATSAPP_MAX_ATTEMPTS) {
    return { ok: false, code: 'LIMIT', error: 'Retry limit reached for this notification.' };
  }

  var last = notification.lastAttempt ? new Date(notification.lastAttempt) : null;
  if (last && !isNaN(last.getTime()) && (Date.now() - last.getTime()) < CONFIG.WHATSAPP_RETRY_BACKOFF_SECONDS * 1000 && payload.force !== true) {
    return { ok: false, code: 'BACKOFF', error: 'Too soon after the last attempt. Wait a moment and try again.' };
  }

  var record = null;
  var records = readRecords_(adminSheet_());
  for (var i = 0; i < records.length; i++) {
    if (records[i].id === notification.registrationId) { record = records[i]; break; }
  }
  if (!record) {
    return { ok: false, code: 'ID', error: 'The registration behind this notification no longer exists.' };
  }

  var cfg = waConfig_();
  if (!cfg.configured) {
    return { ok: false, code: 'CONFIG', error: 'WhatsApp is not configured on the server yet.' };
  }

  var vars = (WA_VARS[notification.type] || []).map(function (key) {
    if (key === 'leader') return leaderOf_(record).name || 'there';
    if (key === 'team') return record.teamName || 'your team';
    if (key === 'id') return record.id || '';
    return '';
  });

  var result = deliverWhatsApp_(cfg, notification.recipient, notification.type, notification.template, vars, notification.body);

  updateNotification_(notification.row, {
    state: result.state,
    providerMessageId: result.providerMessageId || notification.providerMessageId,
    attempts: notification.attempts + 1,
    lastAttempt: new Date(),
    error: result.error || '',
    updated: new Date()
  });

  return {
    ok: true,
    notification: notifFromRow_(notification.row, [
      notification.id, notification.created, notification.registrationId, notification.teamName,
      notification.recipient, notification.type, notification.template, notification.relatedStatus,
      notification.body, result.providerMessageId || notification.providerMessageId,
      result.state, notification.attempts + 1, new Date(), result.error || '', new Date()
    ])
  };
}

/* --------------------------- announcements --------------------------- */

function audienceRecords_(records, audience, ids) {
  var wanted = {};
  if (audience === 'SELECTED') {
    for (var i = 0; i < ids.length; i++) wanted[ids[i]] = true;
  }

  return records.filter(function (record) {
    if (record.status === 'REJECTED') return false; // never announce to rejected teams
    if (audience === 'SELECTED') return wanted[record.id] === true;
    if (audience === 'APPROVED') return record.status === 'APPROVED';
    if (audience === 'WAITLISTED') return record.status === 'WAITLISTED';
    if (audience === 'PENDING') return record.status === 'PENDING';
    return true; // ALL = everyone not rejected
  });
}

function selectedIds_(raw) {
  if (!raw || Object.prototype.toString.call(raw) !== '[object Array]') return [];
  var out = [];
  for (var i = 0; i < raw.length && i < 500; i++) {
    var id = cleanText_(raw[i]);
    if (/^[A-Za-z0-9_-]{10,44}$/.test(id)) out.push(id);
  }
  return out;
}

function announceToken_(audience, message, recipients) {
  var ids = recipients.map(function (r) { return r.id; }).sort().join(',');
  return notifId_('announce', audience + '|' + message + '|' + ids);
}

function adminAnnouncePreview_(payload) {
  var message = cleanText_(payload.message);
  if (!message) return { ok: false, code: 'MESSAGE', error: 'Write the announcement first.' };
  if (message.length > CONFIG.WHATSAPP_ANNOUNCE_MAX) {
    return { ok: false, code: 'MESSAGE', error: 'Announcement must be ' + CONFIG.WHATSAPP_ANNOUNCE_MAX + ' characters or fewer.' };
  }
  if (hasMarkup_(message)) {
    return { ok: false, code: 'MESSAGE', error: 'Announcement contains characters that are not allowed.' };
  }

  var audience = cleanText_(payload.audience).toUpperCase() || 'APPROVED';
  if (['ALL', 'APPROVED', 'WAITLISTED', 'PENDING', 'SELECTED'].indexOf(audience) === -1) {
    return { ok: false, code: 'AUDIENCE', error: 'Unknown audience.' };
  }

  var ids = selectedIds_(payload.ids);
  if (audience === 'SELECTED' && ids.length === 0) {
    return { ok: false, code: 'AUDIENCE', error: 'Select at least one team.' };
  }

  var chosen = audienceRecords_(readRecords_(adminSheet_()), audience, ids);
  var eligible = [];
  var blocked = { noConsent: 0, noNumber: 0 };

  for (var i = 0; i < chosen.length; i++) {
    if (!chosen[i].whatsappConsent) { blocked.noConsent++; continue; }
    if (!normalisePhone_(leaderOf_(chosen[i]).whatsapp)) { blocked.noNumber++; continue; }
    eligible.push(chosen[i]);
  }

  var token = announceToken_(audience, message, eligible);

  // Deterministic inside the window, so the same announcement composed twice
  // reuses the same notification ids and the provider is only called once.
  var bucket = Math.floor(Date.now() / (CONFIG.WHATSAPP_ANNOUNCE_WINDOW_MINUTES * 60000));
  var envelope = {
    announcementId: notifId_('announcement', audience + '|' + message + '|' +
      eligible.map(function (r) { return r.id; }).sort().join(',') + '|' + bucket),
    audience: audience,
    message: message,
    recipients: eligible.map(function (r) { return r.id; }),
    createdAt: new Date().toISOString()
  };

  try {
    CacheService.getScriptCache().put('ann_' + token, JSON.stringify(envelope), 900);
  } catch (ignored) {}

  var cfg = waConfig_();

  return {
    ok: true,
    token: token,
    audience: audience,
    count: eligible.length,
    blocked: blocked,
    configured: cfg.configured,
    mode: cfg.mode,
    expirySeconds: 900,
    samples: eligible.slice(0, 6).map(function (r) {
      return { team: r.teamName, leader: leaderOf_(r).name, status: r.status };
    })
  };
}

function adminAnnounceSend_(payload) {
  var token = cleanText_(payload.token);
  if (!/^[A-Za-z0-9_-]{10,44}$/.test(token)) {
    return { ok: false, code: 'TOKEN', error: 'Prepare the announcement again.' };
  }

  var cfg = waConfig_();
  if (!cfg.configured) {
    return { ok: false, code: 'CONFIG', error: 'WhatsApp is not configured on the server yet, so nothing was sent.' };
  }

  var cache = CacheService.getScriptCache();
  var raw = null;
  try { raw = cache.get('ann_' + token); } catch (ignored) { raw = null; }

  if (!raw) {
    return { ok: false, code: 'EXPIRED', error: 'This preview has expired. Prepare the recipients again before sending.' };
  }

  var envelope;
  try { envelope = JSON.parse(raw); } catch (ignored) {
    return { ok: false, code: 'EXPIRED', error: 'This preview has expired. Prepare the recipients again before sending.' };
  }

  // Throttle bulk sends: a stuck button cannot spam the provider.
  var minute = 'wa_rl_' + Math.floor(Date.now() / 60000);
  var used = Number(cache.get(minute) || 0);
  if (used >= CONFIG.WHATSAPP_PER_MINUTE_LIMIT) {
    return { ok: false, code: 'RATE', error: 'Sending limit reached for this minute. Try again shortly.' };
  }

  var records = readRecords_(adminSheet_());
  var byId = {};
  for (var i = 0; i < records.length; i++) byId[records[i].id] = records[i];

  var counts = { sent: 0, failed: 0, skipped: 0, duplicate: 0 };
  var first = [];

  for (var n = 0; n < envelope.recipients.length; n++) {
    if (used >= CONFIG.WHATSAPP_PER_MINUTE_LIMIT) break;
    var record = byId[envelope.recipients[n]];
    if (!record) { counts.skipped++; continue; }

    var result;
    try {
      result = createAndSendNotification_(record, 'ANNOUNCEMENT', envelope.message, envelope.announcementId);
    } catch (error) {
      result = { attempted: false, state: 'FAILED', reason: messageOf_(error) };
    }

    // A duplicate is reported as a duplicate, never as a fresh send, even
    // though the stored row already carries a SENT state.
    if (result.duplicate) counts.duplicate++;
    else if (result.state === 'SENT') counts.sent++;
    else if (result.state === 'SKIPPED') counts.skipped++;
    else counts.failed++;

    used++;
    try { cache.put(minute, String(used), 60); } catch (ignored) {}

    if (first.length < 8) {
      first.push({
        team: record.teamName,
        state: result.state,
        duplicate: result.duplicate === true,
        error: result.error || result.reason || ''
      });
    }
  }

  return {
    ok: true,
    announcementId: envelope.announcementId,
    total: envelope.recipients.length,
    sent: counts.sent,
    failed: counts.failed,
    skipped: counts.skipped,
    duplicate: counts.duplicate,
    results: first
  };
}

/* --------------------------- setup helpers --------------------------- */

/**
 * Run once from the Apps Script editor to print what is missing. It never
 * prints a token, key or number: only whether each value is set.
 */
function whatsappStatus() {
  var cfg = waConfig_();
  var lines = [
    'WhatsApp configuration',
    '  token set:            ' + (cfg.token !== ''),
    '  phone number id set:  ' + (cfg.phoneId !== ''),
    '  enabled:              ' + cfg.enabled,
    '  mode:                 ' + cfg.mode,
    '  api version:          ' + cfg.version,
    '  template language:    ' + cfg.language,
    '  webhook token set:    ' + (cfg.verifyToken !== ''),
    '  receipt on register:  ' + cfg.sendReceipt
  ];
  console.log(lines.join('\n'));
  return cfg.configured;
}

/**
 * Sends one real test message to the number in `whatsapp_test_number`
 * (10 digits, or with the country code). Use this before switching the
 * module on for the whole event.
 */
function sendTestWhatsApp() {
  var number = normalisePhone_(waProp_(WA_PROP.TEST_NUMBER));
  if (!number) {
    console.log('Set the whatsapp_test_number Script Property first (10 digits).');
    return false;
  }

  var cfg = waConfig_();
  if (!cfg.configured) {
    console.log('WhatsApp is not configured yet. See WHATSAPP.md.');
    return false;
  }

  var body = 'QQSGP test message: WhatsApp notifications are connected. ' +
    'If you can read this, the credentials work.';

  var result = deliverWhatsApp_(cfg, number, 'TEST', waTemplateName_('REGISTRATION_RECEIVED'),
    ['Test team leader', 'Test Team', 'TEST-ID'], body);

  console.log('Result: ' + result.state +
    (result.providerMessageId ? ' (' + result.providerMessageId + ')' : '') +
    (result.error ? ' - ' + result.error : ''));

  return result.state === 'SENT';
}
