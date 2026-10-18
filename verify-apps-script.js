/*
  Harness that runs apps-script.js against a mocked Apps Script runtime
  so the doPost / doGet paths can be exercised without touching a real sheet.
  Run: node verify-apps-script.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SOURCE = fs.readFileSync(path.join(__dirname, 'apps-script.js'), 'utf8');

/* ------------------------- mock spreadsheet ------------------------- */

class Grid {
  constructor(rows = 1000, cols = 26) {
    this.rows = rows;
    this.cols = cols;
    this.cells = Array.from({ length: rows }, () => new Array(cols).fill(''));
  }
  lastRow() {
    for (let r = this.rows - 1; r >= 0; r--) {
      if (this.cells[r].some(v => v !== '' && v !== null && v !== undefined)) return r + 1;
    }
    return 0;
  }
}

class Range {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1) throw new Error('Invalid range start ' + row + ',' + col);
    if (row + numRows - 1 > sheet.grid.rows) throw new Error('Range exceeds sheet rows');
    if (col + numCols - 1 > sheet.grid.cols) throw new Error('Range exceeds sheet columns');
    Object.assign(this, { sheet, row, col, numRows, numCols });
    this.formats = [];
    this.backgrounds = 0;
    this.borders = 0;
    this.validation = null;
  }
  setDataValidation(rule) {
    this.validation = rule;
    // Register every cell in the range, the way a real dropdown covers the range.
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        this.sheet.validationCells[(this.row + r) + ',' + (this.col + c)] = rule;
      }
    }
    return this;
  }
  clearDataValidations() {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        delete this.sheet.validationCells[(this.row + r) + ',' + (this.col + c)];
      }
    }
    this.sheet.calls.clearDataValidations = (this.sheet.calls.clearDataValidations || 0) + 1;
    return this;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        line.push(this.sheet.grid.cells[this.row - 1 + r][this.col - 1 + c]);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.numRows) throw new Error('setValues row mismatch ' + values.length + ' vs ' + this.numRows);
    values.forEach((line, r) => {
      if (line.length !== this.numCols) throw new Error('setValues column mismatch ' + line.length + ' vs ' + this.numCols);
      line.forEach((value, c) => {
        this.sheet.grid.cells[this.row - 1 + r][this.col - 1 + c] = value;
      });
    });
    this.sheet.calls.setValues++;
    return this;
  }
  // Single-cell write, used by the dashboard when it changes a status or note.
  setValue(value) {
    if (this.numRows !== 1 || this.numCols !== 1) throw new Error('setValue needs a single cell');
    this.sheet.grid.cells[this.row - 1][this.col - 1] = value;
    this.sheet.calls.setValue = (this.sheet.calls.setValue || 0) + 1;
    return this;
  }
  setNumberFormat(f) { this.formats.push(f); this.sheet.calls.setNumberFormat++; return this; }
  setBackground() { this.backgrounds++; return this; }
  setBackgrounds(rows) {
    if (rows.length !== this.numRows) throw new Error('setBackgrounds row mismatch');
    this.backgrounds++; this.sheet.calls.setBackgrounds++; return this;
  }
  setBorder() { this.borders++; return this; }
  setFontColor() { return this; }
  setFontWeight() { return this; }
  setFontSize() { return this; }
  setVerticalAlignment() { return this; }
  setHorizontalAlignment() { return this; }
  setWrap() { return this; }

  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        this.sheet.grid.cells[this.row - 1 + r][this.col - 1 + c] = '';
      }
    }
    return this;
  }
}

class Sheet {
  constructor(name, spreadsheet) {
    this.name = name;
    this.spreadsheet = spreadsheet;
    this.grid = new Grid();
    this.calls = { setValues: 0, setNumberFormat: 0, setBackgrounds: 0 };
    this.frozenRows = 0;
    this.frozenColumns = 0;
    this.rules = [];
    this.columnWidths = {};
    this.validationCells = {};
    this.tabColor = null;
  }
  getName() { return this.name; }
  getLastRow() { return this.grid.lastRow(); }
  getMaxRows() { return this.grid.rows; }
  getMaxColumns() { return this.grid.cols; }
  getRange(row, col, numRows, numCols) {
    if (typeof row === 'string') throw new Error('A1 notation not supported in this harness');
    return new Range(this, row, col, numRows === undefined ? 1 : numRows, numCols === undefined ? 1 : numCols);
  }
  insertColumnsAfter(after, count) {
    if (after > this.grid.cols) throw new Error('insertColumnsAfter out of range');
    for (const line of this.grid.cells) {
      for (let i = 0; i < count; i++) line.splice(after, 0, '');
    }
    this.grid.cols += count;
  }
  setRowHeight() { return this; }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  setFrozenColumns(n) { this.frozenColumns = n; return this; }
  setTabColor(c) { this.tabColor = c; return this; }
  setColumnWidth(i, w) { this.columnWidths[i] = w; return this; }
  setConditionalFormatRules(rules) { this.rules = rules; return this; }
}

class Spreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) {
    const sheet = new Sheet(name, this);
    this.sheets[name] = sheet;
    return sheet;
  }
}

const spreadsheet = new Spreadsheet();
const cacheStore = new Map();
const propsStore = new Map();
const scriptProps = new Map();
const emails = [];
const log = [];

/* Scriptable WhatsApp provider. Tests queue the next response (or an exception)
   so the delivery states (accepted / rejected / no answer) can all be reached
   without touching Meta. */
const fetchCalls = [];
const fetchQueue = [];
let waMessageCounter = 0;

function queueFetch(entry) { fetchQueue.push(entry); }
function resetFetch() { fetchCalls.length = 0; fetchQueue.length = 0; }

function builder(body) {
  const api = {};
  // Mirrors the real DataValidationBuilder / ConditionalFormatRuleBuilder
  // surface, so calling a method Apps Script does not actually have fails here
  // rather than silently degrading on the live sheet.
  const chain = [
    'requireValueInList', 'setAllowInvalid', 'setHelpText',
    'whenFormulaSatisfied', 'whenNumberGreaterThan', 'whenNumberLessThan',
    'whenTextContains', 'whenDateAfter', 'whenDateBefore',
    'setBackground', 'setBackgroundObject',
    'setFontColor', 'setFontColorObject', 'setBold', 'setItalic',
    'setUnderline', 'setStrikethrough', 'setRanges'
  ];
  chain.forEach(method => { api[method] = (...args) => { body[method] = args; return api; }; });
  api.build = () => ({ kind: 'rule', ...body });
  return api;
}

const sandbox = {
  console: { log: m => log.push(String(m)), error: m => log.push('ERROR ' + m), warn: m => log.push('WARN ' + m) },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => spreadsheet,
    openById: () => spreadsheet,
    newDataValidation: () => builder({}),
    newConditionalFormatRule: () => builder({}),
    BorderStyle: { SOLID: 'SOLID', SOLID_MEDIUM: 'SOLID_MEDIUM' },
    getUi: () => { throw new Error('no UI in harness'); }
  },
  ContentService: {
    createTextOutput: text => ({
      _text: text,
      _mime: null,
      setMimeType(m) { this._mime = m; return this; },
      getContent() { return this._text; },
      getMimeType() { return this._mime; },
      // Real TextOutput exposes setContent(); the harness needs it for the
      // webhook challenge, which must answer plain text rather than JSON.
      setContent(text) { this._text = text; return this; }
    }),
    MimeType: { JSON: 'application/json', TEXT: 'text/plain' }
  },
  CacheService: {
    getScriptCache: () => ({
      get: k => (cacheStore.has(k) ? cacheStore.get(k) : null),
      put: (k, v) => cacheStore.set(k, v),
      remove: k => cacheStore.delete(k)
    })
  },
  PropertiesService: {
    getDocumentProperties: () => ({
      getProperty: k => (propsStore.has(k) ? propsStore.get(k) : null),
      setProperty: (k, v) => propsStore.set(k, v)
    }),
    // The admin key lives here in the real runtime: per-script, never published.
    getScriptProperties: () => ({
      getProperty: k => (scriptProps.has(k) ? scriptProps.get(k) : null),
      setProperty: (k, v) => scriptProps.set(k, v)
    })
  },
  LockService: {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
  },
  Utilities: {
    formatDate: (date, tz, fmt) => {
      // Real Apps Script is backed by java.text.SimpleDateFormat, where every
      // unquoted A-Z/a-z character is a pattern letter and anything outside the
      // documented set makes the call throw "Invalid argument: <pattern>".
      // A naive string-replace mock happily accepts such patterns, which is how
      // an invalid 'AM/PM' token once shipped while the suite stayed green.
      const LEGAL_PATTERN_LETTERS = 'GyYMLwWDdFEuaHkKhmsSzZX';
      let inQuote = false;
      for (let i = 0; i < fmt.length; i++) {
        const ch = fmt.charAt(i);
        if (ch === "'") { inQuote = !inQuote; continue; }
        if (!inQuote && /[A-Za-z]/.test(ch) && LEGAL_PATTERN_LETTERS.indexOf(ch) === -1) {
          throw new Error('Invalid argument: ' + fmt);
        }
      }

      const pad = n => String(n).padStart(2, '0');
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      let h = date.getHours();
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return fmt
        .replace('yyyy', date.getFullYear())
        .replace('MMM', months[date.getMonth()].toUpperCase())
        .replace('mmm', months[date.getMonth()])
        .replace('dd', pad(date.getDate()))
        .replace('hh', pad(h))
        .replace('mm', pad(date.getMinutes()))
        .replace('AM/PM', ampm)
        .replace(/\ba\b/, ampm);
    }
  },
  // DigestAlgorithm is an enum in Apps Script; the mock only needs the member
  // the script actually asks for.
  // (attached to Utilities below, after the object literal closes)
  Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
  MailApp: { sendEmail: (...args) => emails.push(args) },
  UrlFetchApp: {
    fetch: (url, options) => {
      fetchCalls.push({ url: url, options: options });
      const next = fetchQueue.length ? fetchQueue.shift() : null;
      if (next && next.throws) throw new Error(next.throws);
      if (next) {
        return {
          getResponseCode: () => next.code,
          getContentText: () => next.body
        };
      }
      // Default: the provider accepts the message and returns a message id.
      waMessageCounter++;
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ messages: [{ id: 'wamid.TEST' + waMessageCounter }] })
      };
    }
  }
};

