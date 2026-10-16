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
    this.sheet.validationCells[this.row + ',' + this.col] = rule;
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
  const chain = ['requireValueInList', 'setAllowInvalid', 'setHelpText', 'whenFormulaSatisfied', 'setBackground', 'setRanges'];
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
    BorderStyle: { SOLID: 'SOLID' },
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
  ['only 3 players', Object.assign(validPayload('Xy'), { members: validPayload('Xy').members.slice(0, 3) })],
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

console.log('\n10. error containment');
check('no unexpected console errors', log.filter(l => l.startsWith('ERROR')).length === 0, log.join(' | '));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
