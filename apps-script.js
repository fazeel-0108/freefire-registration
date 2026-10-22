/*
  ================================================================
  QQSGP FREE FIRE TOURNAMENT — REGISTRATION BACKEND
  Quli Qutub Shah Government Polytechnic
  ================================================================

  WHAT THIS SCRIPT DOES
  ---------------------
  • Receives team registrations from the website (doPost).
  • Stores every team as one clean row in the "Registrations" sheet.
  • Runs the verified online payment: YouPI PG sessions, server-side status
    reads with the merchant key, and a review queue for payments the gateway
    could not confirm strongly enough.
  • Keeps the entry fee in the "Settings" tab and snapshots it per team.
  • Serves live counters and the public fee (doGet ?action=stats / config).
  • Serves the organiser dashboard: accounts, audit, notifications, matches.
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

  Online payment stays OFF until the YouPI Script Properties exist, and cash
  registrations keep working meanwhile. See PAYMENTS.md for the properties,
  the verification model and the honest limits of a self-hosted gateway.

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
  //
  // A web app deployed as "Execute as me / Anyone" has NO active spreadsheet,
  // so getActiveSpreadsheet() returns null there and the ID has to come from
  // somewhere. Pinning it in this file would put the sheet's ID in a public
  // repository, so it is read from the script_id Script Property instead -- see
  // sheetId_() below and ADMIN.md for the one-line setup. This also means a
  // fresh copy of this file can be deployed without editing anything.
  SHEET_ID: '',
  SHEET_ID_PROPERTY: 'sheet_id',

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

  // --- Entry fee -----------------------------------------------------
  // ₹100 per TEAM is only the DEFAULT. The live fee comes from the Settings
  // tab (entry_fee), which the organiser dashboard writes, so it lives in one
  // place: the sheet. Whatever the fee is at the moment a team registers is
  // copied onto that row, so a later change never rewrites an older team's fee.
  TEAM_FEE: 100,
  // --- Online payments ---------------------------------------------
  // YouPI PG is the only online gateway. Its credentials live in Script
  // Properties, never in this file, the repository or the published site.
  // See PAYMENTS.md for the exact setup and the honest limits of its
  // verification.
  // The merchant key is the merchant's webhook secret, which YouPI also accepts
  // as X-Merchant-Key on the merchant API. It never reaches the browser.
  YOUPI_BASE_URL_PROPERTY: 'youpi_base_url',
  YOUPI_MERCHANT_ID_PROPERTY: 'youpi_merchant_id',
  YOUPI_MERCHANT_KEY_PROPERTY: 'youpi_merchant_key',
  // YouPI reports how it decided a payment arrived:
  //   0 = unverified, 1 = bank SMS observed, 2 = SMS + Gmail (dual) observed.
  // Anything below this level is held for an organiser instead of registering
  // a team, because the gateway itself says that is not conclusive.
  YOUPI_MIN_VERIFICATION_PROPERTY: 'youpi_min_verification_level',
  YOUPI_DEFAULT_MIN_VERIFICATION: 2,

  PAYMENT_CURRENCY: 'INR',
  // A QR is only useful for a short while; an abandoned draft must expire so
  // the sheet does not fill with dead payment attempts.
  PAYMENT_DRAFT_TTL_MINUTES: 30,
  PAYMENT_SETTINGS_SHEET: 'Settings',
  PAYMENT_DRAFT_SHEET: 'PaymentDrafts',

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
// The payment columns were appended to the END of this list so every sheet
// written by an older version of this script keeps its data in the same
// cells. Nothing is inserted, renamed or moved.
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
  'Consent At',
  'Entry Fee',
  'Payment Method',
  'Payment Status',
  'UTR / Reference',
  'Payment Note',
  'Payment Updated At',
  'Payment Updated By',
  // Appended again, never inserted: a team's verified-payment evidence is
  // recorded next to the money it describes.
  'Payment Order ID',
  'Payment ID',
  'Paid Amount',
  'Paid Currency',
  'Payment Verified At',
  'Payment Provider'
];

// Organiser workflow states. A blank status on an older row reads as PENDING.
var STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WAITLISTED'];

// Payment method and status. These exact strings are what the sheet dropdowns
// offer, so a hand edit on a phone and a dashboard click write the same value.
var PAY = {
  NOT_SELECTED: 'NOT SELECTED',
  PENDING: 'PENDING',
  PENDING_VERIFICATION: 'PENDING VERIFICATION',
  PAID: 'PAID',
  NEEDS_REVIEW: 'NEEDS REVIEW',
  REJECTED: 'REJECTED'
};

var PAYMENT_STATUSES = [
  PAY.NOT_SELECTED, PAY.PENDING, PAY.PENDING_VERIFICATION,
  PAY.PAID, PAY.NEEDS_REVIEW, PAY.REJECTED
];

var PAYMENT_METHODS = ['ONLINE', 'CASH'];

// Statuses a team may never set for itself. Only an organiser can move a
// payment to PAID — a UTR typed by a visitor proves nothing.
var PAYMENT_ORGANISER_ONLY = [PAY.PAID, PAY.NEEDS_REVIEW, PAY.REJECTED];

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
  CONSENT: 12, CONSENT_AT: 13,
  FEE: 14, METHOD: 15, PAY_STATUS: 16, UTR: 17, PAY_NOTE: 18,
  PAY_AT: 19, PAY_BY: 20,
  PAY_ORDER: 21, PAY_ID: 22, PAID_AMOUNT: 23, PAID_CURRENCY: 24,
  PAY_VERIFIED_AT: 25, PAY_PROVIDER: 26
};

// Only players 1 and 2 give a WhatsApp number.
var PHONE_COLUMNS = [COL.P1_WA, COL.P2_WA];
var NAME_COLUMNS = [COL.P1, COL.P2, COL.P3, COL.P4];

var COLUMN_WIDTHS = [
  160, 170, 280, 135, 150, 135, 150, 135, 135, 110, 260, 100, 120,
  90, 120, 150, 165, 190, 160, 120,
  180, 175, 100, 100, 150, 120
];

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
var PROP_FORMATTED = 'qqsgp_sheet_format_v3';


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

    // The live entry fee and whether online payment is actually switched on.
    // The page never assumes either: it asks.
    if (action === 'config') {
      return jsonResponse_(publicConfig_());
    }

    return jsonResponse_({
      ok: true,
      service: 'QQSGP Free Fire Registration',
      status: 'running',
      endpoints: ['?action=stats', '?action=config', '?action=webhook', '?action=paywebhook']
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

  // Verified online payment. The browser can open a session, ask about it and
  // cancel it; it can never tell the server that money arrived. Only the
  // gateway's own API answer can do that (see verifyYoupiPayment_).
  if (route === 'payorder') {
    try {
      return jsonResponse_(publicPaymentOrder_(e));
    } catch (error) {
      return errorResponse_('Server error: ' + messageOf_(error));
    }
  }

  if (route === 'paystatus') {
    try {
      return jsonResponse_(publicPaymentStatus_(e));
    } catch (error) {
      return errorResponse_('Server error: ' + messageOf_(error));
    }
  }

  if (route === 'paycancel') {
    try {
      return jsonResponse_(publicPaymentCancel_(e));
    } catch (error) {
      return errorResponse_('Server error: ' + messageOf_(error));
    }
  }

  // The gateway's callback is a doorbell, not evidence. Its body is read for
  // ids only, then thrown away: the session is re-fetched from YouPI with our
  // merchant key before a single cell is written.
  if (route === 'paywebhook') {
    try {
      return jsonResponse_(publicPaymentWebhook_(e));
    } catch (error) {
      console.error('Payment webhook failed: ' + messageOf_(error));
      return jsonResponse_({ ok: false });
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

    // The id is the same opaque record id the dashboard uses. Everything the
    // site is told about money is read back from the row that was just
    // written, never taken from the request.
    var stamp = sheet.getRange(rowNumber, COL.TIMESTAMP).getValue();
    var newId = recordId_(stamp, checked.value.teamName);
    var written = sheet.getRange(rowNumber, 1, 1, HEADERS.length).getValues()[0];
    var payment = paymentFromRow_(written);

    return jsonResponse_({
      ok: true,
      team: checked.value.teamName,
      row: rowNumber,
      teams: stats.teams,
      players: stats.players,
      id: newId,
      fee: payment.entryFee,
      payment: payment
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

  // --- Payment choice ---------------------------------------------------
  // The website now sends the choice WITH the registration, because nothing is
  // registered until a method is picked. The field stays optional so an older
  // page (or a direct POST) still registers a team rather than failing.
  var payment = validatePaymentChoice_(payload.payment || {});
  if (!payment.ok) return { ok: false, error: payment.error };

  return {
    ok: true,
    value: {
      teamName: teamName,
      department: department,
      members: members,
      whatsappConsent: consent,
      consentAt: consent ? new Date() : '',
      payment: payment.value
    }
  };
}

/**
 * Turns the team's choice into the values written on the row.
 *
 *   CASH   -> PENDING. The money has not been handed over yet.
 *   ONLINE -> REFUSED. "I paid" is not evidence: a registration that claims
 *             online payment is only ever written by the verified-payment
 *             path below, after the provider confirms the money. A browser
 *             that posts ONLINE straight at this endpoint is turned away
 *             instead of being trusted.
 *   none   -> NOT SELECTED (older clients).
 */
