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
  LOCK_TIMEOUT_MS: 15000
};

// Column order. The website sends exactly this data.
var HEADERS = [
  'Timestamp',
  'Team Name',
  'Department',
  'Player 1 Name', 'Player 1 WhatsApp',
  'Player 2 Name', 'Player 2 WhatsApp',
  'Player 3 Name',
  'Player 4 Name'
];

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
  P1: 4, P1_WA: 5, P2: 6, P2_WA: 7, P3: 8, P4: 9
};

// Only players 1 and 2 give a WhatsApp number.
var PHONE_COLUMNS = [COL.P1_WA, COL.P2_WA];
var NAME_COLUMNS = [COL.P1, COL.P2, COL.P3, COL.P4];

var COLUMN_WIDTHS = [160, 170, 280, 135, 150, 135, 150, 135, 135];

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
    if (action === 'stats') {
      return jsonResponse_(getStats_());
    }

    return jsonResponse_({
      ok: true,
      service: 'QQSGP Free Fire Registration',
      status: 'running',
      endpoints: ['?action=stats']
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
  var raw = '';

  if (e && e.postData && e.postData.contents) {
    raw = e.postData.contents;
  } else if (e && e.parameter && e.parameter.payload) {
    raw = e.parameter.payload;
  }

  if (!raw) return { ok: false, error: 'No data received.' };

  try {
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'The submitted data is not valid.' };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: 'The submitted data is not valid JSON.' };
  }
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
  if (!payload.members || Object.prototype.toString.call(payload.members) !== '[object Array]') {
    return { ok: false, error: 'Exactly 4 players are required.' };
  }
  if (payload.members.length !== 4) {
    return { ok: false, error: 'Exactly 4 players are required.' };
  }

  var members = [];
  for (var i = 0; i < 4; i++) {
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

  return {
    ok: true,
    value: { teamName: teamName, department: department, members: members }
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
    members[2].name,
    members[3].name
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
  var teams = countTeams_(sheet);
  var players = 0;
  var byDepartment = {};
  var lastRegistration = '';

  if (teams > 0) {
    var width = Math.min(HEADERS.length, sheet.getMaxColumns());
    var values = sheet.getRange(2, 1, teams, width).getValues();

    for (var i = 0; i < values.length; i++) {
      var row = values[i];

      for (var n = 0; n < NAME_COLUMNS.length; n++) {
        var column = NAME_COLUMNS[n];
        if (column <= width && cleanText_(row[column - 1]) !== '') players++;
      }

      var department = cleanText_(row[COL.DEPARTMENT - 1]);
      if (department) {
        byDepartment[department] = (byDepartment[department] || 0) + 1;
      }
    }

    var lastStamp = values[values.length - 1][COL.TIMESTAMP - 1];
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