// Apps Script's digest returns signed bytes; records only care that the same
// input always produces the same id, so a real SHA-256 keeps that property.
const realDigest = sandbox.Utilities.computeDigest;
sandbox.Utilities.DigestAlgorithm = { SHA_256: 'SHA_256' };
sandbox.Utilities.computeDigest = (algorithm, value) => {
  const buffer = crypto.createHash('sha256').update(String(value), 'utf8').digest();
  return Array.from(buffer).map(b => (b > 127 ? b - 256 : b));
};
sandbox.Utilities.base64EncodeWebSafe = (bytes) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.map(b => (b + 256) % 256));
  return buffer.toString('base64url');
};
sandbox.Utilities.getUuid = () => crypto.randomUUID();

vm.createContext(sandbox);
vm.runInContext(SOURCE, sandbox, { filename: 'apps-script.js' });

/* ------------------------------- tests ------------------------------- */

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

function post(payload, rawBody) {
  const body = rawBody !== undefined ? rawBody : JSON.stringify(payload);
  return JSON.parse(sandbox.doPost({ postData: { contents: body } }).getContent());
}

function stats() {
  return JSON.parse(sandbox.doGet({ parameter: { action: 'stats' } }).getContent());
}

function validPayload(teamName) {
  return {
    submittedAt: new Date().toISOString(),
    teamName: teamName,
    department: 'CSE — Computer Science Engineering',
    members: [
      { player: 1, name: 'PHANTOM', whatsapp: '7075593104' },
      { player: 2, name: 'FENZ', whatsapp: '9390159068' },
      { player: 3, name: 'QENZ', whatsapp: '' },
      { player: 4, name: 'DON', whatsapp: '' }
    ]
  };
}

/** The same payload, cut down to a short-handed squad. */
function shortPayload(teamName, playerCount) {
  const payload = validPayload(teamName);
  payload.members = payload.members.slice(0, playerCount);
  return payload;
}

const sheet = spreadsheet.insertSheet('Registrations');

console.log('\n1. helpers');
check('columnLetter_(5) is E', sandbox.columnLetter_(5) === 'E', sandbox.columnLetter_(5));
check('columnLetter_(7) is G', sandbox.columnLetter_(7) === 'G', sandbox.columnLetter_(7));
check('columnLetter_(27) is AA', sandbox.columnLetter_(27) === 'AA', sandbox.columnLetter_(27));

console.log('\n2. first registration');
const first = post(validPayload('Shadow Squad'));
check('responds ok', first.ok === true, JSON.stringify(first));
check('reports 1 team', first.teams === 1, JSON.stringify(first));
check('reports 4 players', first.players === 4, JSON.stringify(first));
check('row 1 is the header', sheet.grid.cells[0][1] === 'Team Name', sheet.grid.cells[0][1]);
// The contract grew by Status and Note so the organiser dashboard can work on
// the same rows the registrations already land in.
check('header has 13 columns', sandbox.HEADERS.length === 13 &&
  sheet.grid.cells[0][8] === 'Player 4 Name' &&
  sheet.grid.cells[0][9] === 'Status' &&
  sheet.grid.cells[0][10] === 'Note' &&
  sheet.grid.cells[0][11] === 'WhatsApp Consent' &&
  sheet.grid.cells[0][12] === 'Consent At',
  JSON.stringify(sheet.grid.cells[0].slice(0, 13)));
check('writes the row and marks it PENDING',
  sheet.grid.cells[1].slice(0, 9).filter(v => v !== '').length === 9 &&
  String(sheet.grid.cells[1][9]) === 'PENDING' &&
  String(sheet.grid.cells[1][10] || '') === '',
  JSON.stringify(sheet.grid.cells[1].slice(0, 13)));
// No consent box was ticked on this payload, so the opt-in must be a plain NO
// and no consent timestamp may be written.
check('consent defaults to NO when not given',
  String(sheet.grid.cells[1][11]) === 'NO' && String(sheet.grid.cells[1][12] || '') === '',
  JSON.stringify(sheet.grid.cells[1].slice(11, 13)));
check('timestamp is a real Date', Object.prototype.toString.call(sheet.grid.cells[1][0]) === '[object Date]');
check('team name stored', sheet.grid.cells[1][1] === 'Shadow Squad');
check('phone 1 stored', String(sheet.grid.cells[1][4]) === '7075593104');
check('player 3 name stored', sheet.grid.cells[1][7] === 'QENZ');
check('header formatted', sheet.calls.setValues > 0);
check('frozen header row', sheet.frozenRows === 1);
check('duplicate rules installed', sheet.rules.length === 2, String(sheet.rules.length));
check('department dropdown installed', sheet.validationCells['2,3'] !== undefined);
// Regression guard: a dropdown stamped onto hundreds of empty rows put an arrow
// in every one of them and made the sheet look broken.
check(
  'dropdown stops near the data instead of running to row 1000',
  sheet.validationCells['900,3'] === undefined,
  'row 900 still has a dropdown'
);
check(
  'the registered row keeps its dropdown',
  sheet.validationCells['2,3'] !== undefined,
  'the registered row lost its dropdown'
);
check(
  'the first empty row has no dropdown arrow',
  sheet.validationCells['3,3'] === undefined,
  'row 3 shows a stray dropdown arrow'
);
check(
  'stale dropdowns below the runway are cleared',
  sheet.calls.clearDataValidations > 0,
  'clearDataValidations was never called'
);
check('no chatter past the last column',
  sheet.grid.cells[0].slice(13).every(v => v === '') && sheet.grid.cells[1].slice(13).every(v => v === ''));

console.log('\n3. duplicate and counter');
const dup = post(validPayload('Shadow Squad'));
check('same team same day is rejected', dup.ok === false && /already registered/i.test(dup.error), JSON.stringify(dup));

const second = post(validPayload('Black Nugget'));
check('different team accepted', second.ok === true, JSON.stringify(second));
check('counter now 2 teams', second.teams === 2, JSON.stringify(second));
check('counter now 8 players', second.players === 8, JSON.stringify(second));

const live = stats();
check('doGet stats ok', live.ok === true, JSON.stringify(live));
check('stats teams = 2', live.teams === 2);
check('stats players = 8', live.players === 8);
check('stats departments = 1', live.departments === 1, JSON.stringify(live.byDepartment));
check('stats lastRegistration set', typeof live.lastRegistration === 'string' && live.lastRegistration.length > 0);
// Regression guard. The am/pm marker is a lowercase 'a'; an uppercase 'AM/PM'
// is not a SimpleDateFormat pattern letter and makes real Apps Script throw
// "Invalid argument", which previously zeroed out the whole stats response and
// left the live counter stuck on dashes.
check(
  'stats lastRegistration uses a legal date pattern',
  /^\d{2} [A-Za-z]{3}, \d{2}:\d{2} (AM|PM)$/.test(live.lastRegistration),
  'got: ' + JSON.stringify(live.lastRegistration)
);
check(
  'mock rejects illegal pattern letters exactly like SimpleDateFormat',
  (() => {
    try {
      sandbox.Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd MMM, hh:mm AM/PM');
      return false;
    } catch (e) {
      return /Invalid argument/.test(e.message);
    }
  })()
);
check(
  'a bad pattern really would break the stats endpoint',
  (() => {
    try {
      sandbox.Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MMMM');
      return true; // 'yyyy-MMMM' is legal, so this must NOT throw
    } catch (e) {
      return false;
    }
  })()
);

console.log('\n4. bad input is rejected, never written');
const before = sheet.getLastRow();
const cases = [
  ['missing team name', Object.assign(validPayload('X'), { teamName: '' })],
  ['one character team name', Object.assign(validPayload('X'), { teamName: 'A' })],
  ['team name with html', Object.assign(validPayload('X'), { teamName: '<script>x</script>' })],
  ['bad department', Object.assign(validPayload('Xy'), { department: 'Hacking Engineering' })],
  ['missing department', Object.assign(validPayload('Xy'), { department: '' })],
  ['only 1 player', shortPayload('Xy', 1)],
  ['5 players', (() => {
    const p = validPayload('Xy');
    p.members = p.members.concat([{ player: 5, name: 'FIVE', whatsapp: '' }]);
    return p;
  })()],
  ['the same number for both players', (() => {
    const p = validPayload('Xy');
    p.members[1].whatsapp = p.members[0].whatsapp;
    return p;
  })()],
  ['9-digit phone', (() => { const p = validPayload('Xy'); p.members[0].whatsapp = '707559310'; return p; })()],
  ['letters in phone', (() => { const p = validPayload('Xy'); p.members[1].whatsapp = 'abcdefghij'; return p; })()],
  ['blank player 3 name', (() => { const p = validPayload('Xy'); p.members[2].name = '   '; return p; })()],
  ['all-zero phone', (() => { const p = validPayload('Xy'); p.members[0].whatsapp = '0000000000'; return p; })()]
];
cases.forEach(([label, payload]) => {
  const result = post(payload);
  check('rejects ' + label, result.ok === false && typeof result.error === 'string' && result.error.length > 0, JSON.stringify(result));
});