function validatePaymentChoice_(raw) {
  var source = raw && typeof raw === 'object' ? raw : {};
  var rawText = cleanText_(source.method || (typeof raw === 'string' ? raw : ''));
  var method = normalisePaymentMethod_(rawText);

  // An empty choice is allowed: the previous website sends no payment block and
  // must keep working. Every other value must be one of the two methods.
  if (!method) {
    if (rawText) {
      return { ok: false, error: 'Choose Online or Cash to submit the entry.' };
    }
    return {
      ok: true,
      value: { method: '', status: PAY.NOT_SELECTED, utr: '', note: '', by: '' }
    };
  }

  if (method === 'ONLINE') {
    return {
      ok: false,
      error: 'Online payment has to be completed through the payment step, after the ' +
        'provider confirms it. Nothing was submitted. Choose Cash, or pay online first.'
    };
  }

  return {
    ok: true,
    value: {
      method: 'CASH',
      status: PAY.PENDING,
      utr: '',
      note: 'Cash to be collected by an organiser.',
      by: 'TEAM'
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

/**
 * The spreadsheet to use. CONFIG first (a standalone script may pin it), then
 * the sheet_id Script Property. The property is what a deployed web app needs:
 * bound scripts reach their own sheet from the editor, but a web app request
 * running as the deployer has no active spreadsheet.
 */
function sheetId_() {
  if (CONFIG.SHEET_ID) return CONFIG.SHEET_ID;

  try {
    return PropertiesService.getScriptProperties().getProperty(CONFIG.SHEET_ID_PROPERTY) || '';
  } catch (ignored) {
    return '';
  }
}

/** Opens the spreadsheet by ID, falling back to the bound sheet in the editor. */
function openBook_() {
  var id = sheetId_();
  if (id) return SpreadsheetApp.openById(id);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_() {
  var spreadsheet = openBook_();

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
  var payment = registration.payment || null;

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
    registration.consentAt || '',
    // The fee is stored per row so a later price change never rewrites
    // what an already-registered team agreed to pay.
    payment && payment.fee ? Number(payment.fee) : entryFee_(),
    payment ? payment.method : '',
    payment ? payment.status : PAY.NOT_SELECTED,
    payment ? (payment.utr || '') : '',
    payment ? (payment.note || '') : '',
    payment ? new Date() : '',
    payment ? (payment.by || 'TEAM') : '',
    // Verified-payment evidence. Empty for cash, which has none.
    payment ? (payment.orderId || '') : '',
    payment ? (payment.paymentId || '') : '',
    payment ? (payment.paidAmount || '') : '',
    payment ? (payment.paidCurrency || '') : '',
    payment ? (payment.verifiedAt || '') : '',
    payment ? (payment.provider || '') : ''
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
  //
  // Document Properties only exist on a container-bound script. This project is
  // a standalone one (the web app opens the sheet by id), so getDocumentProperties()
  // is null there and a naive memo threw, leaving the sheet unformatted and the
  // payment dropdowns missing. Fall back to Script Properties and, if neither
  // store is reachable, just apply the formatting without remembering it.
  var properties = null;

  try {
    properties = PropertiesService.getDocumentProperties() ||
      PropertiesService.getScriptProperties();
  } catch (ignored) {
    properties = null;
  }

  try {
    if (properties && properties.getProperty(PROP_FORMATTED) === 'yes') return;

    applySheetFormatting_(sheet);
    if (properties) properties.setProperty(PROP_FORMATTED, 'yes');
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

  // The fee is a number in the sheet, shown as ₹100, so it can be summed.
  sheet.getRange(2, COL.FEE, bodyRows, 1).setNumberFormat('"₹"#,##0');
  sheet.getRange(2, COL.FEE, bodyRows, 1).setHorizontalAlignment('right');

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
  refreshPaymentStyles_(sheet);

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

/**
 * Payment dropdowns, kept only on real rows. This is what lets the sheet be
 * managed from a phone: tap the cell, pick a status, and the dashboard picks
 * the change up on its next refresh.
 */
function refreshPaymentStyles_(sheet) {
  try {
    var bodyRows = Math.max(sheet.getMaxRows() - 1, 1);
    var dataRows = Math.min(Math.max(countTeams_(sheet), 0), bodyRows);

    if (dataRows > 0) {
      var methodRule = SpreadsheetApp.newDataValidation()
        .requireValueInList(PAYMENT_METHODS, true)
        .setAllowInvalid(true)
        .setHelpText('Online or Cash. Anything else is flagged for review.')
        .build();
      sheet.getRange(2, COL.METHOD, dataRows, 1).setDataValidation(methodRule);

      var statusRule = SpreadsheetApp.newDataValidation()
        .requireValueInList(PAYMENT_STATUSES, true)
        .setAllowInvalid(true)
        .setHelpText('Only an organiser can mark a payment PAID, and only after checking it.')
        .build();
      sheet.getRange(2, COL.PAY_STATUS, dataRows, 1).setDataValidation(statusRule);
    }

    var staleRows = bodyRows - dataRows;
    if (staleRows > 0) {
      sheet.getRange(2 + dataRows, COL.METHOD, staleRows, 1).clearDataValidations();
      sheet.getRange(2 + dataRows, COL.PAY_STATUS, staleRows, 1).clearDataValidations();
    }
  } catch (error) {
    // Formatting is a convenience. A registration must still save without it.
    console.error('Payment formatting skipped: ' + messageOf_(error));
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

  // --- Payment status colours -----------------------------------------
  // Deliberately quiet: a coloured cell should be readable at a glance on a
  // phone without turning the sheet into a traffic light.
  var statusColumn = '$' + columnLetter_(COL.PAY_STATUS);
  var payStyles = [
    { value: PAY.PAID, bg: '#e6f4ea', fg: '#137333' },
    { value: PAY.PENDING, bg: '#fef7e0', fg: '#a15c00' },
    { value: PAY.PENDING_VERIFICATION, bg: '#e8f0fe', fg: '#1a56db' },
    { value: PAY.NEEDS_REVIEW, bg: '#fdecec', fg: '#b3261e' },
    { value: PAY.REJECTED, bg: '#f1f3f4', fg: '#5f6368' }
  ];

  for (var p = 0; p < payStyles.length; p++) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=' + statusColumn + '2="' + payStyles[p].value + '"')
      .setBackground(payStyles[p].bg)
      .setFontColor(payStyles[p].fg)
      .setRanges([sheet.getRange(2, COL.PAY_STATUS, rows, 1)])
      .build());
  }

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
      .addItem('Payments: backfill ₹100 fee', 'menuBackfillFee')
      .addSeparator()
      .addItem('Organiser accounts: create', 'menuCreateAccount')
      .addItem('Organiser accounts: reset a PIN', 'menuResetPin')
      .addItem('Organiser accounts: enable / disable', 'menuToggleAccount')
      .addItem('Organiser accounts: sign out everywhere', 'menuRevokeSessions')
      .addItem('Organiser accounts: list', 'menuListAccounts')
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
  markFormatted_();
  showAlert_('Formatting applied', 'The "' + CONFIG.SHEET_NAME + '" sheet now uses the tournament layout.');
}

/** Remembers that formatting is done, on whichever property store exists. */
function markFormatted_() {
  try {
    var properties = PropertiesService.getDocumentProperties() ||
      PropertiesService.getScriptProperties();
    if (properties) properties.setProperty(PROP_FORMATTED, 'yes');
  } catch (ignored) {
    // No property store (standalone script): formatting simply re-applies.
  }
}

function menuRepairHeader() {
  var sheet = getSheet_();
  ensureHeaders_(sheet);
  applySheetFormatting_(sheet);
  showAlert_('Header repaired', 'The header row was rebuilt and the sheet was re-formatted.');
}

/**
 * Fills a blank Entry Fee on rows written before the fee column existed.
 * It never changes a fee that is already recorded, and never touches a
 * payment status — a team still has to pay until an organiser says otherwise.
 */
function menuBackfillFee() {
  var sheet = getSheet_();
  ensureHeaders_(sheet);

  var rows = countTeams_(sheet);
  if (rows === 0) {
    showAlert_('Nothing to do', 'There are no registrations in this sheet yet.');
    return;
  }

  var range = sheet.getRange(2, COL.FEE, rows, 1);
  var values = range.getValues();
  var filled = 0;

  for (var i = 0; i < values.length; i++) {
    if (cleanText_(values[i][0]) === '') {
      values[i][0] = CONFIG.TEAM_FEE;
      filled++;
    }
  }

  if (filled > 0) {
    range.setValues(values);
    range.setNumberFormat('"₹"#,##0');
  }

  showAlert_(
    'Entry fee backfilled',
    filled + ' row(s) set to ₹' + CONFIG.TEAM_FEE + '.\n' +
      (rows - filled) + ' row(s) already had a fee and were left untouched.'
  );
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
   ORGANISER ACCOUNTS, PIN LOGIN, ROLES AND SESSIONS
   ----------------------------------------------------------------
   Replaces "one shared key for everybody" with named accounts. Each
   organiser has an id, a role and a personal PIN. PINs are never
   stored: what lives here is a salted PBKDF2-HMAC-SHA256 verifier.
   Signing in mints a server-side session; every later call carries
   the session token, and the server decides what that role may do.

   Everything below is stored in Script Properties, which only this
   script can read. Nothing here is in the website, the repository or
   the sheet, and no PIN or token is ever written to a log line.
   ================================================================ */

var ORG = {
  ACCOUNTS_PROPERTY: 'org_accounts_v1',
  SESSIONS_PROPERTY: 'org_sessions_v1',

  /* A property value tops out at about 9 KB, so both stores are split across
     numbered chunks and rejoined on read. */
  CHUNK_CHARS: 7000,

  /* Sessions: idle timeout, absolute lifetime, and the longer absolute
     lifetime granted when the organiser ticks "keep me signed in". */
  IDLE_SECONDS: 12 * 60 * 60,
  ABSOLUTE_SECONDS: 7 * 24 * 60 * 60,
  REMEMBER_ABSOLUTE_SECONDS: 30 * 24 * 60 * 60,
  /* Sliding renewal is written at most this often, so a busy dashboard does
     not rewrite the session store on every poll. */
  SLIDE_AFTER_SECONDS: 300,
  MAX_SESSIONS_PER_ACCOUNT: 10,
  MAX_SESSIONS_TOTAL: 200,

  /* Lockout after repeated wrong PINs, counted per submitted organiser id so
     guessing ids is as slow as guessing PINs. */
  LOGIN_MAX_FAILS: 5,
  LOGIN_FAIL_WINDOW_SECONDS: 900,
  LOGIN_LOCK_SECONDS: 900,

  ID_MIN: 3,
  ID_MAX: 32,
  NAME_MAX: 60,
  PIN_MIN: 6,
  PIN_MAX: 64,

  /* PBKDF2-HMAC-SHA256. Every iteration is a native call, so the count is
     calibrated to a time budget rather than fixed, and the count actually
     used is recorded inside the verifier. The floor keeps a fast runtime
     from calibrating down to something trivial. */
  PBKDF2_FLOOR: 600,
  PBKDF2_CEIL: 20000,
  PBKDF2_TARGET_MS: 400,
  PBKDF2_CALIBRATE_ITERATIONS: 64,
  PBKDF2_ALGORITHM: 'pbkdf2-sha256',

  AUDIT_SHEET_NAME: 'Audit',
  AUDIT_PAGE_SIZE: 30,
  AUDIT_MAX_ROWS: 2000
};

var ORG_ROLE = { SUPER: 'SUPER', ORGANIZER: 'ORGANIZER' };

/* What each role may do. One table, checked on the server for every action:
   hiding a button in the browser is never what stops somebody. */
var ORG_PERMISSIONS = {
  SUPER: [
    'records.view', 'records.update', 'records.export',
    'pay.view', 'pay.update',
    'wa.view', 'wa.send',
    'accounts.manage', 'sessions.manage', 'audit.view'
  ],
  ORGANIZER: [
    'records.view', 'records.update', 'records.export',
    'pay.view', 'pay.update',
    'wa.view', 'wa.send'
  ]
};

/* Dashboard action -> permission. Anything not listed needs only a session,
   which is how the read-only and self-service calls are covered. */
var ORG_ACTION_PERMISSION = {
  'list': 'records.view',
  'status': 'records.update',
  'note': 'records.update',
  'payment-status': 'pay.update',
  'settings-get': 'pay.view',
  'settings-set': 'pay.update',
  'drafts-list': 'pay.view',
  'draft-resolve': 'pay.update',
  'export': 'records.export',
  'notif-config': 'wa.view',
  'notif-list': 'wa.view',
  'notif-retry': 'wa.send',
  'announce-preview': 'wa.view',
  'announce-send': 'wa.send',
  'account-list': 'accounts.manage',
  'account-create': 'accounts.manage',
  'account-update': 'accounts.manage',
  'account-reset-pin': 'accounts.manage',
  'account-delete': 'accounts.manage',
  'session-list': 'sessions.manage',
  'session-revoke': 'sessions.manage',
  'account-revoke-sessions': 'sessions.manage',
  'audit-list': 'audit.view'
};

/* Pins that are a single repeated character, a straight run, or on this list
   are refused at creation and at reset. */
var ORG_WEAK_PINS = [
  '000000', '111111', '1111111', '123123', '123321', '112233', '121212',
  '123456', '1234567', '12345678', '123456789', '1234567890', '654321',
  '987654', '010203', 'noname', 'admin', 'admin123', 'administrator',
  'password', 'passw0rd', 'pass123', 'qwerty', 'qwerty123', 'abc123',
  'letmein', 'welcome', 'iloveyou', 'secret', 'letmein1', 'tournament',
  'qqsgp', 'qqsgp123', 'freefire', 'freefire1'
];

/* ------------------------ server-side stores ------------------------ */

/**
 * Reads a JSON document held in Script Properties under numbered chunks.
 * A property value is capped at roughly 9 KB, so anything that could grow
 * (accounts, sessions) is split and rejoined here. A corrupt chunk reads as
 * an empty store rather than throwing, which keeps a bad write from locking
 * every organiser out.
 */
function orgStoreRead_(prefix) {
  var properties;
  try {
    properties = PropertiesService.getScriptProperties();
  } catch (ignored) {
    return [];
  }

  var text = '';
  var index = 0;
  while (index < 200) {
    var chunk = properties.getProperty(prefix + '_' + index);
    if (chunk === null || chunk === undefined) break;
    text += chunk;
    index++;
  }

  if (!text) return [];

  try {
    var value = JSON.parse(text);
    return (value && value.length !== undefined) ? value : [];
  } catch (ignored) {
    return [];
  }
}

/** Splits a JSON document across chunks and clears any chunk left behind. */
function orgStoreWrite_(prefix, list) {
  var properties = PropertiesService.getScriptProperties();
  var text = JSON.stringify(list || []);
  var chunks = [];

  for (var at = 0; at < text.length; at += ORG.CHUNK_CHARS) {
    chunks.push(text.substr(at, ORG.CHUNK_CHARS));
  }
  if (chunks.length === 0) chunks.push('[]');

  for (var i = 0; i < chunks.length; i++) {
    properties.setProperty(prefix + '_' + i, chunks[i]);
  }

  // Remove the tail of a previous, longer document so a stale chunk can never
  // be appended to a shorter one.
  for (var stale = chunks.length; stale < 200; stale++) {
    if (properties.getProperty(prefix + '_' + stale) === null) break;
    properties.deleteProperty(prefix + '_' + stale);
  }

  return chunks.length;
}

/* ------------------------------ crypto ------------------------------ */

/** HMAC-SHA256 over raw bytes. Apps Script returns signed bytes; the XOR in
    PBKDF2 below relies on that, so nothing is normalised here. */
function orgHmacBytes_(messageBytes, keyBytes) {
  return Utilities.computeHmacSha256Signature(messageBytes, keyBytes);
}

function orgBase64_(bytes) {
  return Utilities.base64Encode(bytes);
}

function orgHexToBytes_(hex) {
  var bytes = [];
  for (var i = 0; i < hex.length; i++) bytes.push(hex.charCodeAt(i));
  return bytes;
}

/** The PIN as UTF-8 code units, capped to one byte each. */
function orgPinBytes_(pin) {
  var bytes = [];
  for (var i = 0; i < pin.length; i++) bytes.push(pin.charCodeAt(i) % 256);
  return bytes;
}

/**
 * PBKDF2-HMAC-SHA256, one output block (32 bytes).
 * U1 = HMAC(PIN, salt || INT(1)); Ui = HMAC(PIN, Ui-1); DK = U1 ^ U2 ^ ...
 */
function orgPbkdf2Bytes_(pinBytes, saltBytes, iterations) {
  var seed = saltBytes.concat([0, 0, 0, 1]);
  var block = orgHmacBytes_(seed, pinBytes);
  var result = block.slice(0);

  for (var round = 1; round < iterations; round++) {
    block = orgHmacBytes_(block, pinBytes);
    for (var i = 0; i < result.length; i++) result[i] = result[i] ^ block[i];
  }

  return result;
}

/** 32 hex characters of salt, from two random UUIDs. */
function orgNewSalt_() {
  return (Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '')).slice(0, 32);
}

/**
 * Chooses an iteration count that costs about PBKDF2_TARGET_MS on this
 * runtime, then clamps it. The count that was actually used is stored in the
 * verifier, so a later verification always repeats the same work.
 */
function orgCalibrateIterations_(pinBytes, saltBytes) {
  var started = new Date().getTime();
  orgPbkdf2Bytes_(pinBytes, saltBytes, ORG.PBKDF2_CALIBRATE_ITERATIONS);
  var elapsed = new Date().getTime() - started;

  if (elapsed <= 0) return ORG.PBKDF2_FLOOR;

  var perIteration = elapsed / ORG.PBKDF2_CALIBRATE_ITERATIONS;
  var wanted = Math.round(ORG.PBKDF2_TARGET_MS / perIteration);

  return Math.max(ORG.PBKDF2_FLOOR, Math.min(ORG.PBKDF2_CEIL, wanted));
}

/** Builds the stored verifier. The PIN itself is never written anywhere. */
function orgMakeVerifier_(pin) {
  var salt = orgNewSalt_();
  var pinBytes = orgPinBytes_(pin);
  var saltBytes = orgHexToBytes_(salt);
  var iterations = orgCalibrateIterations_(pinBytes, saltBytes);
  var digest = orgPbkdf2Bytes_(pinBytes, saltBytes, iterations);

  return ORG.PBKDF2_ALGORITHM + '$' + iterations + '$' + salt + '$' + orgBase64_(digest);
}

/**
 * Repeats exactly the work a real verification does, for a submitted id that
 * does not exist. Without it, a wrong id would answer measurably faster than a
 * wrong PIN and the login form would leak which ids are real.
 */
function orgDummyVerifier_() {
  var properties = PropertiesService.getScriptProperties();
  var stored = properties.getProperty('org_dummy_v1');
  if (stored) return stored;

  stored = orgMakeVerifier_(Utilities.getUuid());

  try {
    properties.setProperty('org_dummy_v1', stored);
  } catch (ignored) {}

  return stored;
}

/** true when the PIN matches the stored verifier. Never reveals the PIN. */
function orgCheckVerifier_(pin, verifier) {
  var parts = String(verifier || '').split('$');
  if (parts.length !== 4) return false;
  if (parts[0] !== ORG.PBKDF2_ALGORITHM) return false;

  var iterations = Number(parts[1]);
  if (!isFinite(iterations) || iterations < 1 || iterations > 2000000) return false;

  var digest = orgPbkdf2Bytes_(orgPinBytes_(pin), orgHexToBytes_(parts[2]), iterations);

  return constantTimeEquals_(orgBase64_(digest), parts[3]);
}

/** 64 hex characters of session token, from two random UUIDs. */
function orgNewToken_() {
  return (Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '')).slice(0, 64);
}

/** Only the hash of a session token is stored, so a store leak is not a login. */
function orgTokenHash_(token) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'qqsgp-session|' + token);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}

/* --------------------------- input policy --------------------------- */

/** Organiser ids are lowercase and URL-safe, so they are easy to type on a phone. */
function orgNormaliseId_(value) {
  return cleanText_(value).toLowerCase();
}

function orgIdValid_(id) {
  return /^[a-z0-9][a-z0-9._-]*$/.test(id) && id.length >= ORG.ID_MIN && id.length <= ORG.ID_MAX;
}

/**
 * The PIN policy. A short all-numeric PIN is genuinely weaker than a password:
 * six digits is a one-in-a-million guess and eight is not much better against
 * an offline attacker, which is why the verifier is slow, the account locks
 * after five wrong tries, and a longer alphanumeric PIN is recommended.
 */
function orgPinProblem_(id, pin) {
  if (typeof pin !== 'string') return 'Enter your PIN.';
  if (pin.length < ORG.PIN_MIN) return 'The PIN must be at least ' + ORG.PIN_MIN + ' characters.';
  if (pin.length > ORG.PIN_MAX) return 'The PIN must be ' + ORG.PIN_MAX + ' characters or fewer.';
  if (/^\s|\s$/.test(pin)) return 'The PIN cannot start or end with a space.';
  if (/[\x00-\x1f]/.test(pin)) return 'The PIN cannot contain control characters.';

  var lower = pin.toLowerCase();
  var compact = lower.replace(/[^a-z0-9]/g, '');

  if (compact.length && /^(.)\1*$/.test(compact)) {
    return 'That PIN is one character repeated. Choose something less predictable.';
  }
  if (orgIsSequence_(compact)) {
    return 'That PIN is a straight run of characters. Choose something less predictable.';
  }
  if (ORG_WEAK_PINS.indexOf(compact) !== -1) {
    return 'That PIN is too common. Choose something less predictable.';
  }
  if (id) {
    var idCompact = id.replace(/[^a-z0-9]/g, '');
    if (idCompact && compact === idCompact) return 'The PIN cannot be your organiser ID.';
    if (idCompact.length >= ORG.ID_MIN && compact.indexOf(idCompact) !== -1) {
      return 'The PIN cannot contain your organiser ID.';
    }
  }

  return '';
}

/** true for 4 or more characters stepping by one, up or down, e.g. 1234 or 8765. */
function orgIsSequence_(compact) {
  if (compact.length < 4) return false;

  for (var start = 0; start + 4 <= compact.length; start++) {
    var step = compact.charCodeAt(start + 1) - compact.charCodeAt(start);
    if (step !== 1 && step !== -1) continue;

    var run = 2;
    while (start + run < compact.length &&
           compact.charCodeAt(start + run) - compact.charCodeAt(start + run - 1) === step) {
      run++;
    }
    if (run >= 4) return true;
  }

  return false;
}

function orgCleanDevice_(value) {
  var label = cleanText_(value).replace(/[^\w .\-()/]/g, '').slice(0, 60);
  return label || 'Unnamed device';
}

/* ---------------------------- the accounts ---------------------------- */

function orgAccounts_() {
  return orgStoreRead_(ORG.ACCOUNTS_PROPERTY);
}

function orgFindAccount_(id) {
  var wanted = orgNormaliseId_(id);
  var accounts = orgAccounts_();

  for (var i = 0; i < accounts.length; i++) {
    if (orgNormaliseId_(accounts[i].id) === wanted) return accounts[i];
  }

  return null;
}

/** Everything the browser may know about an account. The verifier never leaves. */
function orgPublicAccount_(account) {
  if (!account) return null;
  return {
    id: account.id,
    name: account.name || account.id,
    role: account.role === ORG_ROLE.SUPER ? ORG_ROLE.SUPER : ORG_ROLE.ORGANIZER,
    enabled: account.enabled !== false,
    created: account.created || '',
    createdBy: account.createdBy || '',
    pinChanged: account.pinChanged || '',
    lastLogin: account.lastLogin || '',
    lastDevice: account.lastDevice || ''
  };
}

/** Never logs or returns a PIN; the caller only sees how many accounts exist. */
function orgCountSuperAdmins_(accounts) {
  var count = 0;
  for (var i = 0; i < (accounts || []).length; i++) {
    if (accounts[i].role === ORG_ROLE.SUPER && accounts[i].enabled !== false) count++;
  }
  return count;
}

/**
 * Creates an account. The PIN is hashed here and discarded; it is not stored,
 * not returned and not logged. Only a Super Admin, or the one-time setup
 * helper run from the sheet menu, can reach this.
 */
function orgCreateAccount_(options) {
  var id = orgNormaliseId_(options && options.id);
  var pin = (options && options.pin) || '';
  var role = (options && options.role) === ORG_ROLE.SUPER ? ORG_ROLE.SUPER : ORG_ROLE.ORGANIZER;

  if (!orgIdValid_(id)) {
    return {
      ok: false,
      code: 'ORGID',
      error: 'The organiser ID must be ' + ORG.ID_MIN + '-' + ORG.ID_MAX +
        ' characters: letters, numbers, dot, dash or underscore, starting with a letter or number.'
    };
  }

  var problem = orgPinProblem_(id, pin);
  if (problem) return { ok: false, code: 'PIN', error: problem };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { ok: false, code: 'BUSY', error: 'The account store is busy. Try again in a moment.' };
  }

  try {
    var accounts = orgAccounts_();
    for (var i = 0; i < accounts.length; i++) {
      if (orgNormaliseId_(accounts[i].id) === id) {
        return { ok: false, code: 'EXISTS', error: 'That organiser ID is already taken.' };
      }
    }

    var name = cleanText_(options && options.name).slice(0, ORG.NAME_MAX) || id;
    var now = new Date().toISOString();
    var account = {
      id: id,
      name: name,
      role: role,
      enabled: true,
      verifier: orgMakeVerifier_(pin),
      created: now,
      createdBy: cleanText_(options && options.createdBy).slice(0, ORG.ID_MAX) || 'setup',
      pinChanged: now,
      lastLogin: '',
      lastDevice: ''
    };

    accounts.push(account);
    orgStoreWrite_(ORG.ACCOUNTS_PROPERTY, accounts);

    return { ok: true, account: orgPublicAccount_(account), accounts: accounts.length };
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

/**
 * Changes one account. Two rules are enforced here, not in the browser: the
 * last enabled Super Admin can never be demoted or disabled (that would lock
 * everybody out of account management), and a PIN change always invalidates
 * that account's existing sessions.
 */
function orgUpdateAccount_(id, patch, actor) {
  var wanted = orgNormaliseId_(id);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { ok: false, code: 'BUSY', error: 'The account store is busy. Try again in a moment.' };
  }

  try {
    var accounts = orgAccounts_();
    var index = -1;
    for (var i = 0; i < accounts.length; i++) {
      if (orgNormaliseId_(accounts[i].id) === wanted) { index = i; break; }
    }
    if (index === -1) return { ok: false, code: 'NOACCOUNT', error: 'That organiser account no longer exists.' };

    var account = accounts[index];
    var next = {
      id: account.id,
      name: account.name,
      role: account.role,
      enabled: account.enabled !== false,
      verifier: account.verifier,
      created: account.created,
      createdBy: account.createdBy,
      pinChanged: account.pinChanged,
      lastLogin: account.lastLogin,
      lastDevice: account.lastDevice
    };

    if (patch.role !== undefined) {
      next.role = patch.role === ORG_ROLE.SUPER ? ORG_ROLE.SUPER : ORG_ROLE.ORGANIZER;
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled === true || patch.enabled === 'true';
    if (patch.name !== undefined) next.name = cleanText_(patch.name).slice(0, ORG.NAME_MAX) || next.id;

    if (patch.pin !== undefined && patch.pin !== '') {
      var problem = orgPinProblem_(next.id, patch.pin);
      if (problem) return { ok: false, code: 'PIN', error: problem };
      next.verifier = orgMakeVerifier_(patch.pin);
      next.pinChanged = new Date().toISOString();
    }

    var demoting = !(next.role === ORG_ROLE.SUPER && next.enabled);
    if (demoting) {
      var remaining = 0;
      for (var j = 0; j < accounts.length; j++) {
        if (j === index) continue;
        if (accounts[j].role === ORG_ROLE.SUPER && accounts[j].enabled !== false) remaining++;
      }
      if (remaining === 0) {
        return {
          ok: false,
          code: 'LASTSUPER',
          error: 'This is the only active Super Admin. Give another organiser that role first, or create one.'
        };
      }
    }

    accounts[index] = next;
    orgStoreWrite_(ORG.ACCOUNTS_PROPERTY, accounts);

    // A PIN reset, a disable, or a role change ends whichever sessions that
    // account is holding, on every device.
    var revoked = 0;
    if (patch.pin !== undefined && patch.pin !== '') revoked = orgRevokeAccountSessions_(next.id);
    if (patch.enabled !== undefined && !next.enabled) revoked += orgRevokeAccountSessions_(next.id);
    if (patch.role !== undefined && next.role !== account.role) revoked += orgRevokeAccountSessions_(next.id);

    return {
      ok: true,
      account: orgPublicAccount_(next),
      sessionsRevoked: revoked,
      actor: actor ? actor.id : ''
    };
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

/** Deletes an account outright. The last Super Admin cannot be removed. */
function orgDeleteAccount_(id) {
  var wanted = orgNormaliseId_(id);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { ok: false, code: 'BUSY', error: 'The account store is busy. Try again in a moment.' };
  }

  try {
    var accounts = orgAccounts_();
    var kept = [];
    var found = false;

    for (var i = 0; i < accounts.length; i++) {
      if (orgNormaliseId_(accounts[i].id) === wanted) { found = true; continue; }
      kept.push(accounts[i]);
    }
    if (!found) return { ok: false, code: 'NOACCOUNT', error: 'That organiser account no longer exists.' };
    if (orgCountSuperAdmins_(kept) === 0) {
      return { ok: false, code: 'LASTSUPER', error: 'This is the only Super Admin. Add another one before deleting it.' };
    }

    orgStoreWrite_(ORG.ACCOUNTS_PROPERTY, kept);
    var revoked = orgRevokeAccountSessions_(wanted);

    return { ok: true, deleted: wanted, sessionsRevoked: revoked };
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

/* ----------------------------- sessions ----------------------------- */

function orgSessions_() {
  return orgStoreRead_(ORG.SESSIONS_PROPERTY);
}

/** Drops expired sessions and caps the store so it can never grow unbounded. */
function orgPruneSessions_(sessions, nowMs, keepTokenHash) {
  var alive = [];
  var perAccount = {};

  // Newest first, so the cap always discards the oldest device.
  var ordered = sessions.slice(0).sort(function (a, b) {
    return (Number(b.seen) || 0) - (Number(a.seen) || 0);
  });

  for (var i = 0; i < ordered.length; i++) {
    var session = ordered[i];
    if (!session || !session.t) continue;

    var expired = nowMs > Number(session.abs) || nowMs > Number(session.idle);
    if (expired && session.t !== keepTokenHash) continue;

    var id = String(session.a || '');
    perAccount[id] = perAccount[id] || 0;
    if (perAccount[id] >= ORG.MAX_SESSIONS_PER_ACCOUNT) continue;
    perAccount[id]++;

    if (alive.length >= ORG.MAX_SESSIONS_TOTAL) continue;
    alive.push(session);
  }

  return alive;
}

function orgCreateSession_(account, device, remember) {
  var now = new Date().getTime();
  var token = orgNewToken_();
  var hash = orgTokenHash_(token);

  var absolute = now + (remember ? ORG.REMEMBER_ABSOLUTE_SECONDS : ORG.ABSOLUTE_SECONDS) * 1000;
  var record = {
    t: hash,
    a: account.id,
    iat: now,
    seen: now,
    idle: now + ORG.IDLE_SECONDS * 1000,
    abs: absolute,
    dev: orgCleanDevice_(device)
  };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { ok: false, code: 'BUSY', error: 'Could not start a session right now. Try again.' };
  }

  try {
    var sessions = orgPruneSessions_(orgSessions_(), now, hash);
    sessions.push(record);
    orgStoreWrite_(ORG.SESSIONS_PROPERTY, sessions);
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }

  return {
    ok: true,
    session: token,
    device: record.dev,
    idleMinutes: Math.round(ORG.IDLE_SECONDS / 60),
    expiresAt: new Date(absolute).toISOString()
  };
}

/**
 * Turns a session token into an actor. Anything expired, revoked, unknown, or
 * belonging to a disabled account is refused, and the stored session is
 * dropped when it is found to be dead.
 */
function orgResolveSession_(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    return { ok: false, code: 'AUTH', error: 'Sign in to continue.' };
  }

  var hash = orgTokenHash_(token);
  var now = new Date().getTime();
  var sessions = orgSessions_();
  var index = -1;

  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i] && sessions[i].t === hash) { index = i; break; }
  }

  if (index === -1) return { ok: false, code: 'SESSION', error: 'Your session is no longer valid. Sign in again.' };

  var session = sessions[index];
  if (now > Number(session.abs) || now > Number(session.idle)) {
    orgDropSession_(hash);
    return { ok: false, code: 'SESSION', error: 'Your session expired. Sign in again.' };
  }

  var account = orgFindAccount_(session.a);
  if (!account || account.enabled === false) {
    orgRevokeAccountSessions_(session.a);
    return {
      ok: false,
      code: 'SESSION',
      error: account ? 'This organiser account has been disabled.' : 'Your account is no longer available.'
    };
  }

  // Sliding idle timeout, written at most once every SLIDE_AFTER_SECONDS so a
  // 30-second auto-refresh does not rewrite the store on every poll.
  if (now - Number(session.seen) > ORG.SLIDE_AFTER_SECONDS * 1000) {
    session.seen = now;
    session.idle = now + ORG.IDLE_SECONDS * 1000;
    sessions[index] = session;
    try {
      orgStoreWrite_(ORG.SESSIONS_PROPERTY, sessions);
    } catch (ignored) {}
  }

  return {
    ok: true,
    actor: {
      id: account.id,
      name: account.name || account.id,
      role: account.role === ORG_ROLE.SUPER ? ORG_ROLE.SUPER : ORG_ROLE.ORGANIZER,
      source: 'session'
    },
    session: { device: session.dev || '', expiresAt: new Date(Number(session.abs)).toISOString() }
  };
}

function orgDropSession_(hash) {
  var sessions = orgSessions_();
  var kept = [];
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i] && sessions[i].t === hash) continue;
    kept.push(sessions[i]);
  }
  orgStoreWrite_(ORG.SESSIONS_PROPERTY, kept);
  return true;
}

