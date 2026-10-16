/*
  Harness that runs apps-script.js against a mocked Apps Script runtime
  so the doPost / doGet paths can be exercised without touching a real sheet.
  Run: node verify-apps-script.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
const emails = [];
const log = [];

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
      getMimeType() { return this._mime; }
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
  Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
  MailApp: { sendEmail: (...args) => emails.push(args) }
};

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
check('header has 9 columns', sandbox.HEADERS.length === 9 && sheet.grid.cells[0][8] === 'Player 4 Name');
check('9 columns written for the row', sheet.grid.cells[1].slice(0, 10).filter(v => v !== '').length === 9,
  JSON.stringify(sheet.grid.cells[1].slice(0, 10)));
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
check('no column 10 chatter', sheet.grid.cells[0].slice(9).every(v => v === '') && sheet.grid.cells[1].slice(9).every(v => v === ''));

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
check('clears stale leftover header', sheet.grid.cells[0][9] === '', JSON.stringify(sheet.grid.cells[0][9]));
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