const broken = post(null, 'this is not json');
check('rejects malformed JSON body', broken.ok === false, JSON.stringify(broken));
const empty = JSON.parse(sandbox.doPost({}).getContent());
check('rejects empty request', empty.ok === false, JSON.stringify(empty));
check('nothing invalid reached the sheet', sheet.getLastRow() === before, sheet.getLastRow() + ' vs ' + before);

console.log('\n5. team limit');
sandbox.CONFIG.MAX_TEAMS = 2;
const capped = post(validPayload('Third Team'));
check('rejects a third team when max is 2', capped.ok === false && /slots are taken/i.test(capped.error), JSON.stringify(capped));
sandbox.CONFIG.MAX_TEAMS = 0;

console.log('\n6. header repair');
sheet.grid.cells[0][8] = 'Player 9 Name';
sheet.grid.cells[0][9] = 'Player 3 WhatsApp';
sandbox.CONFIG.MAX_TEAMS = 0;
cacheStore.clear(); // a warm stats cache is expected to skip sheet reads
const afterRepair = stats();
check('repairs a wrong header label', sheet.grid.cells[0][8] === 'Player 4 Name', sheet.grid.cells[0][8]);
// Leftovers now begin after the consent columns (column 14), not after Note.
sheet.grid.cells[0][13] = 'old column';
cacheStore.clear(); // the repair only happens on a real sheet read, not a cached one
const repairedAgain = stats();
check('clears stale leftover header', sheet.grid.cells[0][13] === '', JSON.stringify(sheet.grid.cells[0][13]));
check('repair keeps stats working', repairedAgain.ok === true);
check('stats still work after repair', afterRepair.ok === true && afterRepair.teams === 2);

console.log('\n7. existing sheet from the old script (numeric phones, extra columns)');
const legacy = spreadsheet.insertSheet('Legacy');
legacy.grid.cells[0][0] = 'Timestamp';
legacy.grid.cells[0][1] = 'Team Name';
legacy.grid.cells[0][2] = 'Department';
legacy.grid.cells[0][3] = 'Player 1 Name';
legacy.grid.cells[0][4] = 'Player 1 WhatsApp';
legacy.grid.cells[0][5] = 'Player 2 Name';
legacy.grid.cells[0][6] = 'Player 2 WhatsApp';
legacy.grid.cells[0][7] = 'Player 3 Name';
legacy.grid.cells[0][8] = 'Player 4 Name';
legacy.grid.cells[1] = [new Date('2026-10-10T22:39:51'), 'Enz', 'CSE — Computer Science Engineering',
  'PHONTOM', 7075593104, 'Fenz', 9390159068, 'Qenz', 'Don', '', ''];
sandbox.CONFIG.SHEET_NAME = 'Legacy';
propsStore.clear();
cacheStore.clear();
const legacyStats = JSON.parse(sandbox.doGet({ parameter: { action: 'stats' } }).getContent());
check('reads legacy numeric phones', legacyStats.ok === true && legacyStats.players === 4, JSON.stringify(legacyStats));
check('legacy header untouched', legacy.grid.cells[0][8] === 'Player 4 Name');
const legacyPost = post(validPayload('Legacy Team'));
check('accepts a new team on the legacy sheet', legacyPost.ok === true, JSON.stringify(legacyPost));
check('legacy row 3 has 9 columns', legacy.grid.cells[2].slice(0, 9).every(v => v !== ''), JSON.stringify(legacy.grid.cells[2].slice(0, 9)));
sandbox.CONFIG.SHEET_NAME = 'Registrations';

console.log('\n8. email is optional and cannot break a registration');
sandbox.CONFIG.ORGANIZER_EMAIL = 'organizer@example.com';
const mailed = post(validPayload('Mailed Team'));
check('registration with email configured still succeeds', mailed.ok === true, JSON.stringify(mailed));
check('one email queued', emails.length === 1, String(emails.length));
sandbox.CONFIG.ORGANIZER_EMAIL = '';

console.log('\n9. output shape for the website');
const finalPayload = stats();
check('ok flag present', finalPayload.ok === true);
check('teams is a number', typeof finalPayload.teams === 'number');
check('players is a number', typeof finalPayload.players === 'number');
check('departments is a number', typeof finalPayload.departments === 'number');
check('capacity present', typeof finalPayload.capacity === 'number');
check('slotsLeft is null when unlimited', finalPayload.slotsLeft === null);
check('generatedAt is ISO', /^\d{4}-\d{2}-\d{2}T/.test(finalPayload.generatedAt));
const info = JSON.parse(sandbox.doGet({}).getContent());
check('bare GET returns info JSON', info.ok === true);
check('info is JSON mime', sandbox.doGet({}).getMimeType() === 'application/json');

console.log('\n11. short-handed squads (2 to 4 players)');
const beforeDuo = stats();

const duo = post(shortPayload('Duo Squad', 2));
check('accepts a 2-player squad', duo.ok === true, JSON.stringify(duo));
check('a 2-player squad counts 2 players', duo.players === beforeDuo.players + 2, JSON.stringify(duo));
check('a short squad still counts as a team', duo.teams === beforeDuo.teams + 1, JSON.stringify(duo));

const trio = post(shortPayload('Trio Squad', 3));
check('accepts a 3-player squad', trio.ok === true, JSON.stringify(trio));
check('a 3-player squad counts 3 more players', trio.players === beforeDuo.players + 5, JSON.stringify(trio));

// The spare player columns must be blank, never the string "undefined".
const duoRow = sheet.grid.cells[sheet.getLastRow() - 2].slice(0, 9);
check('a short squad leaves the spare player columns blank',
  duoRow[7] === '' && duoRow[8] === '', JSON.stringify(duoRow));

const afterShort = stats();
check('stats still report the short squads',
  afterShort.ok === true && afterShort.teams === beforeDuo.teams + 2, JSON.stringify(afterShort));

/* ================================================================
   BRANCH MATRIX
   Every accept and reject path the backend can take, in both
   directions. Each rejection also proves it wrote no row, so a rule
   that appears to reject by throwing or by half-writing is caught.
   Runs on its own 'Matrix' sheet so the counters start from zero.
   ================================================================ */

console.log('\n12. request envelope');
sandbox.CONFIG.SHEET_NAME = 'Matrix';
sandbox.CONFIG.MAX_TEAMS = 0;
propsStore.clear();
cacheStore.clear();

const matrix = spreadsheet.insertSheet('Matrix');
const DEPT = 'CSE — Computer Science Engineering';

const realOpenById = sandbox.SpreadsheetApp.openById;
const realGetActive = sandbox.SpreadsheetApp.getActiveSpreadsheet;
const realGetLock = sandbox.LockService.getScriptLock;

function member(name, phone) {
  return { name: name, whatsapp: phone };
}

function matrixRows() {
  return matrix.getLastRow();
}

/** A rejection must be ok:false, carry the expected wording, and write nothing. */
function rejects(label, payload, expected, raw) {
  const before = matrixRows();
  const result = post(payload, raw);
  const wrote = matrixRows() !== before;
  const matched = result.ok === false &&
    typeof result.error === 'string' &&
    result.error.indexOf(expected) !== -1 &&
    !wrote;
  check('rejects (no row written): ' + label, matched,
    'got ' + JSON.stringify(result) + (wrote ? '  <-- IT WROTE A ROW' : ''));
  return result;
}

/** An acceptance must be ok:true and append exactly one row. */
function accepts(label, payload) {
  const before = matrixRows();
  const result = post(payload);
  const wrote = matrixRows() === before + 1;
  check('accepts: ' + label, result.ok === true && wrote,
    JSON.stringify(result) + (wrote ? '' : '  <-- NO ROW WRITTEN'));
  return result;
}

function teamNamesInSheet() {
  const rows = matrixRows();
  if (rows < 2) return [];
  return matrix.getRange(2, 2, rows - 1, 1).getValues().map(function (line) { return line[0]; });
}

function rowOfTeam(name) {
  const rows = matrixRows();
  for (let r = 2; r <= rows; r++) {
    if (matrix.getRange(r, 2).getValues()[0][0] === name) return r;
  }
  return -1;
}

function withMembers(teamName, edits) {
  const payload = validPayload(teamName);
  edits(payload);
  return payload;
}

rejects('an empty request', undefined, 'No data received.');
rejects('a non-JSON body', undefined, 'not valid JSON', 'this is not json at all');
rejects('a JSON null body', undefined, 'is not valid', 'null');
rejects('a JSON string body', undefined, 'is not valid', '"just a string"');
rejects('a JSON number body', undefined, 'is not valid', '7');
rejects('a JSON boolean body', undefined, 'is not valid', 'true');
rejects('a JSON array body', undefined, 'Team name is required', '[]');

const encodedBad = JSON.parse(sandbox.doPost({ parameter: {
  payload: JSON.stringify({ teamName: 'Encoded', department: DEPT })
} }).getContent());
check('rejects: a form-encoded payload with no players',
  encodedBad.ok === false && encodedBad.error === 'Enter between 2 and 4 players.', JSON.stringify(encodedBad));