function orgRevokeSession_(token) {
  if (typeof token !== 'string' || !token) return 0;
  return orgDropSession_(orgTokenHash_(token)) ? 1 : 0;
}

/** Ends every session an account holds, on every device. */
function orgRevokeAccountSessions_(id) {
  var wanted = orgNormaliseId_(id);
  var sessions = orgSessions_();
  var kept = [];
  var removed = 0;

  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i] && orgNormaliseId_(sessions[i].a) === wanted) { removed++; continue; }
    kept.push(sessions[i]);
  }

  if (removed) orgStoreWrite_(ORG.SESSIONS_PROPERTY, kept);
  return removed;
}

/** Session list for the Super Admin view. Tokens are never included. */
function orgSessionList_() {
  var now = new Date().getTime();
  var sessions = orgPruneSessions_(orgSessions_(), now, '');
  var out = [];

  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i];
    var account = orgFindAccount_(session.a);
    out.push({
      id: String(session.t).slice(0, 10),
      handle: String(session.t),
      organiser: session.a,
      name: account ? (account.name || account.id) : session.a,
      role: account ? account.role : 'UNKNOWN',
      device: session.dev || 'Unnamed device',
      started: new Date(Number(session.iat)).toISOString(),
      lastSeen: new Date(Number(session.seen)).toISOString(),
      expiresAt: new Date(Number(session.abs)).toISOString()
    });
  }

  out.sort(function (a, b) { return a.lastSeen < b.lastSeen ? 1 : -1; });
  return out;
}

/* ---------------------- lockout and rate limiting ---------------------- */

/* Keys are derived from a hash of the submitted id, so a crafted id cannot
   turn into a malformed cache key or collide with another account's counter. */
function orgFailKey_(id) { return 'org_f_' + orgTokenHash_(String(id || '').toLowerCase()).slice(0, 24); }
function orgLockKey_(id) { return 'org_l_' + orgTokenHash_(String(id || '').toLowerCase()).slice(0, 24); }

/** Seconds left on the lockout for this id, or 0 when it is not locked. */
function orgLockRemaining_(id) {
  var cache = CacheService.getScriptCache();
  var lockedUntil = Number(cache.get(orgLockKey_(id)) || 0);
  var left = Math.ceil((lockedUntil - new Date().getTime()) / 1000);
  return left > 0 ? left : 0;
}

function orgRecordLoginFail_(id) {
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get(orgFailKey_(id)) || 0) + 1;
  var window = ORG.LOGIN_FAIL_WINDOW_SECONDS;

  if (fails >= ORG.LOGIN_MAX_FAILS) {
    cache.put(orgLockKey_(id), String(new Date().getTime() + ORG.LOGIN_LOCK_SECONDS * 1000), ORG.LOGIN_LOCK_SECONDS);
    cache.put(orgFailKey_(id), String(fails), window);
    return { locked: true, fails: fails };
  }

  cache.put(orgFailKey_(id), String(fails), window);
  return { locked: false, fails: fails };
}

function orgClearLoginFails_(id) {
  var cache = CacheService.getScriptCache();
  cache.remove(orgFailKey_(id));
  cache.remove(orgLockKey_(id));
}

/* ------------------------------- audit ------------------------------- */

var AUDIT_HEADERS = ['Timestamp', 'Actor', 'Role', 'Action', 'Target', 'Detail', 'Result'];

/**
 * Appends one audit row. Recording must never break the operation it
 * describes: no PIN, no session token and no registration phone number is ever
 * written here, and any failure is swallowed after being logged.
 */