const encodedThin = JSON.parse(sandbox.doPost({ parameter: { payload: '{"teamName":"Encoded"}' } }).getContent());
check('rejects: a form-encoded payload with no players or department',
  encodedThin.ok === false && encodedThin.error === 'Department is required.', JSON.stringify(encodedThin));

const encodedGood = JSON.parse(sandbox.doPost({ parameter: { payload: JSON.stringify(validPayload('Encoded Team')) } }).getContent());
check('accepts: a valid form-encoded payload', encodedGood.ok === true, JSON.stringify(encodedGood));

const precedence = JSON.parse(sandbox.doPost({
  postData: { contents: JSON.stringify(validPayload('Precedence Team')) },
  parameter: { payload: 'not json at all' }
}).getContent());
check('postData wins over the form-encoded fallback', precedence.ok === true, JSON.stringify(precedence));

// A real HTML form POST: postData holds the url-encoded body, and Apps Script
// also exposes the decoded field in e.parameter.payload. Reading only postData
// made every such submission fail with "The submitted data is not valid JSON."
const realisticForm = JSON.parse(sandbox.doPost({
  postData: { contents: 'payload=' + encodeURIComponent(JSON.stringify(validPayload('Form Post Team'))) },
  parameter: { payload: JSON.stringify(validPayload('Form Post Team')) }
}).getContent());
check('accepts: a real form POST where postData holds the encoded body',
  realisticForm.ok === true, JSON.stringify(realisticForm));

const formThin = JSON.parse(sandbox.doPost({
  postData: { contents: 'payload=' + encodeURIComponent(JSON.stringify({ teamName: 'Form Thin' })) },
  parameter: { payload: JSON.stringify({ teamName: 'Form Thin' }) }
}).getContent());
check('a form POST reaches validation instead of being called unreadable',
  formThin.ok === false && formThin.error === 'Department is required.', JSON.stringify(formThin));

const encodedOnly = JSON.parse(sandbox.doPost({
  postData: { contents: 'payload=' + encodeURIComponent(JSON.stringify(validPayload('Form Encoded Only'))) }
}).getContent());
check('rejects: a form POST when nothing decoded the payload field',
  encodedOnly.ok === false && encodedOnly.error === 'The submitted data is not valid JSON.', JSON.stringify(encodedOnly));

// The wording still distinguishes an unparseable body from valid JSON that is
// simply not an object.
const bareNumber = JSON.parse(sandbox.doPost({ postData: { contents: '7' } }).getContent());
check('valid JSON that is not an object keeps its own wording',
  bareNumber.ok === false && bareNumber.error === 'The submitted data is not valid.', JSON.stringify(bareNumber));

console.log('\n13. team name rules');
rejects('a missing team name', withMembers('X', function (p) { p.teamName = undefined; }), 'Team name is required.');
rejects('a whitespace-only team name', withMembers('X', function (p) { p.teamName = '     '; }), 'Team name is required.');
rejects('a null team name', withMembers('X', function (p) { p.teamName = null; }), 'Team name is required.');
rejects('an empty team name', withMembers('X', function (p) { p.teamName = ''; }), 'Team name is required.');
rejects('a 1-character team name', withMembers('X', function (p) { p.teamName = 'A'; }), 'Team name must be between 2 and 40 characters.');
rejects('a 41-character team name', withMembers('X', function (p) { p.teamName = 'A'.repeat(41); }), 'Team name must be between 2 and 40 characters.');
rejects('a 5000-character team name', withMembers('X', function (p) { p.teamName = 'A'.repeat(5000); }), 'Team name must be between 2 and 40 characters.');
rejects('an HTML tag in the team name', withMembers('X', function (p) { p.teamName = '<script>alert(1)</script>'; }), 'Team name contains characters that are not allowed.');
rejects('a bare angle bracket pair', withMembers('X', function (p) { p.teamName = '<>'; }), 'Team name contains characters that are not allowed.');
rejects('a percent-encoded tag', withMembers('X', function (p) { p.teamName = 'A%3CB'; }), 'Team name contains characters that are not allowed.');
rejects('an HTML entity', withMembers('X', function (p) { p.teamName = 'A&lt;B'; }), 'Team name contains characters that are not allowed.');
rejects('a javascript: scheme', withMembers('X', function (p) { p.teamName = 'javascript:x'; }), 'Team name contains characters that are not allowed.');
// Team name is validated before the department, so the player sees the more
// actionable message when both are wrong.
rejects('a short team name and a bad department together',
  { teamName: 'A', department: 'Nope', members: validPayload('X').members },
  'Team name must be between 2 and 40 characters.');

accepts('a 2-character team name', validPayload('AB'));
accepts('a 40-character team name', validPayload('B'.repeat(40)));
accepts('an ampersand in the team name', validPayload('Smith & Co'));
accepts('a unicode team name', validPayload('★彡 Squad 彡★'));
accepts('a numeric team name', validPayload(12345));
accepts('a team name with padding and doubled spaces', validPayload('  Tidy   Squad  '));
accepts('a team name containing a newline', validPayload('Line\nBreak'));
check('the stored name has whitespace collapsed',
  teamNamesInSheet().indexOf('Tidy Squad') !== -1, JSON.stringify(teamNamesInSheet()));
check('a multi-line name is stored on one line',
  teamNamesInSheet().indexOf('Line Break') !== -1);

const echo = accepts('a team name that needs cleaning', validPayload('  Echo Team  '));
check('the response echoes the cleaned team name', echo.team === 'Echo Team', JSON.stringify(echo));
check('the response reports the real row number', echo.row === rowOfTeam('Echo Team'),
  echo.row + ' vs ' + rowOfTeam('Echo Team'));

console.log('\n14. department rules');
rejects('a missing department', withMembers('Xy', function (p) { p.department = undefined; }), 'Department is required.');
rejects('a whitespace department', withMembers('Xy', function (p) { p.department = '   '; }), 'Department is required.');
rejects('an unknown department', withMembers('Xy', function (p) { p.department = 'Hacking Engineering'; }), 'Please choose a department from the list.');
rejects('a lowercase department', withMembers('Xy', function (p) { p.department = 'mechanical engineering'; }), 'Please choose a department from the list.');
rejects('a hyphen where the option has an em dash', withMembers('Xy', function (p) { p.department = 'CSE - Computer Science Engineering'; }), 'Please choose a department from the list.');
rejects('a partially typed department', withMembers('Xy', function (p) { p.department = 'CSE'; }), 'Please choose a department from the list.');
accepts('a department with a trailing space', withMembers('Trailing Dept', function (p) { p.department = 'Civil Engineering  '; }));
accepts('a department with doubled inner spaces', withMembers('Doubled Dept', function (p) { p.department = 'Civil  Engineering'; }));
sandbox.DEPARTMENTS.forEach(function (department, index) {
  accepts('the dropdown option "' + department + '"',
    withMembers('Dept ' + (index + 1), function (p) { p.department = department; }));
});

console.log('\n15. roster rules (2 to 4 players)');
rejects('a payload with no members key', { teamName: 'Xy', department: DEPT }, 'Enter between 2 and 4 players.');
rejects('null members', withMembers('Xy', function (p) { p.members = null; }), 'Enter between 2 and 4 players.');
rejects('members as a string', withMembers('Xy', function (p) { p.members = 'PHANTOM,FENZ'; }), 'Enter between 2 and 4 players.');
rejects('members as a plain object', withMembers('Xy', function (p) { p.members = { 0: member('PHANTOM', '7075593104') }; }), 'Enter between 2 and 4 players.');
rejects('an empty members array', withMembers('Xy', function (p) { p.members = []; }), 'Enter between 2 and 4 players.');
rejects('one player', shortPayload('Xy', 1), 'Enter between 2 and 4 players.');
rejects('five players', withMembers('Xy', function (p) {
  p.members = p.members.concat([member('FIVE', '')]);
}), 'Enter between 2 and 4 players.');
rejects('a null player entry', withMembers('Xy', function (p) { p.members[1] = null; }), 'Player 2 details are missing.');
rejects('a player entry that is a string', withMembers('Xy', function (p) { p.members[0] = 'PHANTOM'; }), 'Player 1 details are missing.');
rejects('a player entry that is a number', withMembers('Xy', function (p) { p.members[2] = 7; }), 'Player 3 details are missing.');
rejects('a player entry with no name', withMembers('Xy', function (p) { p.members[0] = { whatsapp: '7075593104' }; }), 'Player 1 name is required.');
rejects('a whitespace player 1 name', withMembers('Xy', function (p) { p.members[0].name = '   '; }), 'Player 1 name is required.');
rejects('a 1-character player 1 name', withMembers('Xy', function (p) { p.members[0].name = 'A'; }), 'Player 1 name must be between 2 and 50 characters.');
rejects('a 51-character player 1 name', withMembers('Xy', function (p) { p.members[0].name = 'A'.repeat(51); }), 'Player 1 name must be between 2 and 50 characters.');
rejects('markup in a player 2 name', withMembers('Xy', function (p) { p.members[1].name = 'A<b'; }), 'Player 2 name contains characters that are not allowed.');
rejects('a 1-character player 2 name', withMembers('Xy', function (p) { p.members[1].name = 'A'; }), 'Player 2 name must be between 2 and 50 characters.');
rejects('a blank player 3 with player 4 filled', withMembers('Xy', function (p) { p.members[2].name = ''; }), 'Player 3 name is required.');
rejects('a blank player 4', withMembers('Xy', function (p) { p.members[3].name = ''; }), 'Player 4 name is required.');
rejects('a 4-player squad with player 3 missing entirely', withMembers('Xy', function (p) {
  p.members = [p.members[0], p.members[1], { name: '' }, p.members[3]];
}), 'Player 3 name is required.');