function orgAudit_(actor, action, target, detail, result) {
  try {
    var spreadsheet = openBook_();
    if (!spreadsheet) return false;

    var sheet = spreadsheet.getSheetByName(ORG.AUDIT_SHEET_NAME);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(ORG.AUDIT_SHEET_NAME);
      sheet.getRange(1, 1, 1, AUDIT_HEADERS.length).setValues([AUDIT_HEADERS]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    var who = actor ? (actor.id || '') : '';
    var role = actor ? (actor.role || '') : '';
    var safeDetail = cleanText_(detail).replace(/[\r\n]+/g, ' ').slice(0, 200);

    sheet.appendRow([
      new Date(),
      cleanText_(who).slice(0, ORG.ID_MAX) || 'anonymous',
      cleanText_(role).slice(0, 12),
      cleanText_(action).slice(0, 40),
      cleanText_(target).slice(0, 40),
      safeDetail,
      cleanText_(result).slice(0, 20) || 'ok'
    ]);

    if (sheet.getLastRow() > ORG.AUDIT_MAX_ROWS + 1) {
      sheet.deleteRows(2, sheet.getLastRow() - ORG.AUDIT_MAX_ROWS - 1);
    }

    return true;
  } catch (error) {
    console.log('Audit write failed: ' + messageOf_(error));
    return false;
  }
}

function orgAuditList_(payload) {
  var spreadsheet = openBook_();
  var sheet = spreadsheet ? spreadsheet.getSheetByName(ORG.AUDIT_SHEET_NAME) : null;
  var pageSize = Math.min(Math.max(Number(payload.pageSize) || ORG.AUDIT_PAGE_SIZE, 1), 100);
  var page = Math.max(Number(payload.page) || 1, 1);

  if (!sheet || sheet.getLastRow() < 2) {
    return { ok: true, entries: [], total: 0, page: page, pageSize: pageSize };
  }

  var rows = sheet.getLastRow() - 1;
  var values = sheet.getRange(2, 1, rows, AUDIT_HEADERS.length).getValues();
  var entries = [];

  for (var i = values.length - 1; i >= 0; i--) {
    var at = values[i][0];
    entries.push({
      at: isDate_(at) ? at.toISOString() : cleanText_(at),
      atLabel: isDate_(at)
        ? Utilities.formatDate(at, Session.getScriptTimeZone(), 'dd MMM yyyy, hh:mm a')
        : cleanText_(at),
      actor: cleanText_(values[i][1]),
      role: cleanText_(values[i][2]),
      action: cleanText_(values[i][3]),
      target: cleanText_(values[i][4]),
      detail: cleanText_(values[i][5]),
      result: cleanText_(values[i][6])
    });
  }

  var start = (page - 1) * pageSize;
  return {
    ok: true,
    entries: entries.slice(start, start + pageSize),
    total: entries.length,
    page: page,
    pageSize: pageSize,
    generatedAt: new Date().toISOString()
  };
}

/* --------------------------- sign in and out --------------------------- */

/** Records the last successful sign-in without touching the verifier. */
function orgTouchAccount_(id, device) {
  try {
    var accounts = orgAccounts_();
    for (var i = 0; i < accounts.length; i++) {
      if (orgNormaliseId_(accounts[i].id) === id) {
        accounts[i].lastLogin = new Date().toISOString();
        accounts[i].lastDevice = device;
        orgStoreWrite_(ORG.ACCOUNTS_PROPERTY, accounts);
        return true;
      }
    }
  } catch (ignored) {}
  return false;
}

/**
 * POST ?action=admin with { action:'login', organiserId, pin, device, remember }.
 *
 * Runs before authorisation because its whole job is to create the session.
 * An unknown id is put through exactly the same PBKDF2 work as a real one, so
 * the response time does not say whether the id exists.
 */
function orgLogin_(payload) {
  var id = orgNormaliseId_(payload.organiserId || payload.id);
  var pin = typeof payload.pin === 'string' ? payload.pin : '';
  var device = orgCleanDevice_(payload.device);

  if (!id || id.length > 64 || !pin) {
    return { ok: false, code: 'CREDENTIALS', error: 'Enter your organiser ID and personal PIN.' };
  }

  var locked = orgLockRemaining_(id);
  if (locked > 0) {
    return {
      ok: false,
      code: 'LOCKED',
      retryAfterSeconds: locked,
      error: 'Too many failed attempts. Try again in ' + Math.max(1, Math.ceil(locked / 60)) + ' minute(s).'
    };
  }

  var account = orgFindAccount_(id);
  var matches = false;

  try {
    matches = orgCheckVerifier_(pin, account ? account.verifier : orgDummyVerifier_());
  } catch (error) {
    console.log('PIN verification failed: ' + messageOf_(error));
    return { ok: false, code: 'SERVER', error: 'Could not verify the PIN right now. Try again.' };
  }

  if (!account || !matches) {
    var fail = orgRecordLoginFail_(id);
    orgAudit_({ id: id, role: '' }, 'login', id, fail.locked ? 'locked out' : '', 'refused');
    return {
      ok: false,
      code: 'CREDENTIALS',
      attemptsLeft: Math.max(0, ORG.LOGIN_MAX_FAILS - fail.fails),
      error: fail.locked
        ? 'Too many failed attempts. This ID is locked for ' + Math.max(1, Math.ceil(ORG.LOGIN_LOCK_SECONDS / 60)) + ' minute(s).'
        : 'That organiser ID and PIN do not match.'
    };
  }

  if (account.enabled === false) {
    orgAudit_({ id: id, role: account.role }, 'login', id, 'disabled account', 'refused');
    return { ok: false, code: 'DISABLED', error: 'This organiser account is disabled. Ask a Super Admin to enable it.' };
  }

  orgClearLoginFails_(id);

  var session = orgCreateSession_(account, device, payload.remember === true || payload.remember === 'true');
  if (!session.ok) return session;

  orgTouchAccount_(account.id, device);
  orgAudit_({ id: account.id, role: account.role }, 'login', account.id, device, 'ok');

  return {
    ok: true,
    actor: {
      id: account.id,
      name: account.name || account.id,
      role: account.role === ORG_ROLE.SUPER ? ORG_ROLE.SUPER : ORG_ROLE.ORGANIZER,
      source: 'session'
    },
    session: session.session,
    device: device,
    idleMinutes: session.idleMinutes,
    expiresAt: session.expiresAt,
    permissions: orgPermissionsOf_(account.role)
  };
}

/** Ends the session named by the token. Safe to call with a dead token. */
function orgLogout_(payload) {
  var token = cleanText_(payload.session);
  var revoked = token ? orgRevokeSession_(token) : 0;

  if (revoked) {
    var resolved = null;
    try {
      resolved = null;
    } catch (ignored) {}
    orgAudit_({ id: 'session', role: '' }, 'logout', '', '', 'ok');
  }

  return { ok: true, revoked: revoked };
}

function orgPermissionsOf_(role) {
  return (role === ORG_ROLE.SUPER ? ORG_PERMISSIONS.SUPER : ORG_PERMISSIONS.ORGANIZER).slice(0);
}

/* ------------------------ authorisation and roles ------------------------ */

/**
 * Decides who is calling. A session token is the normal path; the legacy
 * dashboard key is kept as a break-glass Super Admin credential so the owner
 * cannot be locked out of their own tournament, and it can be retired at any
 * time by deleting the admin_key property (see ADMIN.md).
 */
function orgAuthorize_(payload) {
  var token = typeof payload.session === 'string' ? payload.session : '';
  if (token) return orgResolveSession_(token);

  if (adminAuthorized_(payload.key)) {
    return {
      ok: true,
      actor: { id: 'dashboard-key', name: 'Dashboard key', role: ORG_ROLE.SUPER, source: 'key' },
      session: null
    };
  }

  return { ok: false, code: 'AUTH', error: 'Wrong or missing dashboard key.' };
}

/** Server-side permission check. The browser never decides this. */
function orgAllowedTo_(actor, action) {
  var needed = ORG_ACTION_PERMISSION[action];
  if (!needed) return true;
  return orgPermissionsOf_(actor.role).indexOf(needed) !== -1;
}

/* --------------------------- account actions --------------------------- */

/**
 * Returns a result for an account or session action, or null when the action
 * belongs to the registration API below. Every branch re-checks the role: the
 * only reason an Organizer cannot manage organisers is this code, not the
 * fact that the panel is hidden.
 */
function orgHandleAccountAction_(action, payload, actor) {
  if (action === 'session-info') {
    return {
      ok: true,
      actor: actor,
      permissions: orgPermissionsOf_(actor.role),
      session: actor.source === 'session' ? payload.session : null
    };
  }

  if (action === 'account-list') {
    var accounts = orgAccounts_();
    return {
      ok: true,
      accounts: accounts.map(orgPublicAccount_),
      superAdmins: orgCountSuperAdmins_(accounts),
      sessions: orgSessionList_(),
      generatedAt: new Date().toISOString()
    };
  }

  if (action === 'account-create') {
    var created = orgCreateAccount_({
      id: payload.organiserId,
      name: payload.name,
      pin: payload.pin,
      role: payload.role,
      createdBy: actor.id
    });
    if (!created.ok) return created;
    orgAudit_(actor, 'account-create', created.account.id, created.account.role, 'ok');
    return { ok: true, account: created.account, accounts: created.accounts };
  }

  if (action === 'account-update') {
    var update = orgUpdateAccount_(payload.id, {
      role: payload.role,
      enabled: payload.enabled,
      name: payload.name
    }, actor);
    if (!update.ok) return update;
    orgAudit_(actor, 'account-update', update.account.id,
      'role=' + update.account.role + ' enabled=' + update.account.enabled, 'ok');
    return update;
  }

  if (action === 'account-reset-pin') {
    if (payload.pin === undefined || payload.pin === '') {
      return { ok: false, code: 'PIN', error: 'Provide the new PIN.' };
    }
    var reset = orgUpdateAccount_(payload.id, { pin: payload.pin }, actor);
    if (!reset.ok) return reset;
    orgAudit_(actor, 'account-reset-pin', reset.account.id, '', 'ok');
    return { ok: true, account: reset.account, sessionsRevoked: reset.sessionsRevoked };
  }

  if (action === 'account-delete') {
    var deleted = orgDeleteAccount_(payload.id);
    if (!deleted.ok) return deleted;
    orgAudit_(actor, 'account-delete', deleted.deleted, 'sessions=' + deleted.sessionsRevoked, 'ok');
    return deleted;
  }

  if (action === 'session-list') {
    return { ok: true, sessions: orgSessionList_(), generatedAt: new Date().toISOString() };
  }

  if (action === 'session-revoke') {
    var handle = cleanText_(payload.handle);
    if (!/^[A-Za-z0-9_-]{20,44}$/.test(handle)) {
      return { ok: false, code: 'SESSION', error: 'Unknown session.' };
    }
    var sessions = orgSessions_();
    var owner = '';
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i] && sessions[i].t === handle) { owner = sessions[i].a; break; }
    }
    if (!owner) return { ok: false, code: 'SESSION', error: 'That session has already ended.' };
    orgDropSession_(handle);
    orgAudit_(actor, 'session-revoke', owner, 'device=' + cleanText_((payload.device || '')).slice(0, 40), 'ok');
    return { ok: true, revoked: true, organiser: owner };
  }

  if (action === 'account-revoke-sessions') {
    var id = orgNormaliseId_(payload.id);
    if (!orgFindAccount_(id)) return { ok: false, code: 'NOACCOUNT', error: 'That organiser account no longer exists.' };
    var removed = orgRevokeAccountSessions_(id);
    orgAudit_(actor, 'account-revoke-sessions', id, 'ended=' + removed, 'ok');
    return { ok: true, revoked: removed };
  }

  if (action === 'self-change-pin') {
    if (actor.source !== 'session') {
      return { ok: false, code: 'SESSION', error: 'Sign in with your own account to change your PIN.' };
    }

    var me = orgFindAccount_(actor.id);
    if (!me) return { ok: false, code: 'NOACCOUNT', error: 'Your account is no longer available.' };

    var current = typeof payload.currentPin === 'string' ? payload.currentPin : '';
    if (!current || !orgCheckVerifier_(current, me.verifier)) {
      orgAudit_(actor, 'self-change-pin', actor.id, 'wrong current PIN', 'refused');
      return { ok: false, code: 'CREDENTIALS', error: 'Your current PIN is not correct.' };
    }

    var changed = orgUpdateAccount_(actor.id, { pin: payload.newPin }, actor);
    if (!changed.ok) return changed;

    // The change just ended every session for this account, this one included,
    // so a fresh session is issued instead of leaving the organiser signed out
    // mid-task on the device they are holding.
    var account = orgFindAccount_(actor.id);
    var fresh = orgCreateSession_(account, orgCleanDevice_(payload.device), false);
    orgAudit_(actor, 'self-change-pin', actor.id, 'sessions ended=' + changed.sessionsRevoked, 'ok');

    return { ok: true, session: fresh.ok ? fresh.session : '', endsOtherDevices: changed.sessionsRevoked };
  }

  if (action === 'audit-list') {
    var log = orgAuditList_(payload);
    if (log.ok) log.actor = actor;
    return log;
  }

  return null;
}

/* ================================================================
   ROW LOOKUP
   ----------------------------------------------------------------
   Records are addressed by a hash of their timestamp and team name.
   The dashboard recomputes it, so a caller cannot name a row.
   ================================================================ */

/** Finds the 1-based sheet row for a record id, or -1. */
function findRowById_(sheet, id) {
  var rows = countTeams_(sheet);
  if (rows === 0) return -1;

  var values = sheet.getRange(2, 1, rows, HEADERS.length).getValues();
  for (var i = 0; i < values.length; i++) {
    if (recordId_(values[i][COL.TIMESTAMP - 1], cleanText_(values[i][COL.TEAM - 1])) === id) {
      return i + 2;
    }
  }

  return -1;
}

/**
 * Records a team's own payment choice.
 *   ONLINE -> PENDING VERIFICATION (never PAID)
 *   CASH   -> PENDING, until an organiser receives the cash
 * Repeating the same choice is a no-op, so a refresh or a retry cannot create
 * a second state, and a PAID row can never be dragged back to pending by the
 * team that already paid.
 *//* ================================================================
   VERIFIED ONLINE PAYMENTS (YOUPI PG)
   ----------------------------------------------------------------
   The old online flow was a claim dressed up as automation: the team typed
   a reference, the row said PAID, and nothing had checked the money. This
   section replaces it end to end.

   The shape of a payment now:

     1. payorder    Validates the form, snapshots the live fee, opens a
                    session at the configured gateway for exactly that
                    amount, and records the attempt in PaymentDrafts. No
                    registration row exists yet.
     2. paystatus   Asks the gateway, with our secret key, what happened to
                    that session. Only a confirmed payment, in INR, for the
                    exact snapshotted fee, against the session we opened, may
                    register the team.
     3. paywebhook  The provider's doorbell. It is used to find the draft;
                    the amount and the status always come from step 2's API
                    answer. A forged callback therefore cannot create a paid
                    row - it can only make us ask the gateway a question.
     4. finalise    Under a script lock, writes the row once, stores the
                    payment ids and the verified amount, and audits both the
                    payment and the registration.

   Which gateway is used is deployment configuration:

     * YOUPI PG (default) - hosted checkout page on the merchant's own
       instance. The page embeds that checkout. YouPI decides whether money
       arrived by observing bank SMS / Gmail alerts and reports a
       verificationLevel; anything below the configured level is held for an
       organiser instead of registering a team.
   YouPI's signature header cannot be read by Apps Script, so its callback is
   treated as a doorbell: the proof is always a fresh API answer, fetched over
   TLS with the merchant secret. A proxy is only needed if signature-level
   checking is required as well.
   ================================================================ */

var SETTINGS_HEADERS = ['Key', 'Value', 'Updated At', 'Updated By'];
var SETTING_FEE = 'entry_fee';

var DRAFT_HEADERS = [
  'Token', 'Created At', 'Expires At', 'Team', 'Department', 'Members JSON',
  'WhatsApp Consent', 'Fee', 'Currency', 'Order ID', 'QR ID', 'QR Image URL',
  'Status', 'Payment ID', 'Paid Amount', 'Registration ID', 'Last Checked At',
  'Provider', 'Checkout URL', 'Verification'
];

var DCOL = {
  TOKEN: 1, CREATED: 2, EXPIRES: 3, TEAM: 4, DEPT: 5, MEMBERS: 6,
  CONSENT: 7, FEE: 8, CURRENCY: 9, ORDER: 10, QR: 11, QR_IMAGE: 12,
  STATUS: 13, PAYMENT: 14, PAID_AMOUNT: 15, REG: 16, CHECKED: 17,
  PROVIDER: 18, CHECKOUT: 19, VERIFICATION: 20
};

var DRAFT = {
  OPEN: 'OPEN',
  CREATING: 'CREATING',
  FINALISED: 'FINALISED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  MISMATCH: 'MISMATCH',
  UNPLACED: 'PAID - NO SLOT',
  // The gateway says money arrived but its own confidence is below the level
  // this event requires. A human decides; the team is not registered yet.
  UNVERIFIED: 'NEEDS REVIEW'
};

var PAY_ACTOR = { id: 'payment-gateway', role: 'PAYMENT' };

/* ------------------------------ settings ------------------------------ */