accepts('a 2-character player name', withMembers('Min Name', function (p) { p.members[0].name = 'AB'; }));
accepts('a 50-character player name', withMembers('Max Name', function (p) { p.members[0].name = 'A'.repeat(50); }));
accepts('a unicode player name', withMembers('Unicode Name', function (p) { p.members[1].name = '彡★ZERO★彡'; }));
accepts('a player name with padding and doubled spaces', withMembers('Collapse Name', function (p) { p.members[0].name = '  PHANTOM   X  '; }));
check('player name whitespace is collapsed in the sheet',
  String(matrix.getRange(rowOfTeam('Collapse Name'), 4).getValues()[0][0]) === 'PHANTOM X',
  String(matrix.getRange(rowOfTeam('Collapse Name'), 4).getValues()[0][0]));
const twoStrong = accepts('an exactly 2-player squad', shortPayload('Duo Only', 2));
check('a 2-player squad reports 2 members worth of players',
  twoStrong.ok === true && typeof twoStrong.players === 'number');
check('a 2-player squad leaves player 3 and 4 cells blank',
  matrix.getRange(rowOfTeam('Duo Only'), 8, 1, 2).getValues()[0].every(function (v) { return v === ''; }),
  JSON.stringify(matrix.getRange(rowOfTeam('Duo Only'), 8, 1, 2).getValues()[0]));
const threeStrong = accepts('an exactly 3-player squad', shortPayload('Trio Only', 3));
check('a 3-player squad leaves only player 4 blank',
  matrix.getRange(rowOfTeam('Trio Only'), 8).getValues()[0][0] !== '' &&
  matrix.getRange(rowOfTeam('Trio Only'), 9).getValues()[0][0] === '',
  JSON.stringify(matrix.getRange(rowOfTeam('Trio Only'), 8, 1, 2).getValues()[0]));
check('a 3-player squad adds 3 players to the counter', threeStrong.players - twoStrong.players === 3,
  threeStrong.players + ' vs ' + twoStrong.players);

console.log('\n16. WhatsApp number rules');
rejects('a missing player 1 phone', withMembers('Xy', function (p) { delete p.members[0].whatsapp; }), 'Player 1 WhatsApp number must be exactly 10 digits.');
rejects('a null player 1 phone', withMembers('Xy', function (p) { p.members[0].whatsapp = null; }), 'Player 1 WhatsApp number must be exactly 10 digits.');
rejects('a 9-digit phone', withMembers('Xy', function (p) { p.members[0].whatsapp = '707559310'; }), 'Player 1 WhatsApp number must be exactly 10 digits.');
rejects('an 11-digit phone', withMembers('Xy', function (p) { p.members[0].whatsapp = '70755931045'; }), 'Player 1 WhatsApp number must be exactly 10 digits.');
rejects('letters as a phone number', withMembers('Xy', function (p) { p.members[1].whatsapp = 'abcdefghij'; }), 'Player 2 WhatsApp number must be exactly 10 digits.');
rejects('an international phone number', withMembers('Xy', function (p) { p.members[0].whatsapp = '+91 7075593104'; }), 'Player 1 WhatsApp number must be exactly 10 digits.');
rejects('a phone number with a leading zero', withMembers('Xy', function (p) { p.members[0].whatsapp = '07075593104'; }), 'Player 1 WhatsApp number must be exactly 10 digits.');
rejects('an all-zero player 1 phone', withMembers('Xy', function (p) { p.members[0].whatsapp = '0000000000'; }), 'Player 1 WhatsApp number is not valid.');
rejects('an all-zero player 2 phone', withMembers('Xy', function (p) { p.members[1].whatsapp = '0000000000'; }), 'Player 2 WhatsApp number is not valid.');
rejects('a blank player 2 phone', withMembers('Xy', function (p) { p.members[1].whatsapp = ''; }), 'Player 2 WhatsApp number must be exactly 10 digits.');
rejects('non-ASCII digits', withMembers('Xy', function (p) { p.members[0].whatsapp = '٧٠٧٥٥٩٣١٠٤'; }), 'Player 1 WhatsApp number must be exactly 10 digits.');
rejects('the same phone number for both players', withMembers('Xy', function (p) { p.members[1].whatsapp = p.members[0].whatsapp; }), 'Player 1 and Player 2 cannot use the same WhatsApp number.');
// The digit check for each player runs before the shared-number comparison, so
// two identically broken numbers report the digit fault, not the duplicate.
rejects('two identical malformed phones', withMembers('Xy', function (p) {
  p.members[0].whatsapp = '111';
  p.members[1].whatsapp = '111';
}), 'Player 1 WhatsApp number must be exactly 10 digits.');

accepts('a phone number written with a space', withMembers('Spaced Phone', function (p) { p.members[0].whatsapp = '7075 593104'; }));
check('the space is stripped before storing',
  String(matrix.getRange(rowOfTeam('Spaced Phone'), 5).getValues()[0][0]) === '7075593104',
  String(matrix.getRange(rowOfTeam('Spaced Phone'), 5).getValues()[0][0]));
accepts('a phone number written with dashes', withMembers('Dashed Phone', function (p) { p.members[0].whatsapp = '707-559-3104'; }));
check('the dashes are stripped before storing',
  String(matrix.getRange(rowOfTeam('Dashed Phone'), 5).getValues()[0][0]) === '7075593104');
accepts('a phone number sent as a JSON number', withMembers('Numeric Phone', function (p) { p.members[0].whatsapp = 7075593104; }));
check('a numeric phone is stored as digits',
  String(matrix.getRange(rowOfTeam('Numeric Phone'), 5).getValues()[0][0]) === '7075593104');
accepts('an all-zero-except-the-last phone', withMembers('Edge Phone', function (p) { p.members[0].whatsapp = '0000000001'; }));
accepts('a 3-player squad that also sends a phone for player 3', (function () {
  const p = shortPayload('Ignored Phone', 3);
  p.members[2].whatsapp = '12345';
  return p;
})());
check('a phone sent for player 3 is dropped, not written anywhere',
  JSON.stringify(matrix.getRange(rowOfTeam('Ignored Phone'), 1, 1, 9).getValues()[0]).indexOf('12345') === -1);
accepts('team A using a number also used elsewhere', withMembers('Number A', function (p) { p.members[0].whatsapp = '9000000001'; }));
accepts('team B reusing that same number', withMembers('Number B', function (p) { p.members[0].whatsapp = '9000000001'; }));
check('a number shared across two teams is accepted by the validator (the sheet highlights it instead)',
  rowOfTeam('Number A') !== -1 && rowOfTeam('Number B') !== -1);

console.log('\n17. duplicate team names across days');
accepts('the first registration of a spaced name', validPayload('Space Squad'));
rejects('the same name with doubled spaces', validPayload('Space   Squad'), 'already registered today');
rejects('the same name in a different case', validPayload('SPACE SQUAD'), 'already registered today');
rejects('the same name with padding', validPayload('  Space Squad  '), 'already registered today');

accepts('a team used for the cross-day probe', validPayload('Yesterday Squad'));
matrix.getRange(rowOfTeam('Yesterday Squad'), 1).setValues([[new Date(Date.now() - 26 * 3600 * 1000)]]);
accepts('the same name on a later day', validPayload('Yesterday Squad'));

accepts('a team used for the text-timestamp probe', validPayload('Text Stamp Squad'));
matrix.getRange(rowOfTeam('Text Stamp Squad'), 1).setValues([['16 Oct 2026, 06:43 PM']]);
accepts('the same name when its timestamp is stored as text (known gap)', validPayload('Text Stamp Squad'));
check('a text timestamp defeats the same-day duplicate rule',
  teamNamesInSheet().filter(function (n) { return n === 'Text Stamp Squad'; }).length === 2);

console.log('\n18. team cap and slots left');
const uncappedStats = stats();
check('capacity is 0 when no cap is configured', uncappedStats.capacity === 0, JSON.stringify(uncappedStats));
check('slotsLeft is null when no cap is configured', uncappedStats.slotsLeft === null);

const capValue = uncappedStats.teams + 1;
sandbox.CONFIG.MAX_TEAMS = capValue;
cacheStore.clear(); // a warm cache would otherwise serve the old capacity
const cappedStats = stats();
check('capacity reports the configured cap', cappedStats.capacity === capValue, JSON.stringify(cappedStats));
check('slotsLeft counts the remaining slots', cappedStats.slotsLeft === 1, JSON.stringify(cappedStats));
accepts('the last team inside the cap', validPayload('Final Slot Team'));
cacheStore.clear();
const fullStats = stats();
check('slotsLeft reaches zero exactly at the cap', fullStats.slotsLeft === 0, JSON.stringify(fullStats));
check('the cap counts the team that just registered', fullStats.teams === capValue, JSON.stringify(fullStats));
const overCap = rejects('a team past the cap', validPayload('Over Cap Team'),
  'All ' + capValue + ' team slots are taken. Registration is closed.');
check('the refusal names the configured cap', overCap.error.indexOf(String(capValue)) !== -1, overCap.error);
sandbox.CONFIG.MAX_TEAMS = 0;
cacheStore.clear();