function settingsSheet_() {
  var book = openBook_();
  if (!book) throw new Error('No spreadsheet found.');

  var sheet = book.getSheetByName(CONFIG.PAYMENT_SETTINGS_SHEET);
  if (!sheet) {
    sheet = book.insertSheet(CONFIG.PAYMENT_SETTINGS_SHEET);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SETTINGS_HEADERS.length).setValues([SETTINGS_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** All settings as a plain object. A broken tab must never stop a payment. */
function readSettings_() {
  var out = {};
  try {
    var sheet = settingsSheet_();
    var rows = sheet.getLastRow() - 1;
    if (rows < 1) return out;
    var values = sheet.getRange(2, 1, rows, 2).getValues();
    for (var i = 0; i < values.length; i++) {
      var key = cleanText_(values[i][0]);
      if (key) out[key] = cleanText_(values[i][1]);
    }
  } catch (ignored) {}
  return out;
}

/**
 * The live entry fee. The Settings tab is the single source of truth; the
 * constant in CONFIG is only the default for a sheet that has never been
 * configured. Anything unreadable falls back instead of charging a team zero.
 */
function entryFee_() {
  var raw = readSettings_()[SETTING_FEE];
  var value = Number(raw);
  if (isFinite(value) && value >= 1 && value <= 10000) return Math.round(value);
  return CONFIG.TEAM_FEE;
}

function saveEntryFee_(fee, actor) {
  var value = Number(fee);
  if (!isFinite(value) || value < 1 || value > 10000) {
    return { ok: false, code: 'FEE', error: 'The entry fee must be a whole number between 1 and 10000.' };
  }
  value = Math.round(value);

  var sheet = settingsSheet_();
  var rows = Math.max(sheet.getLastRow() - 1, 0);
  var stamp = new Date();
  var who = actor ? actor.id : 'organiser';

  if (rows > 0) {
    var values = sheet.getRange(2, 1, rows, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      if (cleanText_(values[i][0]) === SETTING_FEE) {
        sheet.getRange(i + 2, 2, 1, 3).setValues([[value, stamp, who]]);
        return { ok: true, fee: value };
      }
    }
  }

  sheet.appendRow([SETTING_FEE, value, stamp, who]);
  return { ok: true, fee: value };
}

function publicConfig_() {
  return {
    ok: true,
    fee: entryFee_(),
    currency: CONFIG.PAYMENT_CURRENCY,
    provider: 'YOUPI',
    // The page must not offer a payment it cannot verify. Until the merchant
    // instance is configured the online button is replaced by a plain
    // explanation and cash still works.
    online: youpiConfigured_(),
    // What the page may honestly say about the online path.
    hosted: true,
    label: 'YouPI PG',
    minVerification: youpiMinVerification_(),
    generatedAt: new Date().toISOString()
  };
}

/* --------------------------- provider access --------------------------- */

function propertyOr_(name) {
  try {
    return PropertiesService.getScriptProperties().getProperty(name) || '';
  } catch (ignored) {
    return '';
  }
}

function trimSlash_(value) {
  return cleanText_(value).replace(/\/+$/, '');
}

/* ------------------------------ YouPI PG ------------------------------ */

function youpiBaseUrl_() {
  return trimSlash_(propertyOr_(CONFIG.YOUPI_BASE_URL_PROPERTY));
}

function youpiConfigured_() {
  var base = youpiBaseUrl_();
  if (!/^https?:\/\/[^\s]+$/i.test(base)) return false;
  return !!(propertyOr_(CONFIG.YOUPI_MERCHANT_ID_PROPERTY) &&
           propertyOr_(CONFIG.YOUPI_MERCHANT_KEY_PROPERTY));
}

function youpiMinVerification_() {
  var rawText = cleanText_(propertyOr_(CONFIG.YOUPI_MIN_VERIFICATION_PROPERTY));
  if (!rawText) return CONFIG.YOUPI_DEFAULT_MIN_VERIFICATION;
  var raw = Number(rawText);
  if (!isFinite(raw) || raw < 0 || raw > 2) return CONFIG.YOUPI_DEFAULT_MIN_VERIFICATION;
  return Math.round(raw);
}

/**
 * One call to a self-hosted YouPI PG instance.
 *
 * The merchant key is sent as X-Merchant-Key. YouPI treats that same value as
 * the merchant's webhook secret, so it is kept in Script Properties and never
 * written to a sheet, a log line or a browser response.
 */
function youpiCall_(method, path, payload) {
  var base = youpiBaseUrl_();
  var merchantId = propertyOr_(CONFIG.YOUPI_MERCHANT_ID_PROPERTY);
  var merchantKey = propertyOr_(CONFIG.YOUPI_MERCHANT_KEY_PROPERTY);
  if (!base || !merchantId || !merchantKey) {
    return { ok: false, code: 'NOT_CONFIGURED', error: 'Online payment is not configured yet.' };
  }

  var options = {
    method: method,
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      'X-Merchant-Id': merchantId,
      'X-Merchant-Key': merchantKey
    }
  };
  if (payload) options.payload = JSON.stringify(payload);

  var response;
  try {
    response = UrlFetchApp.fetch(base + path, options);
  } catch (error) {
    return { ok: false, code: 'NETWORK', error: 'The payment gateway could not be reached.' };
  }

  var code = 0;
  var text = '';
  try {
    code = response.getResponseCode();
    text = response.getContentText();
  } catch (ignored) {}

  var body = null;
  try { body = text ? JSON.parse(text) : null; } catch (ignored) {}

  if (code < 200 || code >= 300) {
    return {
      ok: false,
      code: code === 401 ? 'AUTH' : 'PROVIDER',
      status: code,
      error: (body && (body.error || body.message)) || ('The payment gateway returned ' + code + '.')
    };
  }

  return { ok: true, status: code, body: body || {} };
}

/**
 * POST /api/v1/payments on the merchant's own YouPI instance.
 *
 * The order id is generated here (not taken from the browser), the amount is
 * the fee snapshot in rupees with two decimals, and the response's
 * paymentId/checkoutUrl are the only things kept. The customer pays inside
 * YouPI's own checkout page - this site never draws its QR.
 */
function youpiCreatePayment_(token, teamName, fee, expires) {
  var orderId = 'QQSGP-' + String(token).slice(0, 18).toUpperCase();
  var res = youpiCall_('POST', '/api/v1/payments', {
    orderId: orderId,
    amount: Number(fee).toFixed(2),
    currency: CONFIG.PAYMENT_CURRENCY,
    description: 'QQSGP entry fee - ' + cleanText_(teamName).slice(0, 60),
    metadata: { token: token, team: cleanText_(teamName).slice(0, 120), purpose: 'QQSGP entry fee' }
  });
  if (!res.ok) return res;

  var body = res.body || {};
  var paymentId = cleanText_(body.paymentId);
  var checkoutUrl = cleanText_(body.checkoutUrl);
  if (!paymentId) return { ok: false, code: 'PROVIDER', error: 'The gateway did not return a payment id.' };
  if (!/^https?:\/\/[^\s]+$/i.test(checkoutUrl)) {
    return { ok: false, code: 'PROVIDER', error: 'The gateway did not return a checkout page.' };
  }

  // The order id is ours. A gateway answering about some other order must not
  // be allowed to become this draft's identity.
  var echoed = cleanText_(body.orderId);
  if (echoed && echoed !== orderId) {
    return { ok: false, code: 'PROVIDER', error: 'The gateway answered for a different order.' };
  }

  return {
    ok: true,
    paymentId: paymentId,
    orderId: orderId,
    checkoutUrl: checkoutUrl,
    amount: Number(body.amount) || Number(fee),
    currency: cleanText_(body.currency) || CONFIG.PAYMENT_CURRENCY
  };
}

/* ------------------------------ drafts ------------------------------ */

function draftSheet_() {
  var book = openBook_();
  if (!book) throw new Error('No spreadsheet found.');

  var sheet = book.getSheetByName(CONFIG.PAYMENT_DRAFT_SHEET);
  if (!sheet) {
    sheet = book.insertSheet(CONFIG.PAYMENT_DRAFT_SHEET);
  }

  // An existing tab may predate the provider columns. Widen it instead of
  // writing past the last column, which would throw on every payment.
  if (sheet.getMaxColumns() < DRAFT_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), DRAFT_HEADERS.length - sheet.getMaxColumns());
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, DRAFT_HEADERS.length).setValues([DRAFT_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else {
    var header = sheet.getRange(1, 1, 1, DRAFT_HEADERS.length).getValues()[0];
    var missing = false;
    for (var i = 0; i < DRAFT_HEADERS.length; i++) {
      if (cleanText_(header[i]) !== DRAFT_HEADERS[i]) { missing = true; break; }
    }
    if (missing) {
      sheet.getRange(1, 1, 1, DRAFT_HEADERS.length).setValues([DRAFT_HEADERS]).setFontWeight('bold');
    }
  }
  return sheet;
}

function newPaymentToken_() {
  return String(Utilities.getUuid()).replace(/-/g, '');
}

function draftFromValues_(row) {
  return {
    token: cleanText_(row[DCOL.TOKEN - 1]),
    created: row[DCOL.CREATED - 1],
    expiresAt: row[DCOL.EXPIRES - 1],
    teamName: cleanText_(row[DCOL.TEAM - 1]),
    department: cleanText_(row[DCOL.DEPT - 1]),
    membersJson: cleanText_(row[DCOL.MEMBERS - 1]),
    consent: cleanText_(row[DCOL.CONSENT - 1]),
    fee: Number(row[DCOL.FEE - 1]) || 0,
    currency: cleanText_(row[DCOL.CURRENCY - 1]),
    orderId: cleanText_(row[DCOL.ORDER - 1]),
    qrId: cleanText_(row[DCOL.QR - 1]),
    qrImageUrl: cleanText_(row[DCOL.QR_IMAGE - 1]),
    status: cleanText_(row[DCOL.STATUS - 1]),
    paymentId: cleanText_(row[DCOL.PAYMENT - 1]),
    paidAmount: Number(row[DCOL.PAID_AMOUNT - 1]) || 0,
    registrationId: cleanText_(row[DCOL.REG - 1]),
    checkedAt: row[DCOL.CHECKED - 1],
    provider: cleanText_(row[DCOL.PROVIDER - 1]) || 'YOUPI',
    checkoutUrl: cleanText_(row[DCOL.CHECKOUT - 1]),
    verification: cleanText_(row[DCOL.VERIFICATION - 1])
  };
}

function allDrafts_(sheet) {
  var rows = sheet.getLastRow() - 1;
  if (rows < 1) return [];
  var values = sheet.getRange(2, 1, rows, DRAFT_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var draft = draftFromValues_(values[i]);
    draft.row = i + 2;
    if (draft.token) out.push(draft);
  }
  return out;
}

function findDraft_(sheet, token) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(token)) return null;
  var drafts = allDrafts_(sheet);
  for (var i = 0; i < drafts.length; i++) {
    if (drafts[i].token === token) return drafts[i];
  }
  return null;
}

/** Finds a draft by one of the server-generated ids. Never by anything the
 *  browser or a callback body can invent on its own: these ids only exist
 *  because YouPI created them for a session we opened. */
function findDraftByProviderId_(sheet, field, value) {
  if (!value) return null;
  var drafts = allDrafts_(sheet);
  for (var i = 0; i < drafts.length; i++) {
    if (drafts[i][field] === value) return drafts[i];
  }
  return null;
}

function saveDraft_(draft) {
  var sheet = draftSheet_();
  var row = [
    draft.token, new Date(), draft.expiresAt, draft.teamName, draft.department,
    JSON.stringify(draft.members), draft.consent ? 'YES' : 'NO', draft.fee,
    draft.currency, draft.orderId || '', '', '', draft.status || DRAFT.OPEN,
    '', '', '', '', 'YOUPI', draft.checkoutUrl || '', ''
  ];
  var target = sheet.getLastRow() + 1;
  sheet.getRange(target, DCOL.CREATED).setNumberFormat('dd mmm yyyy, hh:mm AM/PM');
  sheet.getRange(target, DCOL.EXPIRES).setNumberFormat('dd mmm yyyy, hh:mm AM/PM');
  sheet.getRange(target, 1, 1, DRAFT_HEADERS.length).setValues([row]);
  return target;
}

function setDraftRow_(sheet, row, fields) {
  if (fields.status) sheet.getRange(row, DCOL.STATUS).setValue(fields.status);
  if (fields.orderId !== undefined) sheet.getRange(row, DCOL.ORDER).setValue(fields.orderId);
  if (fields.checkoutUrl !== undefined) sheet.getRange(row, DCOL.CHECKOUT).setValue(fields.checkoutUrl);
  if (fields.provider !== undefined) sheet.getRange(row, DCOL.PROVIDER).setValue(fields.provider);
  if (fields.paymentId !== undefined) sheet.getRange(row, DCOL.PAYMENT).setValue(fields.paymentId);
  if (fields.paidAmount !== undefined) sheet.getRange(row, DCOL.PAID_AMOUNT).setValue(fields.paidAmount);
  if (fields.registrationId !== undefined) sheet.getRange(row, DCOL.REG).setValue(fields.registrationId);
  if (fields.verification !== undefined) sheet.getRange(row, DCOL.VERIFICATION).setValue(fields.verification);
  sheet.getRange(row, DCOL.CHECKED).setValue(new Date());
}

function draftExpired_(draft) {
  var when = draft.expiresAt;
  if (Object.prototype.toString.call(when) !== '[object Date]') return false;
  return when.getTime() <= new Date().getTime();
}

/* ------------------------ opening a payment ------------------------ */

function openHeldDraftForTeam_(sheet, teamName) {
  var target = cleanText_(teamName).toLowerCase();
  var drafts = allDrafts_(sheet);
  for (var i = 0; i < drafts.length; i++) {
    var draft = drafts[i];
    if ([DRAFT.UNVERIFIED, DRAFT.MISMATCH, DRAFT.UNPLACED].indexOf(draft.status) === -1) continue;
    if (cleanText_(draft.teamName).toLowerCase() === target) return draft;
  }
  return null;
}

function openDraftForTeam_(sheet, teamName) {
  var target = cleanText_(teamName).toLowerCase();
  var drafts = allDrafts_(sheet);
  for (var i = 0; i < drafts.length; i++) {
    var draft = drafts[i];
    if (draft.status !== DRAFT.OPEN && draft.status !== DRAFT.CREATING) continue;
    if (draftExpired_(draft)) continue;
    if (cleanText_(draft.teamName).toLowerCase() === target) return draft;
  }
  return null;
}

/**
 * POST ?action=payorder  { teamName, department, members, whatsappConsent }
 *
 * Nothing is registered here. The team's answers and the fee at this moment
 * are kept in PaymentDrafts, and the page receives a token plus the image URL
 * of a single-use UPI QR for exactly that amount.
 */
/**
 * Answers a payorder request from an attempt that already exists.
 *
 * A draft that never received the gateway's answer (status CREATING, or an
 * OPEN row still missing its ids) is retried with the SAME token: the order
 * id is derived from that token, so YouPI returns the session it already
 * opened instead of creating a competing one. The amount sent is the draft's
 * own fee snapshot, so a later fee change cannot reprice an order that is
 * already in flight.
 */
function resumeYoupiDraft_(draftSheet, open) {
  // A previous request may have timed out after YouPI created the session
  // but before the response reached Apps Script. Retry with the SAME token,
  // so the deterministic orderId lets YouPI return the existing session.
  if (open.status === DRAFT.CREATING || !open.orderId || !open.checkoutUrl) {
    var resumedCreate = youpiCreatePayment_(open.token, open.teamName, open.fee, open.expiresAt);
    if (!resumedCreate.ok) {
      orgAudit_(PAY_ACTOR, 'payment-open-retry-failed', open.token,
        'youpi create retry failed: ' + cleanText_(resumedCreate.error), 'failed');
      return { ok: false, code: 'PROVIDER', error: 'The payment could not be started yet. Please retry shortly.' };
    }
    setDraftRow_(draftSheet, open.row, {
      status: DRAFT.OPEN,
      orderId: resumedCreate.orderId,
      paymentId: resumedCreate.paymentId,
      checkoutUrl: resumedCreate.checkoutUrl,
      provider: 'YOUPI'
    });
    open.status = DRAFT.OPEN;
    open.orderId = resumedCreate.orderId;
    open.paymentId = resumedCreate.paymentId;
    open.checkoutUrl = resumedCreate.checkoutUrl;
    open.provider = 'YOUPI';
  }
  return {
    ok: true,
    resumed: true,
    token: open.token,
    amount: open.fee,
    currency: open.currency || CONFIG.PAYMENT_CURRENCY,
    provider: open.provider || 'YOUPI',
    hosted: true,
    checkoutUrl: open.checkoutUrl,
    expiresAt: open.expiresAt instanceof Date ? open.expiresAt.toISOString() : ''
  };
}