console.log('\n19. locking and fault containment');
const lockState = { tryLock: true, attempts: 0, releases: 0, throwOnRelease: false };
sandbox.LockService.getScriptLock = function () {
  return {
    tryLock: function () { lockState.attempts++; return lockState.tryLock; },
    releaseLock: function () {
      lockState.releases++;
      // Real Apps Script can throw here when the lock was never acquired, so the
      // release in doPost's finally block has to stay inside a guard.
      if (lockState.throwOnRelease) throw new Error('Lock has not been acquired.');
    }
  };
};

lockState.tryLock = false;
lockState.throwOnRelease = true;
const busy = rejects('a registration while the lock is held', validPayload('Busy Team'), 'The server is busy.');
check('a refused lock is reported with the back-off wording',
  busy.error === 'The server is busy. Please try again in a few seconds.', busy.error);
check('a release that throws cannot break the response',
  busy.ok === false && lockState.releases === 1, 'releases: ' + lockState.releases);
lockState.throwOnRelease = false;

lockState.tryLock = true;
lockState.attempts = 0;
lockState.releases = 0;
rejects('a bad payload with a free lock', withMembers('Xy', function (p) { p.teamName = 'A'; }), 'between 2 and 40 characters');
check('a payload rejected by validation never takes the lock', lockState.attempts === 0, String(lockState.attempts));

accepts('a registration once the lock is free', validPayload('Unlocked Team'));
check('a successful registration releases the lock exactly once', lockState.releases === 1, String(lockState.releases));

const rowsBeforeOutage = matrixRows();
lockState.releases = 0;
sandbox.CONFIG.SHEET_ID = 'outage';
sandbox.SpreadsheetApp.openById = function () { throw new Error('Simulated spreadsheet outage'); };
const outage = post(validPayload('Outage Team'));
check('a write outage is contained as JSON, not a crash',
  outage.ok === false && outage.error.indexOf('Server error:') === 0, JSON.stringify(outage));
check('a write outage names the underlying cause',
  outage.error.indexOf('Simulated spreadsheet outage') !== -1, outage.error);
check('a write outage writes no row', matrixRows() === rowsBeforeOutage,
  matrixRows() + ' vs ' + rowsBeforeOutage);
check('the lock is still released when the write throws', lockState.releases === 1, String(lockState.releases));
sandbox.SpreadsheetApp.openById = realOpenById;
sandbox.CONFIG.SHEET_ID = '';
sandbox.LockService.getScriptLock = realGetLock;

console.log('\n20. stats, cache and info endpoint');
sandbox.CONFIG.SHEET_NAME = 'Registrations';
cacheStore.clear();
const freshBook = new Spreadsheet();
sandbox.SpreadsheetApp.getActiveSpreadsheet = function () { return freshBook; };
const emptyStats = JSON.parse(sandbox.doGet({ parameter: { action: 'stats' } }).getContent());
check('a sheet with no registrations reports 0 teams', emptyStats.ok === true && emptyStats.teams === 0, JSON.stringify(emptyStats));
check('a sheet with no registrations reports 0 players', emptyStats.players === 0);
check('a sheet with no registrations reports no last entry', emptyStats.lastRegistration === '');
check('a sheet with no registrations reports 0 departments',
  emptyStats.departments === 0 && Object.keys(emptyStats.byDepartment).length === 0);
check('a brand new sheet is created with its header row',
  freshBook.getSheetByName('Registrations') !== null &&
  freshBook.getSheetByName('Registrations').grid.cells[0][0] === 'Timestamp');
check('the first stats call on an empty sheet is still valid JSON',
  sandbox.doGet({ parameter: { action: 'stats' } }).getMimeType() === 'application/json');
sandbox.SpreadsheetApp.getActiveSpreadsheet = realGetActive;

sandbox.CONFIG.SHEET_NAME = 'Matrix';
cacheStore.clear();
const warmOne = stats();
const warmTwo = stats();
check('a warm cache serves the identical payload', warmOne.generatedAt === warmTwo.generatedAt,
  warmOne.generatedAt + ' vs ' + warmTwo.generatedAt);
const teamsBeforeWrite = warmOne.teams;
accepts('a registration while the cache is warm', validPayload('Cache Buster'));
check('a registration clears the cached counters', !cacheStore.has(sandbox.CACHE_KEY_STATS));
const afterWrite = stats();
check('the counters reflect a new registration immediately', afterWrite.teams === teamsBeforeWrite + 1,
  afterWrite.teams + ' vs ' + teamsBeforeWrite);

cacheStore.set(sandbox.CACHE_KEY_STATS, '{ this is not json');
const recovered = stats();
check('a corrupt cache entry is rebuilt instead of thrown',
  recovered.ok === true && typeof recovered.teams === 'number', JSON.stringify(recovered));

const unknownAction = JSON.parse(sandbox.doGet({ parameter: { action: 'nonsense' } }).getContent());
check('an unknown action falls back to the info payload',
  unknownAction.ok === true && unknownAction.service !== undefined, JSON.stringify(unknownAction));
const upperAction = JSON.parse(sandbox.doGet({ parameter: { action: 'STATS' } }).getContent());
check('the action name is case-sensitive', upperAction.teams === undefined && upperAction.ok === true);
const bareGet = JSON.parse(sandbox.doGet({}).getContent());
check('a bare GET lists the stats endpoint',
  Array.isArray(bareGet.endpoints) && bareGet.endpoints.indexOf('?action=stats') !== -1, JSON.stringify(bareGet));
check('error responses are JSON as well', sandbox.errorResponse_('x').getMimeType() === 'application/json');

sandbox.CONFIG.SHEET_ID = 'outage';
cacheStore.clear();
sandbox.SpreadsheetApp.openById = function () { throw new Error('Simulated spreadsheet outage'); };
const brokenGet = JSON.parse(sandbox.doGet({ parameter: { action: 'stats' } }).getContent());
check('a stats outage is contained as JSON, not a crash',
  brokenGet.ok === false && brokenGet.error.indexOf('Server error:') === 0, JSON.stringify(brokenGet));
sandbox.SpreadsheetApp.openById = realOpenById;
sandbox.CONFIG.SHEET_ID = '';
sandbox.CONFIG.SHEET_NAME = 'Registrations';
sandbox.CONFIG.MAX_TEAMS = 0;

console.log('\n10. error containment');
check('no unexpected console errors', log.filter(l => l.startsWith('ERROR')).length === 0, log.join(' | '));

console.log('\n11. admin dashboard API');

function adminCall(body) {
  const res = sandbox.doPost({ parameter: { action: 'admin' }, postData: { contents: JSON.stringify(body) } });
  return JSON.parse(res.getContent());
}

const noKey = adminCall({ action: 'list', key: 'anything' });
check('denies the dashboard when no key is configured',
  noKey.ok === false && noKey.code === 'AUTH', JSON.stringify(noKey));

const adminKey = sandbox.setupAdminKey();
check('setupAdminKey creates a long key',
  typeof adminKey === 'string' && adminKey.length >= 32, String(adminKey && adminKey.length));
check('the key is kept server-side, never in the source',
  scriptProps.get('admin_key') === adminKey && SOURCE.indexOf(adminKey) === -1);

const wrongKey = adminCall({ action: 'list', key: 'x'.repeat(adminKey.length) });
check('a wrong key is refused', wrongKey.ok === false && wrongKey.code === 'AUTH', JSON.stringify(wrongKey));

const list = adminCall({ action: 'list', key: adminKey, pageSize: 50 });
check('a valid key lists the registrations',
  list.ok === true && list.records.length >= 2, JSON.stringify(list).slice(0, 160));
check('counts are calculated from the rows',
  !!list.counts &&
  list.counts.total === list.records.length &&
  list.counts.players === list.records.reduce((sum, r) => sum + r.playerCount, 0),
  JSON.stringify(list && list.counts));
check('records carry an opaque id, not a row number',
  Array.isArray(list.records) && list.records.every(r => typeof r.id === 'string' && r.id.length === 22));

const target = list.records.filter(r => r.teamName === 'Shadow Squad')[0];
check('the detail view exposes the roster',
  target && target.players.length === 4 && target.players[0].whatsapp === '7075593104',
  JSON.stringify(target && target.players));

const approved = adminCall({ action: 'status', key: adminKey, id: target.id, status: 'APPROVED', expectedStatus: 'PENDING' });
check('a status change is confirmed by the server',
  approved.ok === true && approved.record.status === 'APPROVED', JSON.stringify(approved).slice(0, 200));
check('the sheet cell really changed', sheet.grid.cells[1][9] === 'APPROVED', String(sheet.grid.cells[1][9]));

const stale = adminCall({ action: 'status', key: adminKey, id: target.id, status: 'REJECTED', expectedStatus: 'PENDING' });
check('a stale update is refused', stale.ok === false && stale.code === 'STALE', JSON.stringify(stale).slice(0, 160));

const badStatus = adminCall({ action: 'status', key: adminKey, id: target.id, status: 'WINNER' });
check('an unknown status is refused', badStatus.ok === false && badStatus.code === 'STATUS');

const badId = adminCall({ action: 'status', key: adminKey, id: '<script>alert(1)</script>', status: 'APPROVED' });
check('a malformed id is refused', badId.ok === false && badId.code === 'ID');

const ghost = adminCall({ action: 'status', key: adminKey, id: 'A'.repeat(22), status: 'APPROVED' });
check('an unknown id cannot touch a row', ghost.ok === false && ghost.code === 'ID');