function publicPaymentOrder_(e) {
  if (!youpiConfigured_()) {
    return {
      ok: false,
      code: 'PAYMENT_OFFLINE',
      error: 'Online payment is not switched on yet. Your entry can still be paid in cash.'
    };
  }

  var body = readBody_(e);
  if (!body.ok) return { ok: false, code: 'BODY', error: body.error };

  var payload = body.value || {};

  // The payment choice is not a form field here: choosing online IS opening an
  // order. Anything the browser sends under `payment` is ignored, so nobody can
  // smuggle "PAID" into this path either.
  var formOnly = {};
  for (var key in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && key !== 'payment') {
      formOnly[key] = payload[key];
    }
  }

  var checked = validateRegistration_(formOnly);
  if (!checked.ok) return { ok: false, code: 'FORM', error: checked.error };

  var team = checked.value;
  var fee = entryFee_();
  if (!fee) return { ok: false, code: 'FEE', error: 'The entry fee is not set. Ask an organiser.' };

  var draftSheet = draftSheet_();

  // A team whose earlier payment is already waiting for an organiser must not
  // be handed a second way to pay: that is how someone pays twice.
  var held = openHeldDraftForTeam_(draftSheet, team.teamName);
  if (held) {
    return {
      ok: false,
      code: 'REVIEW',
      error: 'A payment for "' + team.teamName + '" is already being checked by an organiser. ' +
        'Please contact the organisers before paying again.'
    };
  }

  // Resume an attempt that is still inside its window instead of opening a
  // second QR for the same team.
  var open = openDraftForTeam_(draftSheet, team.teamName);
  if (open) return resumeYoupiDraft_(draftSheet, open);

  var token = null;
  var expires = null;
  var draftRow = 0;
  var raced = null;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { ok: false, code: 'BUSY', error: 'The server is busy. Please try again in a few seconds.' };
  }
  try {
    var sheet = adminSheet_();
    ensureHeaders_(sheet);
    if (CONFIG.MAX_TEAMS > 0 && countTeams_(sheet) >= CONFIG.MAX_TEAMS) {
      return { ok: false, code: 'FULL', error: 'All ' + CONFIG.MAX_TEAMS + ' team slots are taken. Registration is closed.' };
    }
    if (hasTeamRegisteredToday_(sheet, team.teamName)) {
      return { ok: false, code: 'DUPLICATE', error: 'A team named "' + team.teamName + '" has already registered today.' };
    }

    // The check above ran before this execution queued for the lock, so it is
    // repeated here. Two clicks arriving together both see "no attempt yet";
    // without this re-check each one would persist its own token and open a
    // competing order for the same team. The network call stays outside the
    // lock - only the one-writer decision is inside it.
    raced = openDraftForTeam_(draftSheet, team.teamName);
    if (!raced) {
      token = newPaymentToken_();
      expires = new Date(new Date().getTime() + CONFIG.PAYMENT_DRAFT_TTL_MINUTES * 60 * 1000);

      // Persist the token and immutable fee/form snapshot BEFORE contacting
      // YouPI. If the request times out after YouPI creates the order, the
      // next attempt finds this CREATING draft and retries with the same
      // deterministic orderId.
      draftRow = saveDraft_({
        token: token,
        expiresAt: expires,
        teamName: team.teamName,
        department: team.department,
        members: team.members,
        consent: team.whatsappConsent === true,
        fee: fee,
        currency: CONFIG.PAYMENT_CURRENCY,
        orderId: '',
        checkoutUrl: '',
        provider: 'YOUPI',
        status: DRAFT.CREATING
      });
    }
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }

  // The other request already owns this team's attempt: continue that one
  // rather than minting a second token beside it.
  if (raced) return resumeYoupiDraft_(draftSheet, raced);

  var created = youpiCreatePayment_(token, team.teamName, fee, expires);
  if (!created.ok) {
    orgAudit_(PAY_ACTOR, 'payment-open-failed', token,
      'youpi create failed; draft retained for idempotent retry: ' + cleanText_(created.error), 'failed');
    return { ok: false, code: 'PROVIDER', error: 'The payment could not be started yet. Please retry shortly.' };
  }
  var orderId = created.orderId;
  var paymentId = created.paymentId;
  var checkoutUrl = created.checkoutUrl;

  // Store the provider identity only after a valid response. A retry after an
  // ambiguous timeout reuses the persisted token/orderId rather than minting
  // another session.
  setDraftRow_(draftSheet, draftRow, {
    status: DRAFT.OPEN,
    orderId: orderId,
    paymentId: paymentId,
    checkoutUrl: checkoutUrl,
    provider: 'YOUPI'
  });

  orgAudit_(PAY_ACTOR, 'payment-opened', orderId || paymentId,
    team.teamName + ' · ₹' + fee + ' ' + CONFIG.PAYMENT_CURRENCY + ' · YOUPI' +
    (paymentId ? ' · session ' + paymentId : ''), 'ok');

  return {
    ok: true,
    token: token,
    amount: fee,
    currency: CONFIG.PAYMENT_CURRENCY,
    provider: 'YOUPI',
    hosted: true,
    checkoutUrl: checkoutUrl,
    expiresAt: expires.toISOString()
  };
}

/* ------------------------ checking a payment ------------------------ */

/**
 * YouPI's own answer about the session we opened, read with the merchant key.
 *
 * The gateway reports its confidence separately from the outcome:
 * verificationLevel 2 means both the bank SMS and the Gmail alert agreed. This
 * deployment can require 2 (the default), because the project's own README
 * says its status alone is not conclusive proof of settlement. Below the
 * required level the money is recorded but the team is NOT registered: the
 * attempt goes to NEEDS REVIEW for an organiser, who can accept it.
 */
function verifyYoupiPayment_(draft) {
  if (!draft.paymentId) return { state: 'PENDING' };

  var res = youpiCall_('GET', '/api/v1/payments/' + encodeURIComponent(draft.paymentId));
  if (!res.ok) return { state: 'PENDING', error: res.error };

  var session = res.body || {};
  var status = cleanText_(session.status).toUpperCase();
  var amountPaise = Number(session.amountPaise);
  if (!isFinite(amountPaise) || !amountPaise) amountPaise = Math.round((Number(session.amount) || 0) * 100);
  var currency = cleanText_(session.currency).toUpperCase();

  if (status === 'CANCELLED') return { state: 'CANCELLED' };
  if (status === 'EXPIRED') return { state: 'EXPIRED' };
  if (status === 'FAILED') return { state: 'FAILED' };
  if (status !== 'SUCCESS') return { state: 'PENDING', paymentStatus: status };

  var expected = Math.round(Number(draft.fee) * 100);
  var proof = {
    state: 'PAID',
    provider: 'YOUPI',
    paymentId: cleanText_(session.paymentId) || draft.paymentId,
    orderId: cleanText_(session.orderId),
    amount: amountPaise,
    currency: currency,
    method: cleanText_(session.method) || 'UPI',
    verificationLevel: Number(session.verificationLevel) || 0,
    verificationTag: cleanText_(session.verificationTag)
  };

  if (!proof.orderId || proof.orderId !== draft.orderId) {
    return { state: 'MISMATCH', reason: 'order', provider: 'YOUPI', paymentId: proof.paymentId,
      amount: amountPaise, currency: currency };
  }
  if (currency !== CONFIG.PAYMENT_CURRENCY) {
    return { state: 'MISMATCH', reason: 'currency', provider: 'YOUPI', paymentId: proof.paymentId,
      amount: amountPaise, currency: currency };
  }
  if (amountPaise !== expected) {
    return { state: 'MISMATCH', reason: 'amount', provider: 'YOUPI', paymentId: proof.paymentId,
      amount: amountPaise, currency: currency };
  }

  if (proof.verificationLevel < youpiMinVerification_()) {
    return {
      state: 'UNVERIFIED',
      provider: 'YOUPI',
      paymentId: proof.paymentId,
      amount: amountPaise,
      currency: currency,
      verificationLevel: proof.verificationLevel,
      reason: 'level'
    };
  }

  return proof;
}

function latestDraftPayment_(draft) {
  return verifyYoupiPayment_(draft);
}

/**
 * Writes the registration row for a verified payment, exactly once.
 *
 * Called under a script lock and safe to call twice: a draft that is already
 * FINALISED returns the same registration id instead of adding a second team.
 */
function finaliseVerifiedPayment_(draft, evidence) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { ok: false, code: 'BUSY', error: 'The sheet is busy. Your payment is safe - refresh in a moment.' };
  }

  try {
    var draftSheet = draftSheet_();
    var fresh = findDraft_(draftSheet, draft.token);
    if (!fresh) return { ok: false, code: 'TOKEN', error: 'Unknown payment.' };

    if (fresh.status === DRAFT.FINALISED) {
      return {
        ok: true, already: true, state: 'PAID', team: fresh.teamName,
        registrationId: fresh.registrationId, amount: fresh.paidAmount || fresh.fee,
        currency: fresh.currency
      };
    }
    var manual = evidence.manual === true;

    // A held-for-review draft may still become valid: YouPI's second observer
    // (Gmail) can upgrade a level-1 payment to level 2 a moment later, and the
    // strongest evidence always wins. A wrong amount or a team that could not
    // be placed is NOT re-opened by a later poll - only an organiser can do
    // that, with a note.
    if (!manual && (fresh.status === DRAFT.UNPLACED || fresh.status === DRAFT.MISMATCH)) {
      return {
        ok: false, code: 'REVIEW', paid: true,
        error: 'This payment is recorded but the team was not registered. An organiser will contact you.'
      };
    }

    if (evidence.state !== 'PAID') {
      return { ok: false, code: 'UNVERIFIED', error: 'The payment has not been verified yet.' };
    }

    var paidAmount = Number(evidence.amount);
    var expected = Math.round(Number(fresh.fee) * 100);
    if (!manual && (paidAmount !== expected || cleanText_(evidence.currency).toUpperCase() !== CONFIG.PAYMENT_CURRENCY)) {
      setDraftRow_(draftSheet, fresh.row, {
        status: DRAFT.MISMATCH, paymentId: evidence.paymentId || '', paidAmount: paidAmount / 100
      });
      orgAudit_(PAY_ACTOR, 'payment-mismatch', fresh.orderId || fresh.paymentId || fresh.qrId,
        'paid ' + paidAmount / 100 + ' ' + evidence.currency + ', expected ' + fresh.fee + ' ' + CONFIG.PAYMENT_CURRENCY, 'refused');
      return {
        ok: false, code: 'MISMATCH', paid: true,
        error: 'The amount received did not match the entry fee. An organiser will check it - nothing was lost.'
      };
    }

    var sheet = adminSheet_();
    ensureHeaders_(sheet);
    var members = [];
    try { members = JSON.parse(fresh.membersJson || '[]'); } catch (ignored) { members = []; }

    if (!members || members.length < MIN_PLAYERS) {
      setDraftRow_(draftSheet, fresh.row, { status: DRAFT.MISMATCH, paymentId: evidence.paymentId, paidAmount: paidAmount / 100 });
      orgAudit_(PAY_ACTOR, 'payment-unusable', fresh.orderId || fresh.qrId, 'draft has no players', 'refused');
      return { ok: false, code: 'REVIEW', paid: true, error: 'The payment could not be matched to a team. An organiser will contact you.' };
    }

    // Money can arrive after the last slot was taken or after a teammate
    // registered the same name: keep the payment, refuse the second entry, and
    // leave a trail an organiser can act on.
    var full = CONFIG.MAX_TEAMS > 0 && countTeams_(sheet) >= CONFIG.MAX_TEAMS;
    var duplicate = hasTeamRegisteredToday_(sheet, fresh.teamName);
    if (full || duplicate) {
      setDraftRow_(draftSheet, fresh.row, {
        status: DRAFT.UNPLACED, paymentId: evidence.paymentId, paidAmount: paidAmount / 100
      });
      orgAudit_(PAY_ACTOR, 'payment-no-slot', fresh.orderId || fresh.qrId,
        fresh.teamName + ' paid ₹' + paidAmount / 100 + ' but ' + (full ? 'the event is full' : 'the team name is already registered'), 'refused');
      return {
        ok: false, code: 'FULL', paid: true,
        error: 'Your payment was received, but the team could not be added automatically. An organiser will contact you.'
      };
    }

    var verifiedAt = new Date();
    var provider = cleanText_(evidence.provider) || fresh.provider || 'YOUPI';
    var level = evidence.verificationLevel === undefined || evidence.verificationLevel === ''
      ? ''
      : Number(evidence.verificationLevel);
    var note = 'Verified by YouPI PG: session ' + evidence.paymentId + ', ₹' +
      (paidAmount / 100) + ' ' + evidence.currency +
      (level === '' ? '' : ', verification level ' + level + '/' + youpiMinVerification_());
    if (manual) {
      note += ' Accepted by organiser ' + cleanText_(evidence.acceptedBy) +
        ' after manual check: ' + cleanText_(evidence.acceptedNote);
    }
    var registration = {
      teamName: fresh.teamName,
      department: fresh.department,
      members: members,
      whatsappConsent: fresh.consent === 'YES',
      consentAt: fresh.consent === 'YES' ? verifiedAt : '',
      payment: {
        method: 'ONLINE',
        status: PAY.PAID,
        fee: Number(fresh.fee),
        utr: evidence.paymentId,
        note: note + '.',
        by: manual ? cleanText_(evidence.acceptedBy) : provider,
        orderId: fresh.orderId,
        paymentId: evidence.paymentId,
        paidAmount: paidAmount / 100,
        paidCurrency: evidence.currency,
        verifiedAt: verifiedAt,
        provider: provider
      }
    };

    var rowNumber = appendRegistration_(sheet, registration);
    refreshBodyStyles_(sheet);
    clearStatsCache_();

    var stamp = sheet.getRange(rowNumber, COL.TIMESTAMP).getValue();
    var registrationId = recordId_(stamp, fresh.teamName);

    setDraftRow_(draftSheet, fresh.row, {
      status: DRAFT.FINALISED,
      paymentId: evidence.paymentId,
      paidAmount: paidAmount / 100,
      registrationId: registrationId,
      verification: manual ? 'MANUAL by ' + cleanText_(evidence.acceptedBy)
        : provider + (level === '' ? '' : ' L' + level)
    });

    orgAudit_(PAY_ACTOR, manual ? 'payment-manual-verified' : 'payment-verified',
      fresh.orderId || fresh.paymentId || fresh.qrId,
      'payment ' + evidence.paymentId + ' · ₹' + (paidAmount / 100) + ' ' + evidence.currency +
      ' · ' + provider + (level === '' ? '' : ' L' + level) + ' · team ' + fresh.teamName, 'verified');
    orgAudit_(PAY_ACTOR, 'registration-created', registrationId,
      fresh.teamName + ' · row ' + rowNumber, 'ok');

    // Nice-to-haves. Neither may undo a registration that has already been
    // written and paid for.
    try { notifyOrganizer_(registration, rowNumber); } catch (ignored) {}
    try { maybeSendReceipt_(sheet, rowNumber); } catch (ignored) {}

    return {
      ok: true,
      state: 'PAID',
      team: fresh.teamName,
      registrationId: registrationId,
      row: rowNumber,
      amount: paidAmount / 100,
      currency: evidence.currency,
      paidAt: verifiedAt.toISOString()
    };
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

/**
 * POST ?action=paystatus  { token }
 * The page polls this. Every answer is derived from YouPI, not from the
 * timestamp of the last poll, so a refresh cannot invent a paid team.
 */
function publicPaymentStatus_(e) {
  var body = readBody_(e);
  if (!body.ok) return { ok: false, code: 'BODY', error: body.error };

  var token = cleanText_(body.value && body.value.token);
  var sheet = draftSheet_();
  var draft = findDraft_(sheet, token);
  if (!draft) return { ok: false, code: 'TOKEN', error: 'That payment is not known here. Start the payment again.' };

  if (draft.status === DRAFT.FINALISED) {
    return {
      ok: true, state: 'PAID', team: draft.teamName,
      registrationId: draft.registrationId, amount: draft.paidAmount || draft.fee,
      currency: draft.currency
    };
  }
  if (draft.status === DRAFT.CANCELLED) return { ok: true, state: 'CANCELLED' };
  if (draft.status === DRAFT.MISMATCH) {
    return { ok: true, state: 'REVIEW', error: 'The payment did not match the entry fee. An organiser will check it.' };
  }
  if (draft.status === DRAFT.UNPLACED) {
    return { ok: true, state: 'REVIEW', error: 'Your payment was received, but the team was not added automatically. An organiser will contact you.' };
  }
  // A YouPI session has its own window and a payment can land a few seconds
  // after ours, so it is always asked before giving up.

  var evidence = latestDraftPayment_(draft);

  if (evidence.state === 'UNVERIFIED') {
    setDraftRow_(sheet, draft.row, {
      status: DRAFT.UNVERIFIED,
      paymentId: evidence.paymentId || '',
      paidAmount: (evidence.amount || 0) / 100,
      verification: 'YOUPI L' + (evidence.verificationLevel || 0)
    });
    orgAudit_(PAY_ACTOR, 'payment-unverified', draft.orderId || draft.paymentId,
      'gateway reported money at verification level ' + (evidence.verificationLevel || 0) +
      ' (needs ' + youpiMinVerification_() + ') · team ' + draft.teamName + ' · held for review', 'review');
    return {
      ok: true, state: 'REVIEW',
      error: 'Your payment was reported by the gateway, but it could not be verified strongly enough to register your team automatically. An organiser will confirm it with you.'
    };
  }

  if (evidence.state === 'CANCELLED' || evidence.state === 'FAILED' || evidence.state === 'EXPIRED') {
    setDraftRow_(sheet, draft.row, { status: DRAFT.CANCELLED });
    orgAudit_(PAY_ACTOR, 'payment-' + evidence.state.toLowerCase(), draft.orderId || draft.paymentId,
      draft.teamName, 'closed');
    return { ok: true, state: evidence.state };
  }

  if (evidence.state === 'PENDING' && draftExpired_(draft)) {
    setDraftRow_(sheet, draft.row, { status: DRAFT.EXPIRED });
    return { ok: true, state: 'EXPIRED' };
  }

  if (evidence.state === 'PAID') {
    var result = finaliseVerifiedPayment_(draft, evidence);
    if (result.ok) {
      return {
        ok: true, state: 'PAID', team: result.team,
        registrationId: result.registrationId, amount: result.amount,
        currency: result.currency, paidAt: result.paidAt
      };
    }
    return { ok: true, state: result.code === 'BUSY' ? 'PENDING' : 'REVIEW', error: result.error };
  }

  if (evidence.state === 'MISMATCH') {
    setDraftRow_(sheet, draft.row, {
      status: DRAFT.MISMATCH, paymentId: evidence.paymentId || '',
      paidAmount: (evidence.amount || 0) / 100
    });
    orgAudit_(PAY_ACTOR, 'payment-mismatch', draft.orderId || draft.paymentId || draft.qrId,
      'paid ' + (evidence.amount || 0) / 100 + ' ' + evidence.currency + ', expected ' + draft.fee, 'refused');
    return { ok: true, state: 'REVIEW', error: 'The amount received did not match the entry fee. An organiser will check it.' };
  }

  return {
    ok: true, state: 'PENDING',
    expiresAt: draft.expiresAt instanceof Date ? draft.expiresAt.toISOString() : ''
  };
}

/** POST ?action=paycancel  { token } - the team backed out. */
function publicPaymentCancel_(e) {
  var body = readBody_(e);
  if (!body.ok) return { ok: false, code: 'BODY', error: body.error };

  var token = cleanText_(body.value && body.value.token);
  var sheet = draftSheet_();
  var draft = findDraft_(sheet, token);
  if (!draft) return { ok: false, code: 'TOKEN', error: 'That payment is not known here.' };

  if (draft.status === DRAFT.FINALISED) {
    return { ok: true, state: 'PAID', team: draft.teamName, registrationId: draft.registrationId };
  }
  if (draft.status !== DRAFT.OPEN) return { ok: true, state: draft.status };

  setDraftRow_(sheet, draft.row, { status: DRAFT.CANCELLED });
  if (draft.paymentId) {
    youpiCall_('POST', '/api/v1/checkout/' + encodeURIComponent(draft.paymentId) + '/cancel', {});
  }
  orgAudit_(PAY_ACTOR, 'payment-cancelled', draft.orderId || draft.paymentId, draft.teamName, 'cancelled');

  return { ok: true, state: 'CANCELLED' };
}

/**
 * POST ?action=paywebhook - the gateway calls this. Only the ids in the body
 * are read; the money is confirmed by latestDraftPayment_ against the session
 * we opened, so a forged body cannot mark anything paid.
 */
function publicPaymentWebhook_(e) {
  var body = readBody_(e);
  if (!body.ok) return { ok: false, code: 'BODY', error: body.error };

  var payload = body.value || {};

  // YouPI PG posts { event, paymentId, orderId, amount, amountPaise, currency,
  // utr, ... } with an X-Gateway-Signature header. Apps Script cannot read
  // request headers, so the signature is NOT checked here and the body is
  // therefore treated as a doorbell only: the gateway is asked directly,
  // with the merchant key, before anything is written.
  if (!payload.payload && (payload.paymentId || payload.orderId) && payload.event) {
    var ySheet = draftSheet_();
    var yDraft = payload.paymentId ? findDraftByProviderId_(ySheet, 'paymentId', cleanText_(payload.paymentId)) : null;
    if (!yDraft && payload.orderId) yDraft = findDraftByProviderId_(ySheet, 'orderId', cleanText_(payload.orderId));
    if (!yDraft) return { ok: true, ignored: true };
    if (yDraft.status === DRAFT.FINALISED) return { ok: true, duplicate: true };

    var yEvidence = latestDraftPayment_(yDraft);
    if (yEvidence.state === 'UNVERIFIED') {
      setDraftRow_(ySheet, yDraft.row, {
        status: DRAFT.UNVERIFIED, paymentId: yEvidence.paymentId || '',
        paidAmount: (yEvidence.amount || 0) / 100,
        verification: 'YOUPI L' + (yEvidence.verificationLevel || 0)
      });
      orgAudit_(PAY_ACTOR, 'payment-unverified', yDraft.orderId || yDraft.paymentId,
        'gateway reported money at verification level ' + (yEvidence.verificationLevel || 0) +
        ' · team ' + yDraft.teamName + ' · held for review', 'review');
      return { ok: true, state: 'REVIEW' };
    }
    if (yEvidence.state !== 'PAID') return { ok: true, state: yEvidence.state || 'PENDING' };

    var yResult = finaliseVerifiedPayment_(yDraft, yEvidence);
    return { ok: true, state: yResult.ok ? 'PAID' : 'PENDING', duplicate: yResult.already === true };
  }

  return { ok: true, ignored: true };
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
    consentAt: isDate_(row[COL.CONSENT_AT - 1]) ? row[COL.CONSENT_AT - 1].toISOString() : '',
    payment: paymentFromRow_(row)
  };
}

/**
 * Payment fields for one row. Rows written before the payment columns existed
 * read as NOT SELECTED with the configured fee, so nothing has to be migrated
 * before the dashboard can show them.
 */
function paymentFromRow_(row) {
  var feeCell = row[COL.FEE - 1];
  var fee = Number(feeCell);
  var recorded = cleanText_(feeCell) !== '' && isFinite(fee) && fee > 0;
  var stamp = row[COL.PAY_AT - 1];
  var method = normalisePaymentMethod_(row[COL.METHOD - 1]);

  return {
    entryFee: recorded ? fee : CONFIG.TEAM_FEE,
    feeRecorded: recorded,
    method: method,
    status: normalisePaymentStatus_(row[COL.PAY_STATUS - 1], method),
    utr: cleanText_(row[COL.UTR - 1]),
    note: cleanText_(row[COL.PAY_NOTE - 1]),
    updatedAt: isDate_(stamp)
      ? Utilities.formatDate(stamp, Session.getScriptTimeZone(), 'dd MMM yyyy, hh:mm a')
      : cleanText_(stamp),
    updatedBy: cleanText_(row[COL.PAY_BY - 1]),
    // Evidence the provider gave us, never what the browser said. Blank on
    // cash rows and on every row written before this existed.
    orderId: cleanText_(row[COL.PAY_ORDER - 1]),
    paymentId: cleanText_(row[COL.PAY_ID - 1]),
    paidAmount: Number(row[COL.PAID_AMOUNT - 1]) || 0,
    paidCurrency: cleanText_(row[COL.PAID_CURRENCY - 1]),
    verifiedAt: isDate_(row[COL.PAY_VERIFIED_AT - 1])
      ? Utilities.formatDate(row[COL.PAY_VERIFIED_AT - 1], Session.getScriptTimeZone(), 'dd MMM yyyy, hh:mm a')
      : cleanText_(row[COL.PAY_VERIFIED_AT - 1]),
    provider: cleanText_(row[COL.PAY_PROVIDER - 1])
  };
}

/**
 * Reads a payment status, tolerating the spellings a hand edit can produce.
 * A row with a method but no status is a team that chose and has not been
 * verified yet — never silently "paid".
 */
function normalisePaymentStatus_(value, method) {
  var text = cleanText_(value).toUpperCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (PAYMENT_STATUSES.indexOf(text) !== -1) return text;
  if (!text) return method ? PAY.PENDING_VERIFICATION : PAY.NOT_SELECTED;
  return PAY.NEEDS_REVIEW;
}

function normalisePaymentMethod_(value) {
  var text = cleanText_(value).toUpperCase();
  if (text === 'ONLINE' || text === 'UPI') return 'ONLINE';
  if (text === 'CASH') return 'CASH';
  return '';
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
  var counts = {
    total: 0, players: 0, PENDING: 0, APPROVED: 0, REJECTED: 0, WAITLISTED: 0,
    // Payment totals are counted separately from approval: a team can be
    // approved and still owe money, or paid and still be awaiting approval.
    onlineAwaiting: 0, cashPending: 0, paid: 0, needsReview: 0, notSelected: 0,
    paidTeams: 0, amountCollected: 0, amountOutstanding: 0,
    // Online payments are confirmed from the team's own UPI reference, so they
    // are counted separately: useful for a spot check at the venue.
    selfReported: 0
  };

  for (var i = 0; i < records.length; i++) {
    var record = records[i];
    var pay = record.payment || {};

    counts.total++;
    counts.players += record.playerCount;
    counts[record.status] = (counts[record.status] || 0) + 1;

    if (pay.status === PAY.PAID) {
      counts.paid++;
      counts.paidTeams++;
      counts.amountCollected += Number(pay.entryFee) || 0;
      if (pay.method === 'ONLINE' && /^TEAM/i.test(String(pay.updatedBy))) {
        counts.selfReported++;
      }
    } else {
      if (pay.status === PAY.PENDING_VERIFICATION) counts.onlineAwaiting++;
      else if (pay.status === PAY.PENDING) counts.cashPending++;
      else if (pay.status === PAY.NEEDS_REVIEW) counts.needsReview++;
      else if (pay.status === PAY.NOT_SELECTED) counts.notSelected++;

      // A rejected payment is not "outstanding": the organisers have decided
      // it will not be collected through this path. Everything else is.
      if (pay.status !== PAY.REJECTED) {
        counts.amountOutstanding += Number(pay.entryFee) || 0;
      }
    }
  }

  counts.fee = entryFee_();
  return counts;
}