const noted = adminCall({ action: 'note', key: adminKey, id: target.id, note: 'Paid, kit issued' });
check('an organiser note is saved', noted.ok === true && noted.record.note === 'Paid, kit issued');

const badNote = adminCall({ action: 'note', key: adminKey, id: target.id, note: '<b>hi</b>' });
check('markup in a note is refused', badNote.ok === false && badNote.code === 'NOTE');

const longNote = adminCall({ action: 'note', key: adminKey, id: target.id, note: 'x'.repeat(600) });
check('an over-long note is refused', longNote.ok === false && longNote.code === 'NOTE');

const rejected = adminCall({ action: 'status', key: adminKey, id: target.id, status: 'REJECTED' });
const afterReject = stats();
check('a rejected team leaves the public counters',
  rejected.ok === true && afterReject.teams === list.counts.total - 1,
  JSON.stringify({ teams: afterReject.teams, total: list.counts.total }));
check('the rejected row is kept as a record', sandbox.countTeams_(sheet) === list.counts.total);

const exported = adminCall({ action: 'export', key: adminKey });
check('export returns one CSV line per record plus a header',
  exported.ok === true && exported.csv.split('\r\n').length === list.counts.total + 1,
  String(exported.csv.split('\r\n').length));
check('export includes the organisation note and status',
  exported.csv.indexOf('Paid, kit issued') !== -1 && exported.csv.indexOf('REJECTED') !== -1);

for (let i = 0; i < sandbox.CONFIG.ADMIN_MAX_FAILS; i++) {
  adminCall({ action: 'list', key: 'z'.repeat(adminKey.length) });
}
const lockedOut = adminCall({ action: 'list', key: adminKey });
check('repeated wrong keys lock the dashboard', lockedOut.ok === false && lockedOut.code === 'AUTH', JSON.stringify(lockedOut));
cacheStore.delete('qqsgp_admin_lock');
cacheStore.delete('qqsgp_admin_fails');
const unlocked = adminCall({ action: 'list', key: adminKey });
check('the lock lifts after its window', unlocked.ok === true);

const sneaky = post(Object.assign(validPayload('Sneaky Team'), { status: 'APPROVED', note: 'set from the form' }));
const sneakyRecord = adminCall({ action: 'list', key: adminKey, q: 'Sneaky Team' }).records[0];
check('a public submission cannot choose its own status',
  sneaky.ok === true && sneakyRecord && sneakyRecord.status === 'PENDING' && sneakyRecord.note === '',
  JSON.stringify({ ok: sneaky.ok, record: sneakyRecord }));

const filtered = adminCall({ action: 'list', key: adminKey, status: 'REJECTED' });
check('the status filter returns only that status',
  filtered.ok === true && filtered.records.every(r => r.status === 'REJECTED'), JSON.stringify(filtered.records.map(r => r.status)));

const searched = adminCall({ action: 'list', key: adminKey, q: 'SHADOW' });
check('search is case-insensitive on team names',
  searched.ok === true && searched.records.length === 1 && searched.records[0].teamName === 'Shadow Squad',
  JSON.stringify(searched.records.map(r => r.teamName)));

// Every fixture squad shares the same roster names, so a roster search is
// expected to match all of them -- the point is that it matches on players.
const byPlayer = adminCall({ action: 'list', key: adminKey, q: 'phantom' });
check('search also matches a player name',
  byPlayer.ok === true && byPlayer.records.length >= 1 &&
  byPlayer.records.every(r => r.players.some(p => /phantom/i.test(p.name))),
  JSON.stringify(byPlayer.records.map(r => r.players.map(p => p.name))));

const paged = adminCall({ action: 'list', key: adminKey, pageSize: 1, page: 2 });
check('pagination slices the result, not the data',
  paged.ok === true && paged.records.length === 1 && paged.page === 2 && paged.total >= 2,
  JSON.stringify({ page: paged.page, total: paged.total }));

const unknownAdminAction = adminCall({ action: 'drop-table', key: adminKey });
check('an unknown admin action is refused', unknownAdminAction.ok === false && unknownAdminAction.code === 'ACTION');

const missingAction = adminCall({ key: adminKey });
check('a missing admin action is refused', missingAction.ok === false && missingAction.code === 'ACTION');

console.log('\n12. WhatsApp notifications');

/* The provider itself is mocked (see UrlFetchApp above); everything else here
   is the real apps-script.js running against a real sheet model. */

const WA_KEY = 'test-token-not-a-real-credential';
const WA_PHONE_ID = '123456789012345';
const WA_VERIFY = 'whsec_test_token_1234567890';

function notifRows() {
  const s = spreadsheet.getSheetByName('Notifications');
  if (!s) return [];
  const rows = s.getLastRow() - 1;
  if (rows <= 0) return [];
  return s.getRange(2, 1, rows, 15).getValues();
}

function notifFor(team) {
  return notifRows().filter(r => String(r[3]) === team);
}

function registerTeam(name, consent) {
  return post(Object.assign(validPayload(name), { whatsappConsent: consent === true }));
}

function recordFor(name) {
  const list = adminCall({ action: 'list', key: adminKey, status: 'ALL', pageSize: 100, page: 1 });
  return (list.records || []).filter(r => r.teamName === name)[0] || null;
}

function setStatus(name, status) {
  const rec = recordFor(name);
  return adminCall({ action: 'status', key: adminKey, id: rec.id, status: status, expectedStatus: rec.status });
}

/* --- before any credential is configured ------------------------------- */

check('a 10-digit number gets the country code',
  sandbox.normalisePhone_('9876543210') === '919876543210', sandbox.normalisePhone_('9876543210'));
check('a number that already carries 91 is kept',
  sandbox.normalisePhone_('+91 98765 43210') === '919876543210');
check('a leading zero is normalised',
  sandbox.normalisePhone_('09876543210') === '919876543210');
check('short numbers are refused', sandbox.normalisePhone_('12345') === '');
check('blank numbers are refused', sandbox.normalisePhone_('') === '');

registerTeam('WA Unconfigured', true);
resetFetch();
const offChange = setStatus('WA Unconfigured', 'APPROVED');
check('a status change works while WhatsApp is off',
  offChange.ok === true && offChange.record.status === 'APPROVED', JSON.stringify(offChange.record && offChange.record.status));
check('nothing is queued while WhatsApp is off',
  notifRows().length === 0 && fetchCalls.length === 0,
  'rows: ' + notifRows().length + ' calls: ' + fetchCalls.length);
check('the response says it was not attempted',
  offChange.notification && offChange.notification.state === 'DISABLED',
  JSON.stringify(offChange.notification));

/* --- configured ------------------------------------------------------- */

scriptProps.set('whatsapp_token', WA_KEY);
scriptProps.set('whatsapp_phone_number_id', WA_PHONE_ID);
scriptProps.set('whatsapp_enabled', 'yes');
scriptProps.set('whatsapp_verify_token', WA_VERIFY);

const waCfg = adminCall({ action: 'notif-config', key: adminKey });
check('config reports the integration as ready',
  waCfg.ok === true && waCfg.configured === true && waCfg.mode === 'template', JSON.stringify(waCfg));
check('the config response never contains the token',
  JSON.stringify(waCfg).indexOf(WA_KEY) === -1);
check('template names are reported for every type',
  waCfg.templates.APPROVED === 'qqsgp_team_approved' &&
  waCfg.templates.ANNOUNCEMENT === 'qqsgp_announcement',
  JSON.stringify(waCfg.templates));

/* --- consent gate ----------------------------------------------------- */

registerTeam('WA No Consent', false);
resetFetch();
const noConsent = setStatus('WA No Consent', 'APPROVED');
check('a team without consent still changes status', noConsent.ok === true);
const skipped = notifFor('WA No Consent')[0];
check('a team without consent is logged as SKIPPED',
  skipped && String(skipped[10]) === 'SKIPPED', skipped && String(skipped[10]));
check('a team without consent never reaches the provider', fetchCalls.length === 0);

/* --- the happy path --------------------------------------------------- */

registerTeam('WA Consent', true);
const consentRow = (function () {
  const rows = sheet.getLastRow() - 1;
  const values = sheet.getRange(2, 1, rows, 13).getValues();
  return values.filter(v => v[1] === 'WA Consent')[0];
})();
check('consent is stored as YES with a timestamp',
  consentRow && String(consentRow[11]) === 'YES' && Object.prototype.toString.call(consentRow[12]) === '[object Date]',
  consentRow && JSON.stringify(consentRow.slice(11, 13)));

resetFetch();
const waApproved = setStatus('WA Consent', 'APPROVED');
check('approving a consented team sends a message',
  waApproved.notification && waApproved.notification.state === 'SENT',
  JSON.stringify(waApproved.notification));

const call = fetchCalls[0];
const sentBody = JSON.parse(call.options.payload);
check('posts to the configured phone number id',
  new RegExp('/' + WA_PHONE_ID + '/messages$').test(call.url), call.url);
check('uses the approved template for approval',
  sentBody.type === 'template' && sentBody.template.name === 'qqsgp_team_approved',
  JSON.stringify(sentBody.template && sentBody.template.name));
check('addresses the leader in E.164 form', sentBody.to === '917075593104', sentBody.to);
check('passes leader, team and registration id in order',
  sentBody.template.components[0].parameters.length === 3 &&
  sentBody.template.components[0].parameters[0].text === 'PHANTOM' &&
  sentBody.template.components[0].parameters[1].text === 'WA Consent' &&
  sentBody.template.components[0].parameters[2].text.length > 10,
  JSON.stringify(sentBody.template.components[0].parameters));
check('the access token never leaves the Authorization header',
  call.options.headers.Authorization === 'Bearer ' + WA_KEY &&
  JSON.stringify(sentBody).indexOf(WA_KEY) === -1);

const sentRow = notifFor('WA Consent')[0];
check('the provider message id is stored',
  /^wamid\./.test(String(sentRow[9])), String(sentRow[9]));
check('the sent body is kept for the audit trail',
  String(sentRow[8]).indexOf('congratulations') !== -1);

/* --- duplicates ------------------------------------------------------- */

resetFetch();
const sameAgain = adminCall({
  action: 'status', key: adminKey,
  id: recordFor('WA Consent').id, status: 'APPROVED', expectedStatus: 'APPROVED'
});
check('the same status is never sent twice',
  sameAgain.notification.duplicate === true && fetchCalls.length === 0,
  JSON.stringify(sameAgain.notification));

/* --- failure states --------------------------------------------------- */

registerTeam('WA Provider Says No', true);
resetFetch();
queueFetch({
  code: 400,
  body: JSON.stringify({ error: { message: 'Template not found', code: 132001 } })
});
const waRejected = setStatus('WA Provider Says No', 'APPROVED');
check('a provider rejection is recorded as FAILED',
  waRejected.notification.state === 'FAILED' && /Template not found/.test(waRejected.notification.error),
  JSON.stringify(waRejected.notification));
check('a failed notification never rolls the status back',
  waRejected.record.status === 'APPROVED', waRejected.record.status);

registerTeam('WA Lost Response', true);
resetFetch();
queueFetch({ throws: 'socket hang up' });
const uncertain = setStatus('WA Lost Response', 'APPROVED');
check('a lost answer is UNCERTAIN, not "sent"',
  uncertain.notification.state === 'UNCERTAIN', JSON.stringify(uncertain.notification));

const unsafeRetry = adminCall({ action: 'notif-retry', key: adminKey, id: uncertain.notification.id });
check('an uncertain message is not blindly resent',
  unsafeRetry.ok === false && unsafeRetry.code === 'UNCERTAIN', JSON.stringify(unsafeRetry));

/* --- retry ------------------------------------------------------------ */

resetFetch();
const retried = adminCall({ action: 'notif-retry', key: adminKey, id: waRejected.notification.id, force: true });
check('a failed message can be retried',
  retried.ok === true && retried.notification.state === 'SENT', JSON.stringify(retried));
check('the retry increments the attempt count',
  retried.notification.attempts === 2, String(retried.notification.attempts));

const alreadySent = adminCall({ action: 'notif-retry', key: adminKey, id: waApproved.notification.id, force: true });
check('a message the provider accepted is never resent',
  alreadySent.ok === false && alreadySent.code === 'ALREADY_SENT', JSON.stringify(alreadySent));

const skippedRetry = adminCall({ action: 'notif-retry', key: adminKey, id: skipped[0], force: true });
check('a skipped notification cannot be retried', skippedRetry.ok === false);

/* --- webhook / delivery receipts -------------------------------------- */

const handshake = sandbox.doGet({
  parameter: {
    action: 'webhook', 'hub.mode': 'subscribe',
    'hub.verify_token': WA_VERIFY, 'hub.challenge': '99887766'
  }
});
check('the webhook answers Meta with the raw challenge',
  handshake.getContent() === '99887766', handshake.getContent());

const badHandshake = sandbox.doGet({
  parameter: { action: 'webhook', 'hub.verify_token': 'wrong-token', 'hub.challenge': 'x' }
});
check('a wrong verify token is refused',
  badHandshake.getContent() === 'forbidden', badHandshake.getContent());

function webhook(statusValue, options) {
  const opts = options || {};
  const payload = {
    entry: [{
      changes: [{
        value: {
          statuses: [{
            id: opts.id || String(sentRow[9]),
            status: statusValue,
            errors: opts.errors
          }]
        }
      }]
    }]
  };
  return JSON.parse(sandbox.doPost({
    parameter: { action: 'webhook', k: opts.k === undefined ? WA_VERIFY : opts.k },
    postData: { contents: JSON.stringify(payload) }
  }).getContent());
}

check('an unauthenticated webhook call is refused',
  webhook('delivered', { k: 'not-the-token' }).ok === false);

check('a delivered event is recorded', webhook('delivered').updated === 1);
check('the row now says DELIVERED', String(notifFor('WA Consent')[0][10]) === 'DELIVERED',
  String(notifFor('WA Consent')[0][10]));

check('a read event is recorded', webhook('read').updated === 1);
check('the row now says READ', String(notifFor('WA Consent')[0][10]) === 'READ');

check('a late delivered event does not undo read', webhook('delivered').updated === 0);
check('the row stays READ', String(notifFor('WA Consent')[0][10]) === 'READ');

check('an unknown message id is ignored',
  webhook('read', { id: 'wamid.NOT-OURS' }).updated === 0);

check('a failed event carries the provider reason',
  (function () {
    // This row was retried successfully, so it has a provider id to match.
    const target = notifFor('WA Provider Says No')[0];
    const body = {
      entry: [{
        changes: [{
          value: { statuses: [{ id: String(target[9]), status: 'failed', errors: [{ title: 'Recipient blocked', detail: 'not on WhatsApp' }] }] }
        }]
      }]
    };
    const res = JSON.parse(sandbox.doPost({
      parameter: { action: 'webhook', k: WA_VERIFY },
      postData: { contents: JSON.stringify(body) }
    }).getContent());
    const after = notifFor('WA Provider Says No')[0];
    return res.updated === 1 && String(after[10]) === 'FAILED' && /blocked/i.test(String(after[13]));
  })());

/* --- announcements ---------------------------------------------------- */

registerTeam('WA Rejected Team', true);
resetFetch();
setStatus('WA Rejected Team', 'REJECTED');
resetFetch();

const preview = adminCall({
  action: 'announce-preview', key: adminKey,
  audience: 'APPROVED', message: 'Room details will be shared here at 6 PM.'
});
check('the preview reports how many teams would receive it',
  preview.ok === true && preview.count >= 2, JSON.stringify(preview));
check('the preview reports teams blocked by consent',
  typeof preview.blocked.noConsent === 'number', JSON.stringify(preview.blocked));
check('preparing an announcement sends nothing', fetchCalls.length === 0);

const rejectedPreview = adminCall({
  action: 'announce-preview', key: adminKey,
  audience: 'SELECTED', ids: [recordFor('WA Rejected Team').id],
  message: 'This must never reach a rejected team.'
});
check('a rejected team cannot be announced to',
  rejectedPreview.ok === true && rejectedPreview.count === 0, JSON.stringify(rejectedPreview));

const sentAnnouncement = adminCall({ action: 'announce-send', key: adminKey, token: preview.token });
check('the announcement reaches each eligible recipient',
  sentAnnouncement.ok === true && sentAnnouncement.sent === preview.count,
  JSON.stringify(sentAnnouncement));
check('each announcement message is one notification row',
  notifRows().filter(r => String(r[5]) === 'ANNOUNCEMENT').length === preview.count,
  String(notifRows().filter(r => String(r[5]) === 'ANNOUNCEMENT').length));

resetFetch();
const repeatAnnouncement = adminCall({ action: 'announce-send', key: adminKey, token: preview.token });
check('sending the same preview twice creates no duplicates',
  repeatAnnouncement.ok === true && repeatAnnouncement.sent === 0 &&
  repeatAnnouncement.duplicate === preview.count && fetchCalls.length === 0,
  JSON.stringify(repeatAnnouncement));

// A hasty preview -> send -> preview -> send must not message anyone twice:
// inside the window the same announcement resolves to the same ids.
const secondPreview = adminCall({
  action: 'announce-preview', key: adminKey,
  audience: 'APPROVED', message: 'Room details will be shared here at 6 PM.'
});
const secondSend = adminCall({ action: 'announce-send', key: adminKey, token: secondPreview.token });
check('composing the same announcement again does not resend it',
  secondSend.ok === true && secondSend.sent === 0 && secondSend.duplicate === secondPreview.count,
  JSON.stringify(secondSend));

const otherPreview = adminCall({
  action: 'announce-preview', key: adminKey,
  audience: 'APPROVED', message: 'Reporting time has moved to 5 PM.'
});
resetFetch();
const otherSend = adminCall({ action: 'announce-send', key: adminKey, token: otherPreview.token });
check('a genuinely new announcement is still delivered',
  otherSend.sent === otherPreview.count && fetchCalls.length === otherPreview.count,
  JSON.stringify(otherSend));

const unknownToken = adminCall({ action: 'announce-send', key: adminKey, token: 'z'.repeat(22) });
check('an unknown preview token cannot send anything',
  unknownToken.ok === false && unknownToken.code === 'EXPIRED', JSON.stringify(unknownToken));

const emptyMessage = adminCall({ action: 'announce-preview', key: adminKey, audience: 'APPROVED', message: '   ' });
check('an empty announcement is refused', emptyMessage.ok === false && emptyMessage.code === 'MESSAGE');

/* --- log -------------------------------------------------------------- */

const notifLog = adminCall({ action: 'notif-list', key: adminKey, state: 'ALL' });
check('the notification log lists rows with their states',
  notifLog.ok === true && notifLog.total > 0 && typeof notifLog.counts.SENT === 'number',
  JSON.stringify(notifLog.counts));
check('the log never carries the access token',
  JSON.stringify(notifLog).indexOf(WA_KEY) === -1);
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