function filterRecords_(records, payload) {
  var status = cleanText_(payload.status).toUpperCase();
  var department = cleanText_(payload.department);
  var query = cleanText_(payload.q).toLowerCase();
  var payment = normalisePaymentFilter_(payload.payment);
  var method = normalisePaymentMethod_(payload.method);

  return records.filter(function (record) {
    if (status && status !== 'ALL' && record.status !== status) return false;
    if (department && record.department !== department) return false;
    if (method && record.payment.method !== method) return false;

    if (payment) {
      // Two friendly groupings the dashboard offers on top of the raw statuses.
      if (payment === 'AWAITING') {
        if ([PAY.PENDING, PAY.PENDING_VERIFICATION, PAY.NEEDS_REVIEW].indexOf(record.payment.status) === -1) {
          return false;
        }
      } else if (payment === 'UNPAID') {
        if (record.payment.status === PAY.PAID) return false;
      } else if (record.payment.status !== payment) {
        return false;
      }
    }

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

/** "ALL"/blank means no filter; the two grouped views are handled above. */
function normalisePaymentFilter_(value) {
  var text = cleanText_(value).toUpperCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!text || text === 'ALL') return '';
  if (text === 'AWAITING' || text === 'UNPAID') return text;
  return PAYMENT_STATUSES.indexOf(text) === -1 ? '' : text;
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

  var action = cleanText_(payload.action);

  // Signing in and out are the only calls that run before authorisation: one
  // creates the session and the other destroys it, so neither can depend on
  // already having one.
  if (action === 'login') return orgLogin_(payload);
  if (action === 'logout') return orgLogout_(payload);

  var auth = orgAuthorize_(payload);
  if (!auth.ok) return auth;

  // Role check, on the server, before any sheet data is read.
  if (!orgAllowedTo_(auth.actor, action)) {
    orgAudit_(auth.actor, 'permission-denied', action, '', 'refused');
    return {
      ok: false,
      code: 'FORBIDDEN',
      error: 'Your role (' + auth.actor.role + ') is not allowed to do that.'
    };
  }

  var accountResult = orgHandleAccountAction_(action, payload, auth.actor);
  if (accountResult) return accountResult;

  if (action === 'list') return adminList_(payload);
  if (action === 'status') return adminSetStatus_(payload);
  if (action === 'note') return adminSaveNote_(payload);
  if (action === 'payment-status') return adminSetPayment_(payload, auth.actor);
  if (action === 'export') return adminExport_(payload);
  if (action === 'settings-get') return adminSettingsGet_();
  if (action === 'settings-set') return adminSettingsSet_(payload, auth.actor);
  if (action === 'drafts-list') return adminDraftsList_();
  if (action === 'draft-resolve') return adminDraftResolve_(payload, auth.actor);

  // WhatsApp: configuration, log, retry, and announcements.
  if (action === 'notif-config') return adminNotifConfig_();
  if (action === 'notif-list') return adminNotifList_(payload);
  if (action === 'notif-retry') return adminNotifRetry_(payload);
  if (action === 'announce-preview') return adminAnnouncePreview_(payload);
  if (action === 'announce-send') return adminAnnounceSend_(payload);

  return { ok: false, code: 'ACTION', error: 'Unknown dashboard action.' };
}

/**
 * The live tournament settings. The fee is stored in the sheet, written from
 * the dashboard, and read here so the page and the backend can never disagree
 * about what a team owes.
 */
function adminSettingsGet_() {
  return {
    ok: true,
    fee: entryFee_(),
    currency: CONFIG.PAYMENT_CURRENCY,
    provider: 'YOUPI',
    online: youpiConfigured_(),
    minVerification: youpiMinVerification_(),
    // Read-only facts the organiser needs to trust the dashboard: which
    // gateway is wired in, and whether it is actually reachable/configured.
    hosted: true,
    gatewayHost: youpiBaseUrl_()
  };
}

function adminSettingsSet_(payload, actor) {
  var result = saveEntryFee_(payload.fee, actor);
  if (!result.ok) return result;

  clearStatsCache_();
  orgAudit_(actor, 'settings-fee', String(result.fee), 'entry fee set to ₹' + result.fee, 'ok');

  return { ok: true, fee: result.fee, currency: CONFIG.PAYMENT_CURRENCY };
}

/* --------------------- payments held for review --------------------- */

/**
 * Payment attempts the gateway reported but this project would not register
 * on its own: a wrong amount, a session that could not be placed, or a YouPI
 * payment whose verification level was below the required threshold.
 *
 * These rows are the ONLY way a held payment becomes a team, and only an
 * organiser can press the button. No secret is returned: a draft token, ids
 * and amounts only.
 */
function adminDraftsList_() {
  var sheet = draftSheet_();
  var drafts = allDrafts_(sheet);
  var held = [];

  for (var i = 0; i < drafts.length; i++) {
    var draft = drafts[i];
    if ([DRAFT.UNVERIFIED, DRAFT.MISMATCH, DRAFT.UNPLACED].indexOf(draft.status) === -1) continue;
    held.push({
      token: draft.token,
      teamName: draft.teamName,
      department: draft.department,
      fee: draft.fee,
      currency: draft.currency || CONFIG.PAYMENT_CURRENCY,
      provider: draft.provider || 'YOUPI',
      orderId: draft.orderId,
      paymentId: draft.paymentId,
      paidAmount: draft.paidAmount,
      verification: draft.verification,
      status: draft.status,
      createdAt: draft.created instanceof Date ? draft.created.toISOString() : ''
    });
  }

  held.sort(function (a, b) {
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });

  return {
    ok: true,
    drafts: held.slice(0, 50),
    total: held.length,
    minVerification: youpiMinVerification_(),
    provider: 'YOUPI'
  };
}

/**
 * POST ?action=admin { action: 'draft-resolve', token, decision, note }
 *
 * accept  - the organiser has seen the money (bank statement, UPI app, or the
 *           gateway's own trail) and registers the team as PAID, recording
 *           who accepted it and why.
 * reject  - nothing is registered; the draft is closed with the reason.
 *
 * Idempotent: accepting an already-finalised draft returns the same
 * registration id instead of adding a second team.
 */
function adminDraftResolve_(payload, actor) {
  var token = cleanText_(payload.token);
  var decision = cleanText_(payload.decision).toLowerCase();
  var note = cleanText_(payload.note).slice(0, CONFIG.ADMIN_NOTE_LIMIT);
  if (!token) return { ok: false, code: 'TOKEN', error: 'Which payment?' };
  if (decision !== 'accept' && decision !== 'reject') {
    return { ok: false, code: 'DECISION', error: 'Choose accept or reject.' };
  }

  var sheet = draftSheet_();
  var draft = findDraft_(sheet, token);
  if (!draft) return { ok: false, code: 'TOKEN', error: 'That payment attempt is not in the sheet.' };

  if (draft.status === DRAFT.FINALISED) {
    return { ok: true, already: true, registrationId: draft.registrationId, team: draft.teamName };
  }
  if ([DRAFT.UNVERIFIED, DRAFT.MISMATCH, DRAFT.UNPLACED].indexOf(draft.status) === -1) {
    return { ok: false, code: 'STATUS', error: 'That attempt is not waiting for review.' };
  }

  if (decision === 'reject') {
    if (!note) return { ok: false, code: 'NOTE', error: 'Say why the payment was rejected.' };
    setDraftRow_(sheet, draft.row, { status: DRAFT.CANCELLED });
    orgAudit_(actor, 'payment-rejected', draft.orderId || draft.paymentId || draft.token,
      draft.teamName + ' · ' + note, 'rejected');
    return { ok: true, state: 'REJECTED' };
  }

  if (!note) {
    return { ok: false, code: 'NOTE', error: 'Say how you checked that the money arrived.' };
  }

  var amountPaise = Math.round((Number(draft.paidAmount) || Number(draft.fee)) * 100);
  var provider = draft.provider || 'YOUPI';
  var registered = finaliseVerifiedPayment_(draft, {
    state: 'PAID',
    manual: true,
    provider: provider,
    paymentId: draft.paymentId || draft.orderId || draft.token,
    orderId: draft.orderId,
    amount: amountPaise,
    currency: draft.currency || CONFIG.PAYMENT_CURRENCY,
    verificationLevel: draft.verification ? draft.verification : '',
    acceptedBy: actor ? actor.id : 'organiser',
    acceptedNote: note
  });

  if (!registered.ok && registered.code !== 'REVIEW') return registered;

  orgAudit_(actor, 'payment-manual-accept', draft.orderId || draft.paymentId || draft.token,
    draft.teamName + ' · ₹' + (amountPaise / 100) + ' · ' + note, 'accepted');

  return {
    ok: true,
    state: registered.ok ? 'PAID' : 'REVIEW',
    team: draft.teamName,
    registrationId: registered.registrationId || '',
    amount: amountPaise / 100,
    error: registered.ok ? undefined : registered.error
  };
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

/**
 * The only path to PAID. An organiser records the outcome after checking the
 * money — never because a team typed a reference or showed a screenshot.
 * Payment status and registration status stay independent: marking a team paid
 * does not approve it, and approving a team does not mark it paid.
 */
function adminSetPayment_(payload, actor) {
  var id = cleanText_(payload.id);
  if (!/^[A-Za-z0-9_-]{10,44}$/.test(id)) {
    return { ok: false, code: 'ID', error: 'Unknown registration.' };
  }

  var status = cleanText_(payload.paymentStatus).toUpperCase()
    .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

  if (PAYMENT_STATUSES.indexOf(status) === -1) {
    return { ok: false, code: 'PAYMENT', error: 'Unknown payment status.' };
  }

  // "Not selected" is where a row starts. Letting the dashboard write it back
  // would quietly erase the record of a payment that was looked at.
  if (status === PAY.NOT_SELECTED) {
    return {
      ok: false,
      code: 'PAYMENT',
      error: 'A recorded payment cannot be reset to "not selected". Use Pending if it was never collected.'
    };
  }

  var methodWanted = cleanText_(payload.method);
  var method = methodWanted ? normalisePaymentMethod_(methodWanted) : '';
  if (methodWanted && !method) {
    return { ok: false, code: 'METHOD', error: 'Payment method must be Online or Cash.' };
  }

  var note = cleanText_(payload.note);
  if (note.length > 200) {
    return { ok: false, code: 'NOTE', error: 'The payment note must be 200 characters or fewer.' };
  }
  if (hasMarkup_(note)) {
    return { ok: false, code: 'NOTE', error: 'The payment note contains characters that are not allowed.' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { ok: false, code: 'BUSY', error: 'The sheet is busy. Try again in a moment.' };
  }

  try {
    var sheet = adminSheet_();
    var rowNumber = findRowById_(sheet, id);
    if (rowNumber === -1) {
      return { ok: false, code: 'ID', error: 'That registration no longer exists.' };
    }

    var row = sheet.getRange(rowNumber, 1, 1, HEADERS.length).getValues()[0];
    var current = paymentFromRow_(row);

    // Two devices can act at once. The one holding an older view is told to
    // reload instead of silently overwriting the other's decision.
    var expectedRaw = cleanText_(payload.expectedPayment);
    if (expectedRaw) {
      var expected = normalisePaymentStatus_(expectedRaw, current.method);
      if (current.status !== expected) {
        return {
          ok: false,
          code: 'STALE',
          error: 'This payment was changed somewhere else. Reload and check it again.',
          record: recordFromRow_(rowNumber, row)
        };
      }
    }

    if (status === PAY.PAID && !current.method && !method) {
      return {
        ok: false,
        code: 'METHOD',
        error: 'Set the payment method to Online or Cash before marking it paid.'
      };
    }

    sheet.getRange(rowNumber, COL.PAY_STATUS).setValue(status);
    if (method) sheet.getRange(rowNumber, COL.METHOD).setValue(method);
    if (note) sheet.getRange(rowNumber, COL.PAY_NOTE).setValue(note);
    sheet.getRange(rowNumber, COL.PAY_AT).setValue(new Date());
    sheet.getRange(rowNumber, COL.PAY_BY).setValue(actor ? actor.id : 'organiser');

    // Keep the fee on the row truthful: a blank cell on a pre-fee row should
    // read as the configured fee rather than as "zero rupees owed".
    if (!current.feeRecorded) {
      sheet.getRange(rowNumber, COL.FEE).setValue(CONFIG.TEAM_FEE);
    }

    refreshPaymentStyles_(sheet);

    var after = sheet.getRange(rowNumber, 1, 1, HEADERS.length).getValues()[0];
    var fresh = recordFromRow_(rowNumber, after);

    orgAudit_(
      actor,
      'payment-status',
      id,
      current.status + ' -> ' + fresh.payment.status +
        (method ? ' | method=' + fresh.payment.method : '') +
        (note ? ' | ' + note : ''),
      'ok'
    );

    return {
      ok: true,
      record: fresh,
      counts: adminCounts_(readRecords_(sheet))
    };
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
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
    'Player 3', 'Player 4', 'Status', 'Note',
    'Entry Fee', 'Payment Method', 'Payment Status', 'UTR / Reference',
    'Payment Note', 'Payment Updated At', 'Payment Updated By', 'Record ID'
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
      r.payment.entryFee,
      r.payment.method,
      r.payment.status,
      r.payment.utr,
      r.payment.note,
      r.payment.updatedAt,
      r.payment.updatedBy,
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

/* ==================================================================
   ORGANISER ACCOUNT SETUP
   ------------------------------------------------------------------
   There is no default PIN and no administrator password in this file.
   The first Super Admin is created here, either from the sheet's
   "Tournament" menu (which asks you to type the ID and PIN you want)
   or by running setupSuperAdmin() from the editor, which generates a
   strong random PIN and prints it once.
   ================================================================== */

/** A strong throwaway PIN, e.g. "KK4F-7M2A-QW9Z-3TXE". Printed once only. */
function orgStrongPin_() {
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var groups = [];

  for (var group = 0; group < 4; group++) {
    var piece = '';
    for (var i = 0; i < 4; i++) {
      var uuid = Utilities.getUuid().replace(/[^0-9a-f]/g, '');
      piece += alphabet.charAt(parseInt(uuid.slice(0, 4), 16) % alphabet.length);
    }
    groups.push(piece);
  }

  return groups.join('-');
}

/**
 * Creates the first Super Admin. Run from the Apps Script editor when you have
 * no account yet, or from the sheet menu to type your own ID and PIN.
 * Returns the public account; the PIN is only ever returned when this helper
 * generated it, so it can be shown to you once and then never again.
 */
function setupSuperAdmin(organiserId, pin, name) {
  var existing = orgCountSuperAdmins_(orgAccounts_());

  if (existing > 0 && !(organiserId && pin)) {
    var message = 'A Super Admin already exists (' + existing + ' active). Sign in with it, or run ' +
      'createOrganiserAccount(id, pin, role) to add another account.';
    console.log(message);
    return { ok: false, code: 'EXISTS', error: message };
  }

  var generated = !pin;
  var id = organiserId || 'admin';
  var secret = pin || orgStrongPin_();

  var created = orgCreateAccount_({
    id: id,
    name: name || id,
    pin: secret,
    role: ORG_ROLE.SUPER,
    createdBy: 'setupSuperAdmin'
  });

  if (!created.ok) {
    console.log('Could not create the Super Admin: ' + created.error);
    return created;
  }

  orgAudit_({ id: 'setup', role: 'SUPER' }, 'account-create', created.account.id, 'first super admin', 'ok');

  if (generated) {
    console.log('Super Admin created. Write these down now - the PIN is not stored and cannot be shown again.');
    console.log('Organiser ID: ' + id);
    console.log('PIN: ' + secret);
  } else {
    console.log('Super Admin "' + id + '" created.');
  }

  return { ok: true, account: created.account, pin: generated ? secret : '', generated: generated };
}

/** Adds an account from the editor: createOrganiserAccount('ravi', 'pin1234'). */
function createOrganiserAccount(organiserId, pin, role, name) {
  var created = orgCreateAccount_({
    id: organiserId,
    name: name || organiserId,
    pin: pin,
    role: role === ORG_ROLE.SUPER ? ORG_ROLE.SUPER : ORG_ROLE.ORGANIZER,
    createdBy: 'editor'
  });

  console.log(created.ok
    ? 'Created organiser "' + created.account.id + '" with the ' + created.account.role + ' role.'
    : 'Not created: ' + created.error);

  return created;
}

/** Ends every session for an account from the editor. */
function revokeOrganiserSessions(organiserId) {
  var removed = orgRevokeAccountSessions_(organiserId);
  console.log('Ended ' + removed + ' session(s) for "' + orgNormaliseId_(organiserId) + '".');
  return removed;
}

/** Lists organiser accounts without printing anything secret. */
function organiserStatus() {
  var accounts = orgAccounts_();
  if (!accounts.length) {
    console.log('No organiser accounts yet. Run setupSuperAdmin() to create the first Super Admin.');
    return { ok: true, accounts: [], superAdmins: 0 };
  }

  var lines = ['Organiser accounts (' + accounts.length + '):'];
  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    lines.push('  ' + account.id + ' - ' + account.role +
      (account.enabled === false ? ' [DISABLED]' : '') +
      (account.lastLogin ? ' last in ' + account.lastLogin : ' never signed in'));
  }
  lines.push('Active sessions: ' + orgSessionList_().length);
  console.log(lines.join('\n'));

  return { ok: true, accounts: accounts.map(orgPublicAccount_), superAdmins: orgCountSuperAdmins_(accounts) };
}

/** Confirms the key exists, without ever printing it. */
function adminStatus() {
  var key = PropertiesService.getScriptProperties().getProperty(CONFIG.ADMIN_KEY_PROPERTY) || '';
  console.log(key.length >= 20
    ? 'Dashboard key is configured (' + key.length + ' characters).'
    : 'No dashboard key yet. Run setupAdminKey() first.');
  console.log('Organiser accounts: ' + orgAccounts_().length + ', active sessions: ' + orgSessionList_().length + '.');
}

/* -------------------- sheet menu for organiser accounts -------------------- */

/**
 * These menu items ask for the ID and PIN in the spreadsheet's own dialog, so
 * the first account can be created without ever putting a PIN in a file, a
 * chat or a public page. The PIN is hashed immediately and never shown again.
 */
function menuCreateAccount() {
  var ui = SpreadsheetApp.getUi();

  var first = ui.prompt('Organiser account', 'Organiser ID (letters, numbers, dot, dash or underscore):', ui.ButtonSet.OK_CANCEL);
  if (first.getSelectedButton() !== ui.Button.OK) return;
  var id = orgNormaliseId_(first.getResponseText());

  var second = ui.prompt('Organiser account',
    'Personal PIN for "' + id + '" (' + ORG.PIN_MIN + '+ characters - letters and numbers are stronger than digits alone):',
    ui.ButtonSet.OK_CANCEL);
  if (second.getSelectedButton() !== ui.Button.OK) return;
  var pin = second.getResponseText();

  var roleAnswer = ui.prompt('Organiser account', 'Role: type SUPER or ORGANIZER.', ui.ButtonSet.OK_CANCEL);
  if (roleAnswer.getSelectedButton() !== ui.Button.OK) return;
  var role = cleanText_(roleAnswer.getResponseText()).toUpperCase() === 'SUPER' ? ORG_ROLE.SUPER : ORG_ROLE.ORGANIZER;

  if (orgCountSuperAdmins_(orgAccounts_()) === 0) role = ORG_ROLE.SUPER;

  var created = orgCreateAccount_({ id: id, name: id, pin: pin, role: role, createdBy: 'sheet-menu' });
  orgAudit_({ id: 'sheet-menu', role: 'SUPER' }, 'account-create', id, created.ok ? role : created.error, created.ok ? 'ok' : 'refused');

  showAlert_(created.ok ? 'Organiser created' : 'Not created', created.ok
    ? '"' + created.account.id + '" can now sign in on the dashboard as ' + created.account.role +
      '. The PIN is not stored - if it is lost, use "reset a PIN".'
    : created.error);
}

function menuResetPin() {
  var ui = SpreadsheetApp.getUi();

  var first = ui.prompt('Reset a PIN', 'Organiser ID:', ui.ButtonSet.OK_CANCEL);
  if (first.getSelectedButton() !== ui.Button.OK) return;
  var id = orgNormaliseId_(first.getResponseText());

  var second = ui.prompt('Reset a PIN', 'New PIN for "' + id + '":', ui.ButtonSet.OK_CANCEL);
  if (second.getSelectedButton() !== ui.Button.OK) return;

  var reset = orgUpdateAccount_(id, { pin: second.getResponseText() }, { id: 'sheet-menu', role: 'SUPER' });
  orgAudit_({ id: 'sheet-menu', role: 'SUPER' }, 'account-reset-pin', id, reset.ok ? 'ok' : reset.error, reset.ok ? 'ok' : 'refused');

  showAlert_(reset.ok ? 'PIN reset' : 'Not reset', reset.ok
    ? 'The new PIN is active and ' + reset.sessionsRevoked + ' existing session(s) have ended.'
    : reset.error);
}

function menuToggleAccount() {
  var ui = SpreadsheetApp.getUi();

  var first = ui.prompt('Enable or disable', 'Organiser ID:', ui.ButtonSet.OK_CANCEL);
  if (first.getSelectedButton() !== ui.Button.OK) return;
  var id = orgNormaliseId_(first.getResponseText());

  var account = orgFindAccount_(id);
  if (!account) { showAlert_('Unknown account', 'No organiser account called "' + id + '".'); return; }

  var next = account.enabled === false;
  var answer = ui.alert('Confirm', (next ? 'Enable' : 'Disable') + ' "' + id + '"?', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  var updated = orgUpdateAccount_(id, { enabled: next }, { id: 'sheet-menu', role: 'SUPER' });
  orgAudit_({ id: 'sheet-menu', role: 'SUPER' }, 'account-update', id, 'enabled=' + next + ' ' + (updated.ok ? 'ok' : updated.error), updated.ok ? 'ok' : 'refused');

  showAlert_(updated.ok ? 'Account updated' : 'Not updated', updated.ok
    ? id + ' is now ' + (next ? 'enabled' : 'disabled') + '. ' + updated.sessionsRevoked + ' session(s) ended.'
    : updated.error);
}

function menuRevokeSessions() {
  var ui = SpreadsheetApp.getUi();

  var answer = ui.prompt('Sign out everywhere', 'Organiser ID (leave empty for every account):', ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;

  var id = orgNormaliseId_(answer.getResponseText());
  var removed;

  if (!id) {
    removed = 0;
    var accounts = orgAccounts_();
    for (var i = 0; i < accounts.length; i++) removed += orgRevokeAccountSessions_(accounts[i].id);
  } else {
    removed = orgRevokeAccountSessions_(id);
  }

  orgAudit_({ id: 'sheet-menu', role: 'SUPER' }, 'account-revoke-sessions', id || 'all', 'ended=' + removed, 'ok');
  showAlert_('Sessions ended', 'Ended ' + removed + ' session(s). Those devices must sign in again.');
}

function menuListAccounts() {
  var accounts = orgAccounts_();

  if (!accounts.length) {
    showAlert_('No accounts yet', 'Use "Organiser accounts: create" to add the first Super Admin.');
    return;
  }

  var sessions = orgSessionList_();
  var lines = [];

  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    var mine = sessions.filter(function (session) { return session.organiser === account.id; });
    lines.push(account.id + '  -  ' + account.role +
      (account.enabled === false ? '  [DISABLED]' : '') +
      '  -  ' + mine.length + ' session(s)' +
      (account.lastLogin ? '  -  last in ' + account.lastLogin : '  -  never signed in'));
  }

  showAlert_('Organiser accounts (' + accounts.length + ')', lines.join('\n'));
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
  var spreadsheet = sheetId_()
    ? SpreadsheetApp.openById(sheetId_())
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
