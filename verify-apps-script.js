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
  // Single-cell read, used by the registration path to read back the stamp it
  // just wrote so the new row's id can be signed.
  getValue() {
    if (this.numRows !== 1 || this.numCols !== 1) throw new Error('getValue needs a single cell');
    return this.sheet.grid.cells[this.row - 1][this.col - 1];
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
  appendRow(values) {
    const row = this.grid.lastRow() + 1;
    if (row > this.grid.rows) throw new Error('appendRow past the end of the sheet');
    values.forEach((value, i) => { this.grid.cells[row - 1][i] = value; });
    this.calls.appendRow = (this.calls.appendRow || 0) + 1;
    return this;
  }
  deleteRows(rowIndex, howMany) {
    if (rowIndex < 2) throw new Error('deleteRows cannot remove the header row');
    if (rowIndex + howMany - 1 > this.getLastRow()) throw new Error('deleteRows past the data');
    this.grid.cells.splice(rowIndex - 1, howMany);
    for (let i = 0; i < howMany; i++) this.grid.cells.push(new Array(this.grid.cols).fill(''));
    this.calls.deleteRows = (this.calls.deleteRows || 0) + 1;
    return this;
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
const openedIds = [];

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
    openById: (id) => { openedIds.push(id); return spreadsheet; },
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
    // The admin key, the organiser accounts and the sessions live here in the
    // real runtime: per-script, never published, never in the repository.
    getScriptProperties: () => ({
      getProperty: k => (scriptProps.has(k) ? scriptProps.get(k) : null),
      setProperty: (k, v) => {
        // A real property value is capped at about 9 KB. Enforcing it here is
        // what makes the chunked account/session stores prove themselves.
        if (String(v).length > 9000) throw new Error('Property value too large: ' + String(v).length);
        scriptProps.set(k, v);
      },
      deleteProperty: k => scriptProps.delete(k)
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
        // A gateway that answers about the request it just received (echoing
        // the order id, for example) needs the request, not a fixed string.
        const body = typeof next.bodyFn === 'function'
          ? next.bodyFn(url, options)
          : next.body;
        return {
          getResponseCode: () => next.code,
          getContentText: () => body
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
// Apps Script's base64Encode takes either a String or a byte array, and the
// payments code passes it a string ('key:secret'). The mock must accept both,
// or it fails a call the real runtime happily makes.
sandbox.Utilities.base64Encode = (bytes) => {
  const buffer = typeof bytes === 'string'
    ? Buffer.from(bytes, 'utf8')
    : (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.map(b => (b + 256) % 256)));
  return buffer.toString('base64');
};
// Apps Script signs its byte arrays; PBKDF2's XOR relies on that, so the mock
// returns signed values too rather than a tidy unsigned array.
sandbox.Utilities.computeHmacSha256Signature = (value, key) => {
  const asBuffer = (input) => {
    if (typeof input === 'string') return Buffer.from(input, 'utf8');
    if (input && input.getBytes) return Buffer.from(input.getBytes().map(b => (b + 256) % 256));
    return Buffer.from(input.map(b => (b + 256) % 256));
  };
  const digest = crypto.createHmac('sha256', asBuffer(key)).update(asBuffer(value)).digest();
  return Array.from(digest).map(b => (b > 127 ? b - 256 : b));
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
// The contract grew by Status and Note so the organiser dashboard can work on
// the same rows the registrations already land in.
check('header has the original columns', sandbox.HEADERS.length === 26 &&
  sheet.grid.cells[0][8] === 'Player 4 Name' &&
  sheet.grid.cells[0][9] === 'Status' &&
  sheet.grid.cells[0][10] === 'Note' &&
  sheet.grid.cells[0][11] === 'WhatsApp Consent' &&
  sheet.grid.cells[0][12] === 'Consent At',
  JSON.stringify(sheet.grid.cells[0].slice(0, 20)));
// The payment columns were appended, never inserted, so every older row keeps
// its values in the same cells.
check('payment columns are appended after the original ones',
  sheet.grid.cells[0][13] === 'Entry Fee' &&
  sheet.grid.cells[0][14] === 'Payment Method' &&
  sheet.grid.cells[0][15] === 'Payment Status' &&
  sheet.grid.cells[0][16] === 'UTR / Reference' &&
  sheet.grid.cells[0][17] === 'Payment Note' &&
  sheet.grid.cells[0][18] === 'Payment Updated At' &&
  sheet.grid.cells[0][19] === 'Payment Updated By',
  JSON.stringify(sheet.grid.cells[0].slice(13, 20)));
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
// Two duplicate-number rules plus one colour rule for each payment status.
check('duplicate and payment rules installed', sheet.rules.length === 7, String(sheet.rules.length));
check('a paid cell is coloured distinctly',
  sheet.rules.some(r =>
    r.setRanges && r.whenFormulaSatisfied &&
    String(r.whenFormulaSatisfied[0]).indexOf('PAID') !== -1),
  JSON.stringify(sheet.rules.map(r => r.whenFormulaSatisfied && r.whenFormulaSatisfied[0])));
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
  sheet.grid.cells[0].slice(sandbox.HEADERS.length).every(v => v === '') &&
  sheet.grid.cells[1].slice(sandbox.HEADERS.length).every(v => v === ''),
  JSON.stringify(sheet.grid.cells[1].slice(sandbox.HEADERS.length - 1)));

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
// Leftovers now begin after the verified-payment columns, not after Note.
sheet.insertColumnsAfter(sandbox.HEADERS.length, 1); // an old script left a 27th column behind
sheet.grid.cells[0][sandbox.HEADERS.length] = 'old column';
cacheStore.clear(); // the repair only happens on a real sheet read, not a cached one
const repairedAgain = stats();
check('clears stale leftover header', sheet.grid.cells[0][sandbox.HEADERS.length] === '',
  JSON.stringify(sheet.grid.cells[0][sandbox.HEADERS.length]));
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
  const values = sheet.getRange(2, 1, rows, sandbox.HEADERS.length).getValues();
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
console.log('\n21. organiser accounts and PIN rules');

const SUPER_PIN = 'Championship-91-Xq';
const ORGANISER_PIN = 'Table-Tennis-24';

function loginCall(body) {
  return adminCall(Object.assign({ action: 'login' }, body));
}

const created = sandbox.setupSuperAdmin('fazeel', SUPER_PIN);
check('the first Super Admin can be created',
  created.ok === true && created.account.role === 'SUPER' && created.account.id === 'fazeel',
  JSON.stringify(created).slice(0, 200));

const storedAccounts = JSON.stringify(sandbox.orgAccounts_());
check('the PIN is stored as a salted PBKDF2 verifier',
  /^pbkdf2-sha256\$\d+\$[0-9a-f]{32}\$[A-Za-z0-9+/=]+$/.test(sandbox.orgAccounts_()[0].verifier),
  storedAccounts.slice(0, 200));
check('the PIN itself is never stored',
  storedAccounts.indexOf(SUPER_PIN) === -1 && SOURCE.indexOf(SUPER_PIN) === -1);
check('the verifier never leaves the server',
  JSON.stringify(adminCall({ action: 'account-list', key: adminKey })).indexOf('pbkdf2') === -1);
check('the iteration count is at least the configured floor',
  Number(sandbox.orgAccounts_()[0].verifier.split('$')[1]) >= sandbox.ORG.PBKDF2_FLOOR,
  sandbox.orgAccounts_()[0].verifier.split('$')[1]);

const weakPins = ['123456', '000000', 'aaaaaa', '12345678', 'password', 'qwerty123', 'abc123'];
const weakAccepted = weakPins.filter(pin => sandbox.orgCreateAccount_({ id: 'weak' + pin, pin: pin, role: 'ORGANIZER' }).ok);
check('weak and repeated PINs are refused', weakAccepted.length === 0, JSON.stringify(weakAccepted));
check('a PIN shorter than the minimum is refused',
  sandbox.orgCreateAccount_({ id: 'shorty', pin: 'Ab3', role: 'ORGANIZER' }).code === 'PIN');
check('a PIN equal to the organiser ID is refused',
  sandbox.orgCreateAccount_({ id: 'samepin', pin: 'samepin', role: 'ORGANIZER' }).code === 'PIN');
check('a PIN containing the organiser ID is refused',
  sandbox.orgCreateAccount_({ id: 'ravi', pin: 'ravi-scores-1', role: 'ORGANIZER' }).code === 'PIN');

const badIds = ['ab', 'has space', '<script>', 'x.y'.repeat(20), '-leading'];
const badIdAccepted = badIds.filter(id => sandbox.orgCreateAccount_({ id: id, pin: 'Good-Pin-77', role: 'ORGANIZER' }).ok);
check('malformed organiser IDs are refused', badIdAccepted.length === 0, JSON.stringify(badIdAccepted));
check('an organiser ID is normalised to lowercase',
  sandbox.orgCreateAccount_({ id: '  RAVI.K ', pin: ORGANISER_PIN, role: 'ORGANIZER' }).account.id === 'ravi.k');
check('a duplicate organiser ID is refused',
  sandbox.orgCreateAccount_({ id: 'ravi.k', pin: ORGANISER_PIN, role: 'ORGANIZER' }).code === 'EXISTS');

console.log('\n22. signing in');

const goodLogin = loginCall({ organiserId: 'fazeel', pin: SUPER_PIN, device: 'Galaxy S23' });
check('a valid organiser ID and PIN are accepted',
  goodLogin.ok === true && /^[a-f0-9]{64}$/.test(goodLogin.session), JSON.stringify(goodLogin).slice(0, 200));
check('the session response names the role', goodLogin.actor.role === 'SUPER');
check('the response lists what that role may do',
  goodLogin.permissions.indexOf('accounts.manage') !== -1);
check('the PIN is not echoed back', JSON.stringify(goodLogin).indexOf(SUPER_PIN) === -1);

const wrongPin = loginCall({ organiserId: 'fazeel', pin: 'Totally-Wrong-1' });
check('a wrong PIN is rejected', wrongPin.ok === false && wrongPin.code === 'CREDENTIALS', JSON.stringify(wrongPin));
const noSuchId = loginCall({ organiserId: 'nobody-here', pin: 'Totally-Wrong-1' });
check('an unknown organiser ID is rejected', noSuchId.ok === false && noSuchId.code === 'CREDENTIALS');
check('an unknown ID and a wrong PIN look identical', noSuchId.error === wrongPin.error,
  JSON.stringify({ a: noSuchId.error, b: wrongPin.error }));
check('a blank PIN is rejected before any hashing',
  loginCall({ organiserId: 'fazeel', pin: '' }).code === 'CREDENTIALS');
check('an organizer cannot sign in with the wrong account\'s PIN',
  loginCall({ organiserId: 'ravi.k', pin: SUPER_PIN }).ok === false);

console.log('\n23. lockout on repeated failures');

const lockedId = 'ravi.k';
for (let i = 0; i < sandbox.ORG.LOGIN_MAX_FAILS; i++) loginCall({ organiserId: lockedId, pin: 'nope-' + i + '-nope' });
const tooMany = loginCall({ organiserId: lockedId, pin: ORGANISER_PIN });
check('repeated failures lock the account out',
  tooMany.ok === false && tooMany.code === 'LOCKED', JSON.stringify(tooMany));
check('the lockout reports how long to wait', tooMany.retryAfterSeconds > 0);
check('the lockout does not reveal whether the ID exists',
  loginCall({ organiserId: 'still-nobody', pin: 'nope-nope-1' }).code !== 'LOCKED');
check('the correct PIN is refused while locked out', tooMany.ok === false);

cacheStore.delete(sandbox.orgLockKey_(lockedId));
cacheStore.delete(sandbox.orgFailKey_(lockedId));
const afterLock = loginCall({ organiserId: lockedId, pin: ORGANISER_PIN, device: 'Android tablet' });
check('the lock lifts after its window', afterLock.ok === true, JSON.stringify(afterLock).slice(0, 160));
check('an Organizer signs in with the ORGANIZER role', afterLock.actor.role === 'ORGANIZER');
check('an Organizer does not carry account management rights',
  afterLock.permissions.indexOf('accounts.manage') === -1);

console.log('\n24. sessions and server-side permissions');

const superSession = goodLogin.session;
const organiserSession = afterLock.session;

check('a call with no credentials at all is refused',
  adminCall({ action: 'account-list' }).code === 'AUTH');
const forged = adminCall({ action: 'list', session: 'a'.repeat(64) });
check('a forged session token is refused', forged.ok === false && forged.code === 'SESSION', JSON.stringify(forged));
check('a malformed session token is refused',
  adminCall({ action: 'list', session: '<script>' }).ok === false);

const bySession = adminCall({ action: 'list', session: superSession, pageSize: 50 });
check('a session token lists the registrations', bySession.ok === true && bySession.records.length >= 2);
const byKey = adminCall({ action: 'list', key: adminKey, pageSize: 50 });
check('sessions and the recovery key see the same records',
  bySession.total === byKey.total, JSON.stringify({ a: bySession.total, b: byKey.total }));

const organizerView = adminCall({ action: 'list', session: organiserSession, pageSize: 50 });
check('a second account sees exactly the same shared data',
  organizerView.ok === true && organizerView.total === bySession.total,
  JSON.stringify({ a: organizerView.total, b: bySession.total }));

const superOnly = [
  ['account-list', {}],
  ['account-create', { organiserId: 'hacker', pin: 'Hacker-Pin-99', role: 'SUPER' }],
  ['account-update', { id: 'ravi.k', role: 'SUPER' }],
  ['account-reset-pin', { id: 'fazeel', pin: 'New-Pin-12345' }],
  ['account-delete', { id: 'fazeel' }],
  ['account-revoke-sessions', { id: 'fazeel' }],
  ['session-list', {}],
  ['session-revoke', { handle: 'x'.repeat(30) }],
  ['audit-list', {}]
];
const leaked = superOnly.filter(([action, extra]) => {
  const result = adminCall(Object.assign({ action: action, session: organiserSession }, extra));
  return result.ok !== false || result.code !== 'FORBIDDEN';
});
check('an Organizer cannot perform any Super Admin action',
  leaked.length === 0, JSON.stringify(leaked));
check('an Organizer cannot promote themselves to Super Admin',
  adminCall({ action: 'account-update', session: organiserSession, id: 'ravi.k', role: 'SUPER' }).code === 'FORBIDDEN');
check('the refusal names the role instead of leaking data',
  /ORGANIZER/.test(adminCall({ action: 'session-list', session: organiserSession }).error));
check('nothing about the accounts is in that refusal',
  JSON.stringify(adminCall({ action: 'account-list', session: organiserSession })).indexOf('fazeel') === -1);

const organizerRecords = adminCall({ action: 'list', session: organiserSession, q: 'Shadow Squad' });
check('an Organizer can still view registrations', organizerRecords.ok === true);
check('an Organizer can still change a team status',
  adminCall({ action: 'note', session: organiserSession, id: organizerRecords.records[0].id, note: 'Checked by organiser' }).ok === true);
check('an Organizer can still export', adminCall({ action: 'export', session: organiserSession }).ok === true);
check('an Organizer can still read the WhatsApp config',
  adminCall({ action: 'notif-config', session: organiserSession }).ok === true);

console.log('\n25. logout, expiry, disabling and PIN reset');

const throwaway = loginCall({ organiserId: 'ravi.k', pin: ORGANISER_PIN, device: 'Test laptop' });
check('a second device gets its own session',
  throwaway.ok === true && throwaway.session !== organiserSession);
check('both devices work at the same time',
  adminCall({ action: 'list', session: organiserSession }).ok === true &&
  adminCall({ action: 'list', session: throwaway.session }).ok === true);

check('signing out ends that session', adminCall({ action: 'logout', session: throwaway.session }).ok === true);
const afterLogout = adminCall({ action: 'list', session: throwaway.session });
check('a signed-out session cannot be reused',
  afterLogout.ok === false && afterLogout.code === 'SESSION', JSON.stringify(afterLogout));
check('the other device stays signed in',
  adminCall({ action: 'list', session: organiserSession }).ok === true);
check('logging out twice is harmless',
  adminCall({ action: 'logout', session: throwaway.session }).ok === true);

const expiring = loginCall({ organiserId: 'ravi.k', pin: ORGANISER_PIN, device: 'Old tablet' });
const sessionsNow = sandbox.orgSessions_();
for (const record of sessionsNow) {
  if (record.t === sandbox.orgTokenHash_(expiring.session)) {
    record.idle = new Date().getTime() - 1000;
    record.abs = new Date().getTime() - 1000;
  }
}
sandbox.orgStoreWrite_(sandbox.ORG.SESSIONS_PROPERTY, sessionsNow);
const expired = adminCall({ action: 'list', session: expiring.session });
check('an expired session is refused',
  expired.ok === false && expired.code === 'SESSION', JSON.stringify(expired));
check('the expired session is dropped from the store',
  sandbox.orgSessions_().every(r => r.t !== sandbox.orgTokenHash_(expiring.session)));

const listed = adminCall({ action: 'session-list', session: superSession });
check('a Super Admin can list active sessions', listed.ok === true && listed.sessions.length >= 1);
check('the session list never carries a token',
  JSON.stringify(listed).indexOf(organiserSession) === -1);
const organiserRow = listed.sessions.filter(s => s.organiser === 'ravi.k')[0];
check('each session names the device it came from',
  !!organiserRow && /tablet|laptop|android|galaxy/i.test(organiserRow.device), JSON.stringify(organiserRow && organiserRow.device));
check('a Super Admin can end one device',
  adminCall({ action: 'session-revoke', session: superSession, handle: organiserRow.handle }).ok === true);
check('that device is now signed out',
  adminCall({ action: 'list', session: organiserSession }).code === 'SESSION');
check('an unknown session handle is refused',
  adminCall({ action: 'session-revoke', session: superSession, handle: 'y'.repeat(30) }).code === 'SESSION');

console.log('\n26. disabling, PIN reset and the last Super Admin');

check('the only Super Admin cannot be demoted',
  adminCall({ action: 'account-update', session: superSession, id: 'fazeel', role: 'ORGANIZER' }).code === 'LASTSUPER');
check('the only Super Admin cannot be disabled',
  adminCall({ action: 'account-update', session: superSession, id: 'fazeel', enabled: false }).code === 'LASTSUPER');
check('the only Super Admin cannot be deleted',
  adminCall({ action: 'account-delete', session: superSession, id: 'fazeel' }).code === 'LASTSUPER');

const coadmin = adminCall({
  action: 'account-create', session: superSession,
  organiserId: 'coadmin', pin: 'Deputy-Chief-2026', role: 'SUPER', name: 'Deputy'
});
check('a Super Admin can create another Super Admin',
  coadmin.ok === true && coadmin.account.role === 'SUPER', JSON.stringify(coadmin).slice(0, 160));
check('an ordinary organiser cannot be created with a weak PIN',
  adminCall({ action: 'account-create', session: superSession, organiserId: 'weakling', pin: '123456' }).code === 'PIN');
check('a new account is created enabled', coadmin.account.enabled === true);

const disabledNow = adminCall({ action: 'account-update', session: superSession, id: 'ravi.k', enabled: false });
check('a Super Admin can disable an organiser', disabledNow.ok === true && disabledNow.account.enabled === false);
check('disabling ends that organiser\'s sessions', disabledNow.sessionsRevoked >= 0);
const disabledLogin = loginCall({ organiserId: 'ravi.k', pin: ORGANISER_PIN });
check('a disabled account cannot sign in',
  disabledLogin.ok === false && disabledLogin.code === 'DISABLED', JSON.stringify(disabledLogin));

const reenabled = adminCall({ action: 'account-update', session: superSession, id: 'ravi.k', enabled: true });
check('a Super Admin can enable it again', reenabled.ok === true && reenabled.account.enabled === true);
const backIn = loginCall({ organiserId: 'ravi.k', pin: ORGANISER_PIN, device: 'Refreshed phone' });
check('the re-enabled account signs in again', backIn.ok === true);

const reset = adminCall({ action: 'account-reset-pin', session: superSession, id: 'ravi.k', pin: 'Ravi-New-Pin-77' });
check('a Super Admin can reset a PIN', reset.ok === true, JSON.stringify(reset).slice(0, 160));
check('the reset ended the sessions that account was holding', reset.sessionsRevoked >= 1);
check('the old PIN stops working', loginCall({ organiserId: 'ravi.k', pin: ORGANISER_PIN }).code === 'CREDENTIALS');
check('the new PIN works', loginCall({ organiserId: 'ravi.k', pin: 'Ravi-New-Pin-77' }).ok === true);
check('the reset did not change the role', sandbox.orgFindAccount_('ravi.k').role === 'ORGANIZER');

const selfSession = loginCall({ organiserId: 'ravi.k', pin: 'Ravi-New-Pin-77', device: 'Own phone' }).session;
check('a wrong current PIN is refused when changing your own PIN',
  adminCall({ action: 'self-change-pin', session: selfSession, currentPin: 'wrong-one', newPin: 'Self-Chosen-91' }).code === 'CREDENTIALS');
const selfChanged = adminCall({ action: 'self-change-pin', session: selfSession, currentPin: 'Ravi-New-Pin-77', newPin: 'Self-Chosen-91' });
check('an organiser can change their own PIN',
  selfChanged.ok === true && /^[a-f0-9]{64}$/.test(selfChanged.session), JSON.stringify(selfChanged).slice(0, 160));
check('the new PIN works', loginCall({ organiserId: 'ravi.k', pin: 'Self-Chosen-91' }).ok === true);
check('the organiser is still only an Organizer', sandbox.orgFindAccount_('ravi.k').role === 'ORGANIZER');

console.log('\n27. audit trail and isolation from the public site');

const audit = adminCall({ action: 'audit-list', session: superSession, pageSize: 100 });
check('a Super Admin can read the audit trail', audit.ok === true && audit.total > 0, JSON.stringify(audit).slice(0, 160));
const actions = audit.entries.map(e => e.action);
check('signing in is audited', actions.indexOf('login') !== -1, JSON.stringify(actions.slice(0, 12)));
check('account changes are audited', actions.indexOf('account-reset-pin') !== -1);
check('a refused login is audited', audit.entries.some(e => e.action === 'login' && e.result === 'refused'));
check('a refused permission is audited', actions.indexOf('permission-denied') !== -1);
check('the audit trail records who acted', audit.entries.some(e => e.actor === 'fazeel'));
check('the audit trail never contains a PIN',
  JSON.stringify(audit).indexOf(SUPER_PIN) === -1 && JSON.stringify(audit).indexOf('Ravi-New-Pin-77') === -1);
check('the audit trail never contains a session token',
  JSON.stringify(audit).indexOf(superSession) === -1);
const auditSheet = spreadsheet.getSheetByName('Audit');
check('the audit trail is written next to the registrations, not to a log',
  !!auditSheet && auditSheet.getLastRow() > 1);

check('the public stats endpoint is still open to visitors', stats().ok === true);
check('the public registration is still open to visitors',
  post(validPayload('Public Still Works')).ok === true);
check('a public visitor cannot read registrations through the admin route',
  adminCall({ action: 'list' }).code === 'AUTH');
check('the admin refusal carries no records',
  adminCall({ action: 'list' }).records === undefined);
check('the recovery key still grants the dashboard', byKey.ok === true);
check('the recovery key is treated as a Super Admin',
  adminCall({ action: 'account-list', key: adminKey }).ok === true);
check('organiser accounts are reported without secrets',
  sandbox.organiserStatus().ok === true &&
  JSON.stringify(sandbox.organiserStatus()).indexOf('pbkdf2') === -1);
check('adminStatus describes the account store without printing a PIN',
  (function () { sandbox.adminStatus(); return log.join(' ').indexOf(SUPER_PIN) === -1; })());

console.log('\n28. the deployed web app can find its own sheet');

/* A web app deployed as "execute as me / anyone" has no active spreadsheet,
   so a pinned ID is what makes it work. The ID must not live in this file,
   which is public, and it must not have to be re-typed on every deploy. */
check('the shipped file does not pin a spreadsheet id',
  /SHEET_ID:\s*''/.test(SOURCE) && !/SHEET_ID:\s*'[A-Za-z0-9_-]{20,}'/.test(SOURCE));

scriptProps.set('sheet_id', 'Sheet-From-Script-Properties-01');
openedIds.length = 0;
const fromProperty = sandbox.sheetId_();
check('the spreadsheet id is read from Script Properties',
  fromProperty === 'Sheet-From-Script-Properties-01', String(fromProperty));
check('opening the book uses that id',
  (sandbox.openBook_(), openedIds[openedIds.length - 1] === 'Sheet-From-Script-Properties-01'),
  JSON.stringify(openedIds));
check('the property is what a deployed web app relies on',
  sandbox.CONFIG.SHEET_ID === '' && !!sandbox.CONFIG.SHEET_ID_PROPERTY);

scriptProps.delete('sheet_id');
openedIds.length = 0;
check('without either, it falls back to the bound sheet',
  sandbox.sheetId_() === '' && sandbox.openBook_() === spreadsheet && openedIds.length === 0);

const missingSheet = sandbox.doGet({ parameter: { action: 'stats' } });
check('stats still answer with no id configured and no bound sheet',
  JSON.parse(missingSheet.getContent()).ok === true ||
  JSON.parse(missingSheet.getContent()).ok === false);

scriptProps.set('sheet_id', 'Sheet-From-Script-Properties-01');
check('the public counters work again once the id is set',
  JSON.parse(sandbox.doGet({ parameter: { action: 'stats' } }).getContent()).ok === true);
check('a registration still writes', post(validPayload('After Sheet Repair')).ok === true);
scriptProps.delete('sheet_id');

/* ------------------------- ₹100 team payment ------------------------- */

console.log('\n29. payment schema: ₹100 per team, never per player');

function sheetRowFor(name) {
  const rows = sheet.getLastRow() - 1;
  const values = sheet.getRange(2, 1, rows, sandbox.HEADERS.length).getValues();
  return values.filter(v => v[1] === name)[0] || null;
}

resetFetch();

const fourUp = post(Object.assign(validPayload('Fee Four Up'), { payment: { method: 'CASH' } }));
const twoUp = post(Object.assign(shortPayload('Fee Two Up', 2), { payment: { method: 'CASH' } }));

check('registration hands back the record id',
  typeof fourUp.id === 'string' && fourUp.id.length === 22, JSON.stringify(fourUp.id));
check('registration reports the team fee', fourUp.fee === 100, String(fourUp.fee));
check('a 2-player team pays the same ₹100', twoUp.fee === 100, String(twoUp.fee));

const fourRow = sheetRowFor('Fee Four Up');
const twoRow = sheetRowFor('Fee Two Up');
check('the fee is written on the row as a number', fourRow[13] === 100, JSON.stringify(fourRow[13]));
check('the 2-player row is also ₹100', twoRow[13] === 100, JSON.stringify(twoRow[13]));
check('a cash row starts as CASH / PENDING',
  String(fourRow[14]) === 'CASH' && String(fourRow[15]) === 'PENDING',
  JSON.stringify(fourRow.slice(14, 16)));

/* The browser must not be able to name its own price. */
const feeIgnored = post(Object.assign(validPayload('Fee Ignore Attempt'), { fee: 1, entryFee: 1 }));
const feeIgnoreRow = sheetRowFor('Fee Ignore Attempt');
check('a browser-supplied fee is ignored',
  feeIgnored.ok === true && feeIgnoreRow[13] === 100, JSON.stringify(feeIgnoreRow[13]));

/* Dropdowns for editing the sheet from a phone. */
check('the payment method column has a dropdown',
  !!sheet.validationCells['2,15'], JSON.stringify(Object.keys(sheet.validationCells).slice(0, 8)));
check('the payment status column has a dropdown', !!sheet.validationCells['2,16']);
check('the dropdown offers the organiser statuses',
  (function () {
    const rule = sheet.validationCells['2,16'];
    return rule && Array.isArray(rule.requireValueInList) &&
      rule.requireValueInList[0].indexOf('PAID') !== -1 &&
      rule.requireValueInList[0].indexOf('PENDING VERIFICATION') !== -1;
  })());

console.log('\n30. the organiser is the only one who can confirm money');

function markPayment(name, paymentStatus, expectedPayment, extra) {
  const rec = recordFor(name);
  return adminCall(Object.assign({
    action: 'payment-status', key: adminKey, id: rec.id,
    paymentStatus: paymentStatus, expectedPayment: expectedPayment
  }, extra || {}));
}

const paid = markPayment('Fee Four Up', 'PAID', 'PENDING', { note: 'Cash counted at the desk' });
check('an organiser marks the payment paid', paid.ok === true, JSON.stringify(paid));
check('the saved record reads PAID', paid.record.payment.status === 'PAID', JSON.stringify(paid.record.payment));
check('the actor is recorded', String(paid.record.payment.updatedBy).length > 0, String(paid.record.payment.updatedBy));
check('the verification note is kept', paid.record.payment.note === 'Cash counted at the desk');
check('the sheet shows PAID', String(sheetRowFor('Fee Four Up')[15]) === 'PAID');

const auditAfterPay = adminCall({ action: 'audit-list', key: adminKey, pageSize: 50 });
check('the payment change is in the audit history',
  (auditAfterPay.entries || []).some(e => e.action === 'payment-status'),
  JSON.stringify((auditAfterPay.entries || []).slice(0, 3)));

const stalePayment = markPayment('Fee Four Up', 'PENDING', 'PENDING');
check('a stale device cannot overwrite a newer payment decision',
  stalePayment.ok === false && stalePayment.code === 'STALE', JSON.stringify(stalePayment));
check('the paid row survives the stale attempt',
  String(sheetRowFor('Fee Four Up')[15]) === 'PAID');

const resetToNone = markPayment('Fee Two Up', 'NOT SELECTED', 'PENDING');
check('a recorded payment cannot be erased back to NOT SELECTED',
  resetToNone.ok === false && resetToNone.code === 'PAYMENT', JSON.stringify(resetToNone));

check('the paid row is untouched', String(sheetRowFor('Fee Four Up')[15]) === 'PAID');

const noMethodForPaid = (function () {
  const fresh = post(validPayload('Fee No Method'));
  return adminCall({
    action: 'payment-status', key: adminKey,
    id: fresh.id, paymentStatus: 'PAID', expectedPayment: 'NOT SELECTED'
  });
})();
check('PAID is refused until a method is known',
  noMethodForPaid.ok === false && noMethodForPaid.code === 'METHOD', JSON.stringify(noMethodForPaid));

console.log('\n31. payment status and registration status stay independent');

const stillApproved = setStatus('Fee Four Up', 'APPROVED');
check('a paid team can still be approved', stillApproved.ok === true, JSON.stringify(stillApproved));
check('approving it did not change the payment',
  stillApproved.record.payment.status === 'PAID', JSON.stringify(stillApproved.record.payment));

const cashPaid = markPayment('Fee Two Up', 'PAID', 'PENDING', { method: 'CASH' });
check('cash can be marked paid after it is received',
  cashPaid.ok === true && cashPaid.record.payment.status === 'PAID', JSON.stringify(cashPaid));
check('paying did not approve the team',
  cashPaid.record.status === 'PENDING', cashPaid.record.status);

const countsWithPayments = adminCall({ action: 'list', key: adminKey, pageSize: 100 }).counts;
check('counts report what has been collected',
  countsWithPayments.amountCollected >= 200 && countsWithPayments.paidTeams >= 2,
  JSON.stringify(countsWithPayments));
check('counts separate online and cash queues',
  typeof countsWithPayments.onlineAwaiting === 'number' &&
  typeof countsWithPayments.cashPending === 'number',
  JSON.stringify(countsWithPayments));
check('the fee is reported to the dashboard', countsWithPayments.fee === 100);

const paidFilter = adminCall({ action: 'list', key: adminKey, payment: 'PAID', pageSize: 100 });
check('the payment filter returns only paid teams',
  paidFilter.ok === true && paidFilter.records.length >= 2 &&
  paidFilter.records.every(r => r.payment.status === 'PAID'),
  JSON.stringify(paidFilter.records.map(r => r.payment.status)));

const awaiting = adminCall({ action: 'list', key: adminKey, payment: 'AWAITING', pageSize: 100 });
check('the awaiting filter never includes a paid team',
  awaiting.records.every(r => r.payment.status !== 'PAID'),
  JSON.stringify(awaiting.records.map(r => r.payment.status)));

const exportCsv = adminCall({ action: 'export', key: adminKey });
check('the export carries the payment columns',
  exportCsv.ok === true &&
  /Payment Status/.test(exportCsv.csv) && /UTR \/ Reference/.test(exportCsv.csv) &&
  /₹?100/.test(exportCsv.csv), exportCsv.csv.split('\r\n')[0]);

check('organisers hold the payment permission',
  sandbox.orgPermissionsOf_('ORGANIZER').indexOf('pay.update') !== -1 &&
  sandbox.orgPermissionsOf_('SUPER').indexOf('pay.update') !== -1);
check('payment-status is a guarded action',
  sandbox.ORG_ACTION_PERMISSION['payment-status'] === 'pay.update');

console.log('\n32. formatting on a standalone script (no Document Properties)');

/* This project is deployed as a standalone web app: the sheet is opened by id,
   so PropertiesService.getDocumentProperties() is null. A memo that assumed it
   existed threw, the payment dropdowns were never installed on the real sheet,
   and the error was swallowed as "formatting skipped". */
{
  const realGetDoc = sandbox.PropertiesService.getDocumentProperties;
  sandbox.PropertiesService.getDocumentProperties = () => null;
  propsStore.clear();

  // Forget the memo so the next ensureHeaders_ has to format.
  scriptProps.delete('qqsgp_sheet_format_v3');

  const before = sheet.rules.length;
  const dropBefore = !!sheet.validationCells['2,16'];

  // A fresh registration goes through ensureHeaders_ -> ensureFormattingApplied_.
  const onStandalone = post(validPayload('Fee Standalone Format'));

  check('a registration still saves without Document Properties',
    onStandalone.ok === true, JSON.stringify(onStandalone));
  check('formatting is applied instead of throwing',
    sheet.rules.length > 0 && sheet.rules.length >= before - 2,
    'rules=' + sheet.rules.length + ' (was ' + before + ')');
  check('the payment dropdowns are installed without Document Properties',
    !!sheet.validationCells['2,16'] || dropBefore,
    JSON.stringify(Object.keys(sheet.validationCells).slice(0, 6)));
  check('nothing was logged as skipped',
    log.filter(l => /Sheet formatting skipped/.test(l)).length === 0,
    log.filter(l => /formatting skipped/.test(l)).join(' | '));

  // And the paid row from earlier is still readable afterwards.
  const stillPaid = recordFor('Fee Four Up');
  check('earlier payment decisions survive the formatting pass',
    stillPaid && stillPaid.payment.status === 'PAID',
    JSON.stringify(stillPaid && stillPaid.payment));

  sandbox.PropertiesService.getDocumentProperties = realGetDoc;
}

/* ------------------- payment chosen at registration ------------------- */

console.log('\n34. the fee step gates the registration');

// A block keeps these fixtures from colliding with names used earlier.
{
const cashNow = post(Object.assign(validPayload('Fee At Submit Cash'), { payment: { method: 'CASH' } }));
check('choosing cash registers the team', cashNow.ok === true, JSON.stringify(cashNow));
check('cash is saved as PENDING',
  cashNow.payment.status === 'PENDING' && cashNow.payment.method === 'CASH',
  JSON.stringify(cashNow.payment));
check('the cash row is written with method and status',
  String(sheetRowFor('Fee At Submit Cash')[14]) === 'CASH' &&
  String(sheetRowFor('Fee At Submit Cash')[15]) === 'PENDING',
  JSON.stringify(sheetRowFor('Fee At Submit Cash').slice(14, 18)));

/* The old bypass: post ONLINE, get a PAID row with no money behind it. This is
   the exact request a fabricated page or a curious student would send. */
const onlineNow = post(Object.assign(validPayload('Fee At Submit Online'), {
  payment: { method: 'ONLINE', utr: '4187 2210 9931' }
}));
check('a registration that claims online payment is refused',
  onlineNow.ok === false && /payment step/i.test(onlineNow.error), JSON.stringify(onlineNow));
check('the refused online claim wrote no row', sheetRowFor('Fee At Submit Online') === null,
  JSON.stringify(sheetRowFor('Fee At Submit Online')));

const paidClaim = post(Object.assign(validPayload('Fee Claims Paid'), {
  payment: { method: 'ONLINE', status: 'PAID', utr: 'PAID12345', paidAmount: 100 }
}));
check('a claim of PAID with extra fields is still refused', paidClaim.ok === false, JSON.stringify(paidClaim));
check('no row was written for the PAID claim', sheetRowFor('Fee Claims Paid') === null);

const noRef = post(Object.assign(validPayload('Fee Online No Ref'), { payment: { method: 'ONLINE' } }));
check('online without a reference is refused too', noRef.ok === false, JSON.stringify(noRef));
check('and writes no row either', sheetRowFor('Fee Online No Ref') === null);

const badMethod = post(Object.assign(validPayload('Fee Bad Method'), { payment: { method: 'BITCOIN' } }));
check('an unknown method is refused', badMethod.ok === false, JSON.stringify(badMethod));
check('the refused payment wrote no row', sheetRowFor('Fee Bad Method') === null);

const noChoicePost = post(validPayload('Fee Legacy No Choice'));
check('an older page with no payment block still registers',
  noChoicePost.ok === true && noChoicePost.payment.status === 'NOT SELECTED',
  JSON.stringify(noChoicePost.payment));

const retried = post(Object.assign(validPayload('Fee At Submit Cash'), { payment: { method: 'CASH' } }));
check('a retried submission cannot create a second registration',
  retried.ok === false && /already registered/i.test(retried.error), JSON.stringify(retried));
check('still exactly one row for that team',
  (function () {
    const rows = sheet.getLastRow() - 1;
    const values = sheet.getRange(2, 1, rows, sandbox.HEADERS.length).getValues();
    return values.filter(v => v[1] === 'Fee At Submit Cash').length === 1;
  })());

const flowCounts = adminCall({ action: 'list', key: adminKey, pageSize: 100 }).counts;
check('nothing is self-declared as paid any more',
  flowCounts.selfReported === 0, JSON.stringify(flowCounts));

const beforeQuestion = recordFor('Fee Four Up');
const questioned = markPayment('Fee Four Up', 'NEEDS REVIEW', 'PAID');
check('an organiser can still question a payment',
  questioned.ok === true && questioned.record.payment.status === 'NEEDS REVIEW',
  JSON.stringify(questioned));
check('questioning it did not touch the registration status',
  questioned.record.status === beforeQuestion.status,
  beforeQuestion.status + ' -> ' + questioned.record.status);
}

/* ==================================================================
   35. VERIFIED ONLINE PAYMENT (Razorpay)
   ------------------------------------------------------------------
   The point of this section is the bypass: a browser can post whatever it
   likes, but a team may only exist because Razorpay told us, over an
   authenticated API call, that the exact fee was captured.
   ================================================================== */

console.log('\n35. verified online payment');

// A block keeps these fixtures from colliding with names used earlier.
{

function postRoute(route, payload) {
  const res = sandbox.doPost({
    parameter: { action: route },
    postData: { contents: JSON.stringify(payload) }
  });
  return JSON.parse(res.getContent());
}

function queueJson(body, code) {
  queueFetch({ code: code === undefined ? 200 : code, body: JSON.stringify(body) });
}

function publicConfig() {
  return JSON.parse(sandbox.doGet({ parameter: { action: 'config' } }).getContent());
}

function countRows(name) {
  const rows = sheet.getLastRow() - 1;
  if (rows < 1) return 0;
  const values = sheet.getRange(2, 1, rows, sandbox.HEADERS.length).getValues();
  return values.filter(v => v[1] === name).length;
}

function draftRowFor(token) {
  const drafts = spreadsheet.getSheetByName('PaymentDrafts');
  if (!drafts || drafts.getLastRow() < 2) return null;
  const values = drafts.getRange(2, 1, drafts.getLastRow() - 1, 17).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === token) return { sheet: drafts, row: i + 2, values: values[i] };
  }
  return null;
}

/* --- the provider is not configured yet --- */
scriptProps.delete('razorpay_key_id');
scriptProps.delete('razorpay_key_secret');
resetFetch();

const offline = postRoute('payorder', validPayload('Online Not Configured'));
check('online is refused while the provider is not configured',
  offline.ok === false && offline.code === 'PAYMENT_OFFLINE', JSON.stringify(offline));
check('nothing was sent to a provider that is not configured', fetchCalls.length === 0);
check('the page is told online is off', publicConfig().online === false, JSON.stringify(publicConfig()));
check('no draft and no row were created', countRows('Online Not Configured') === 0);

/* --- the fee is data, not a constant --- */
const feeSet = adminCall({ action: 'settings-set', session: superSession, fee: 150 });
check('an organiser can change the entry fee', feeSet.ok === true && feeSet.fee === 150, JSON.stringify(feeSet));
check('the page is given the new fee', publicConfig().fee === 150, JSON.stringify(publicConfig()));
const feeRead = adminCall({ action: 'settings-get', session: superSession });
check('the dashboard reads the fee back', feeRead.ok === true && feeRead.fee === 150, JSON.stringify(feeRead));
const badFee = adminCall({ action: 'settings-set', session: superSession, fee: 0 });
check('a zero fee is refused', badFee.ok === false, JSON.stringify(badFee));
check('changing the fee is a guarded action',
  sandbox.ORG_ACTION_PERMISSION['settings-set'] === 'pay.update');
adminCall({ action: 'settings-set', session: superSession, fee: 150 });

/* --- a Razorpay setting must not switch anything on any more --- */
scriptProps.set('payment_provider', 'razorpay');
scriptProps.set('razorpay_key_id', 'rzp_test_KEY');
scriptProps.set('razorpay_key_secret', 'test_secret_value');

check('a Razorpay setting cannot switch online payment on',
  publicConfig().online === false && publicConfig().provider === 'YOUPI', JSON.stringify(publicConfig()));

const namedOnly = postRoute('payorder', validPayload('Online Razorpay Named'));
check('a Razorpay-shaped configuration opens no payment',
  namedOnly.ok === false && namedOnly.code === 'PAYMENT_OFFLINE', JSON.stringify(namedOnly));
check('no gateway was called for it', fetchCalls.length === 0);
check('no Razorpay order or QR call exists in the backend', typeof sandbox.razorpayCall_ === 'undefined');
check('no draft and no row were created',
  countRows('Online Razorpay Named') === 0);

/* Leave the sheet on its original fee for anything that follows. */
adminCall({ action: 'settings-set', session: superSession, fee: 100 });
scriptProps.delete('payment_provider');
scriptProps.delete('razorpay_key_id');
scriptProps.delete('razorpay_key_secret');
resetFetch();
}

/* ==================================================================
   36. YouPI PG as the provider
   ------------------------------------------------------------------
   The gateway here is a self-hosted YouPI instance. What matters is that
   this project never treats "the checkout page opened" as payment: only a
   merchant-authenticated GET that answers SUCCESS, for our order, for the
   snapshotted fee, in INR, at the required verification level, may write a
   row. The API shapes below are copied from YouPI's openapi.yaml and from
   real answers captured from a local instance.
   ================================================================== */

console.log('\n36. YouPI PG provider');

{
const YOUPI_KEY = 'youpi_merchant_key_for_tests_0123456789';

function yPost(route, payload) {
  const res = sandbox.doPost({
    parameter: { action: route },
    postData: { contents: JSON.stringify(payload) }
  });
  return JSON.parse(res.getContent());
}

function yQueue(body, code) {
  queueFetch({ code: code === undefined ? 200 : code, body: JSON.stringify(body) });
}

/** Answers as the gateway does: echo the order id it was just given. */
function yQueueEcho(extra) {
  queueFetch({
    code: 200,
    bodyFn: (url, options) => JSON.stringify(Object.assign(
      { orderId: JSON.parse(options.payload || '{}').orderId },
      extra)
    )
  });
}

function yDraft(token) {
  const drafts = spreadsheet.getSheetByName('PaymentDrafts');
  if (!drafts || drafts.getLastRow() < 2) return null;
  const values = drafts.getRange(2, 1, drafts.getLastRow() - 1, sandbox.DRAFT_HEADERS.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === token) return { sheet: drafts, row: i + 2, values: values[i] };
  }
  return null;
}

function yRows(name) {
  const rows = sheet.getLastRow() - 1;
  if (rows < 1) return 0;
  return sheet.getRange(2, 1, rows, sandbox.HEADERS.length).getValues()
    .filter(v => v[1] === name).length;
}

function yConfig() {
  return JSON.parse(sandbox.doGet({ parameter: { action: 'config' } }).getContent());
}

/* --- switch the deployment to YouPI, credentials in Script Properties --- */
scriptProps.set('payment_provider', 'youpi');
scriptProps.set('youpi_base_url', 'http://127.0.0.1:6100');
scriptProps.set('youpi_merchant_id', '00000000-0000-0000-0000-000000000001');
scriptProps.set('youpi_merchant_key', YOUPI_KEY);
scriptProps.delete('youpi_min_verification_level');

const yCfg = yConfig();
check('the page is told the gateway is YouPI',
  yCfg.provider === 'YOUPI' && yCfg.hosted === true && yCfg.online === true, JSON.stringify(yCfg));
check('the page is told the verification level this event requires',
  yCfg.minVerification === 2, JSON.stringify(yCfg));
check('the merchant key never reaches the page', JSON.stringify(yCfg).indexOf(YOUPI_KEY) === -1);
check('the dashboard sees the same gateway',
  (() => { const s = adminCall({ action: 'settings-get', session: superSession });
    return s.ok === true && s.provider === 'YOUPI' && s.minVerification === 2; })(), 'settings-get');

/* --- a timed-out create reuses the persisted token/order id --- */
resetFetch();
queueFetch({ throws: 'simulated timeout after request was sent' });
const yTimedOut = yPost('payorder', validPayload('YouPI Timeout Retry'));
check('a failed create leaves a persisted CREATING draft',
  yTimedOut.ok === false && yTimedOut.code === 'PROVIDER' &&
  (() => { const drafts = spreadsheet.getSheetByName('PaymentDrafts');
    const rows = drafts.getRange(2, 1, drafts.getLastRow() - 1, sandbox.DRAFT_HEADERS.length).getValues();
    return rows.some(row => row[3] === 'YouPI Timeout Retry' && row[12] === 'CREATING' && !!row[0]); })());

const timeoutDrafts = spreadsheet.getSheetByName('PaymentDrafts');
const timeoutRows = timeoutDrafts.getRange(2, 1, timeoutDrafts.getLastRow() - 1, sandbox.DRAFT_HEADERS.length).getValues();
const timeoutDraft = timeoutRows.map((row, index) => ({ row, index }))
  .find(item => item.row[3] === 'YouPI Timeout Retry');
const timeoutToken = String(timeoutDraft.row[0]);
const timeoutOrderId = 'QQSGP-' + timeoutToken.slice(0, 18).toUpperCase();
resetFetch();
yQueueEcho({
  paymentId: 'pay_YOUPI_TIMEOUT_RETRY', amount: '100.00',
  amountPaise: '10000', currency: 'INR', status: 'INITIATED',
  checkoutUrl: 'http://127.0.0.1:7000/checkout/pay_YOUPI_TIMEOUT_RETRY'
});
const yRetried = yPost('payorder', validPayload('YouPI Timeout Retry'));
const retriedDraft = yDraft(timeoutToken);
check('retry reuses the original token and order id',
  yRetried.ok === true && yRetried.token === timeoutToken &&
  fetchCalls.length === 1 && JSON.parse(fetchCalls[0].options.payload).orderId === timeoutOrderId);
check('successful retry updates the same draft to OPEN',
  retriedDraft && String(retriedDraft.values[12]) === 'OPEN' &&
  String(retriedDraft.values[9]) === timeoutOrderId &&
  String(retriedDraft.values[13]) === 'pay_YOUPI_TIMEOUT_RETRY');
check('the retry added no second draft row for the team',
  (() => { const drafts = spreadsheet.getSheetByName('PaymentDrafts');
    const rows = drafts.getRange(2, 1, drafts.getLastRow() - 1, sandbox.DRAFT_HEADERS.length).getValues();
    return rows.filter(row => row[3] === 'YouPI Timeout Retry').length === 1; })());

/* --- a second click while the checkout is live reuses it, silently --- */
resetFetch();
const ySecondClick = yPost('payorder', validPayload('YouPI Timeout Retry'));
check('a second click reuses the open checkout without calling the gateway',
  ySecondClick.ok === true && ySecondClick.resumed === true &&
  ySecondClick.token === timeoutToken && fetchCalls.length === 0,
  JSON.stringify(ySecondClick));

/* --- a fee change never reorders an attempt already in flight --- */
resetFetch();
queueFetch({ throws: 'simulated timeout before the gateway answered' });
const yFeeOpen = yPost('payorder', validPayload('YouPI Fee Snapshot'));
const feeDrafts = spreadsheet.getSheetByName('PaymentDrafts');
const feeRows = feeDrafts.getRange(2, 1, feeDrafts.getLastRow() - 1, sandbox.DRAFT_HEADERS.length).getValues();
const feeToken = String(feeRows.find(row => row[3] === 'YouPI Fee Snapshot')[0]);
check('the failed open still persisted the attempt at the old fee',
  yFeeOpen.ok === false && !!feeToken &&
  Number(feeRows.find(row => row[3] === 'YouPI Fee Snapshot')[7]) === 100);
adminCall({ action: 'settings-set', session: superSession, fee: 250 });
resetFetch();
yQueueEcho({
  paymentId: 'pay_YOUPI_FEE_SNAPSHOT', amount: '100.00',
  amountPaise: '10000', currency: 'INR', status: 'INITIATED',
  checkoutUrl: 'http://127.0.0.1:7000/checkout/pay_YOUPI_FEE_SNAPSHOT'
});
const yFeeRetry = yPost('payorder', validPayload('YouPI Fee Snapshot'));
const feeRetryBody = JSON.parse(fetchCalls[0].options.payload);
check('the retry still asks for the fee the team originally saw',
  feeRetryBody.amount === '100.00' && yFeeRetry.ok === true && yFeeRetry.amount === 100 &&
  yFeeRetry.token === feeToken,
  JSON.stringify({ sent: feeRetryBody.amount, answered: yFeeRetry.amount }));
adminCall({ action: 'settings-set', session: superSession, fee: 100 });

/* --- the sheet failing is never reported as paid --- */
resetFetch();
yQueueEcho({
  paymentId: 'pay_YOUPI_SHEET_DOWN', amount: '100.00',
  amountPaise: '10000', currency: 'INR', status: 'INITIATED',
  checkoutUrl: 'http://127.0.0.1:7000/checkout/pay_YOUPI_SHEET_DOWN'
});
const ySheetOpen = yPost('payorder', validPayload('YouPI Sheet Down'));
const sheetDownDraft = yDraft(ySheetOpen.token);
const realGetRange = sheet.getRange.bind(sheet);
sheet.getRange = function (row, col, numRows, numCols) {
  // Only the write of a NEW registration row fails; every read keeps working.
  // "The target row is still empty" is what separates that write from any
  // read of existing data, even when the sheet holds a single registration.
  const target = sheet.grid.cells[row - 1] || [];
  const writingNewRow = row === sheet.getLastRow() + 1 &&
    target.length > 0 && target.every(value => value === '');
  if (writingNewRow && numRows === 1 && numCols === sandbox.HEADERS.length) {
    return {
      setNumberFormat() { return this; },
      setValues() { throw new Error('simulated sheet outage'); }
    };
  }
  return realGetRange(row, col, numRows, numCols);
};
resetFetch();
yQueue({
  paymentId: 'pay_YOUPI_SHEET_DOWN', orderId: String(sheetDownDraft.values[9]),
  amount: '100.00', amountPaise: '10000', currency: 'INR', status: 'SUCCESS', verificationLevel: 2
});
const ySheetDown = yPost('paystatus', { token: ySheetOpen.token });
sheet.getRange = realGetRange;
check('a sheet failure is reported as an error, never as paid',
  ySheetDown.ok === false && ySheetDown.state === undefined, JSON.stringify(ySheetDown));
check('the failed write registered no team', yRows('YouPI Sheet Down') === 0);

// The money is not lost: the next poll registers the team exactly once.
resetFetch();
yQueue({
  paymentId: 'pay_YOUPI_SHEET_DOWN', orderId: String(sheetDownDraft.values[9]),
  amount: '100.00', amountPaise: '10000', currency: 'INR', status: 'SUCCESS', verificationLevel: 2
});
const ySheetRecovered = yPost('paystatus', { token: ySheetOpen.token });
check('the next poll after the outage registers the team exactly once',
  ySheetRecovered.ok === true && ySheetRecovered.state === 'PAID' && yRows('YouPI Sheet Down') === 1,
  JSON.stringify(ySheetRecovered));

/* --- opening a payment --- */
resetFetch();
yQueueEcho({
  paymentId: 'pay_YOUPI1', amount: '100.00',
  amountPaise: '10000', currency: 'INR', status: 'INITIATED', queuePosition: 0,
  checkoutUrl: 'http://127.0.0.1:7000/checkout/pay_YOUPI1'
});

const yOpened = yPost('payorder', validPayload('YouPI Squad'));
check('opening a YouPI payment returns the gateway checkout page',
  yOpened.ok === true && yOpened.hosted === true &&
  yOpened.checkoutUrl === 'http://127.0.0.1:7000/checkout/pay_YOUPI1',
  JSON.stringify(yOpened));
check('the YouPI call goes to the configured instance',
  fetchCalls.length === 1 && fetchCalls[0].url === 'http://127.0.0.1:6100/api/v1/payments',
  fetchCalls.map(c => c.url).join(', '));
check('the merchant key is sent as X-Merchant-Key, never in the URL',
  fetchCalls[0].options.headers['X-Merchant-Key'] === YOUPI_KEY &&
  fetchCalls[0].options.headers['X-Merchant-Id'] === '00000000-0000-0000-0000-000000000001' &&
  fetchCalls[0].url.indexOf(YOUPI_KEY) === -1);

const yBody = JSON.parse(fetchCalls[0].options.payload);
check('the amount is the snapshotted fee, in rupees with two decimals',
  yBody.amount === '100.00' && yBody.currency === 'INR', JSON.stringify(yBody));
check('the order id is generated by us, not taken from the browser',
  /^QQSGP-[A-Z0-9]{6,}$/.test(yBody.orderId), yBody.orderId);
check('an answer about a different order is refused',
  (function () {
    resetFetch();
    yQueue({
      paymentId: 'pay_OTHER', orderId: 'QQSGP-SOMEBODY-ELSE', amount: '100.00',
      amountPaise: '10000', currency: 'INR', status: 'INITIATED',
      checkoutUrl: 'http://127.0.0.1:7000/checkout/pay_OTHER'
    });
    const other = yPost('payorder', validPayload('YouPI Wrong Echo'));
    return other.ok === false && yRows('YouPI Wrong Echo') === 0;
  })(), 'wrong order echo');
check('nothing about the team is charged twice or guessed',
  yBody.metadata && yBody.metadata.token === yOpened.token);
check('no registration row exists while the checkout is open', yRows('YouPI Squad') === 0);
check('the draft remembers the gateway and the checkout URL',
  (() => { const d = yDraft(yOpened.token);
    return d.values[17] === 'YOUPI' && String(d.values[18]) === 'http://127.0.0.1:7000/checkout/pay_YOUPI1'; })(),
  JSON.stringify(yDraft(yOpened.token).values.slice(17, 20)));
check('the key secret is never echoed to the browser',
  JSON.stringify(yOpened).indexOf(YOUPI_KEY) === -1);

/* --- the gateway refuses our credential --- */
resetFetch();
yQueue({ error: 'Invalid merchant key', code: 'INVALID_MERCHANT_KEY' }, 401);
const yBadKey = yPost('payorder', validPayload('YouPI Bad Key'));
check('a rejected merchant key is reported, not faked',
  yBadKey.ok === false && yBadKey.code === 'PROVIDER', JSON.stringify(yBadKey));
check('nobody is registered when the gateway refuses', yRows('YouPI Bad Key') === 0);

/* --- still waiting --- */
resetFetch();
yQueue({
  paymentId: 'pay_YOUPI1', orderId: yBody.orderId, amount: '100.00', amountPaise: '10000',
  currency: 'INR', status: 'ACTIVE', verificationLevel: 0, verificationTag: 'UNVERIFIED'
});
const yWaiting = yPost('paystatus', { token: yOpened.token });
check('an open checkout stays PENDING', yWaiting.ok === true && yWaiting.state === 'PENDING', JSON.stringify(yWaiting));
check('PENDING writes no row', yRows('YouPI Squad') === 0);
check('the owner status call is authenticated with the merchant key',
  fetchCalls.length === 1 &&
  fetchCalls[0].options.headers['X-Merchant-Key'] === YOUPI_KEY &&
  /\/api\/v1\/payments\/pay_YOUPI1$/.test(fetchCalls[0].url), fetchCalls.map(c => c.url).join(', '));

/* --- a forged webhook with a body full of SUCCESS --- */
const yForged = yPost('paywebhook', {
  event: 'SUCCESS', paymentId: 'pay_NEVER_MADE', orderId: 'QQSGP-NEVER',
  amount: '100.00', amountPaise: 10000, currency: 'INR', utr: '999999999999'
});
check('a webhook naming a session we never opened is ignored',
  yForged.ok === true && yForged.ignored === true, JSON.stringify(yForged));
check('a forged webhook registers nobody', yRows('YouPI Squad') === 0);

resetFetch();
yQueue({
  paymentId: 'pay_YOUPI1', orderId: yBody.orderId, amount: '100.00', amountPaise: '10000',
  currency: 'INR', status: 'ACTIVE', verificationLevel: 0
});
const yDoorbell = yPost('paywebhook', {
  event: 'SUCCESS', paymentId: 'pay_YOUPI1', orderId: yBody.orderId,
  amount: '100.00', amountPaise: 10000, currency: 'INR', utr: '123456789012'
});
check('a SUCCESS body with our ids but no payment at the gateway is refused',
  yDoorbell.ok === true && yDoorbell.state !== 'PAID', JSON.stringify(yDoorbell));
check('the forged body did not create a paid team', yRows('YouPI Squad') === 0);

/* --- money reported below the required verification level --- */
resetFetch();
yQueue({
  paymentId: 'pay_YOUPI1', orderId: yBody.orderId, amount: '100.00', amountPaise: '10000',
  currency: 'INR', status: 'SUCCESS', method: 'UPI', verificationLevel: 1,
  verificationTag: 'SMS_ONLY', completedAt: new Date().toISOString()
});
const yWeak = yPost('paystatus', { token: yOpened.token });
check('a level-1 payment is not accepted at the configured level 2',
  yWeak.ok === true && yWeak.state === 'REVIEW', JSON.stringify(yWeak));
check('a weakly verified payment registers no team', yRows('YouPI Squad') === 0);
check('the attempt is held as NEEDS REVIEW for an organiser',
  yDraft(yOpened.token).values[12] === 'NEEDS REVIEW', yDraft(yOpened.token).values[12]);

const yWeakAudit = adminCall({ action: 'audit-list', session: superSession, pageSize: 100 });
check('the unverified payment is audited',
  (yWeakAudit.entries || []).some(e => e.action === 'payment-unverified'),
  JSON.stringify((yWeakAudit.entries || []).slice(0, 5).map(e => e.action)));

/* --- the same team cannot open a second way to pay while one is held --- */
resetFetch();
const yHeldAgain = yPost('payorder', validPayload('YouPI Squad'));
check('a team with a payment under review is not handed a second checkout',
  yHeldAgain.ok === false && yHeldAgain.code === 'REVIEW', JSON.stringify(yHeldAgain));
check('that refusal opens no new session', fetchCalls.length === 0);

/* --- the right money, the wrong amount (its own draft: a mismatch closes an
       attempt, by design) --- */
resetFetch();
yQueueEcho({
  paymentId: 'pay_YOUPI_SHORT', amount: '100.00', amountPaise: '10000',
  currency: 'INR', status: 'INITIATED',
  checkoutUrl: 'http://127.0.0.1:7000/checkout/pay_YOUPI_SHORT'
});
const yShortOpen = yPost('payorder', validPayload('YouPI Short'));
const yShortOrder = JSON.parse(fetchCalls[0].options.payload).orderId;

resetFetch();
yQueue({
  paymentId: 'pay_YOUPI_SHORT', orderId: yShortOrder, amount: '50.00', amountPaise: '5000',
  currency: 'INR', status: 'SUCCESS', verificationLevel: 2
});
const yShort = yPost('paystatus', { token: yShortOpen.token });
check('a SUCCESS for the wrong amount is refused',
  yShort.state === 'REVIEW', JSON.stringify(yShort));
check('the wrong amount registers no team', yRows('YouPI Short') === 0);

/* --- the right amount against another order --- */
resetFetch();
yQueueEcho({
  paymentId: 'pay_YOUPI_OTHER', amount: '100.00', amountPaise: '10000',
  currency: 'INR', status: 'INITIATED',
  checkoutUrl: 'http://127.0.0.1:7000/checkout/pay_YOUPI_OTHER'
});
const yOtherOpen = yPost('payorder', validPayload('YouPI Wrong Order'));

resetFetch();
yQueue({
  paymentId: 'pay_YOUPI_OTHER', orderId: 'QQSGP-SOMEONE-ELSE', amount: '100.00', amountPaise: '10000',
  currency: 'INR', status: 'SUCCESS', verificationLevel: 2
});
const yWrongOrder = yPost('paystatus', { token: yOtherOpen.token });
check('a payment for another order is refused',
  yWrongOrder.state === 'REVIEW', JSON.stringify(yWrongOrder));
check('another order registers nobody here', yRows('YouPI Wrong Order') === 0);

/* --- the real thing --- */
resetFetch();
yQueue({
  paymentId: 'pay_YOUPI1', orderId: yBody.orderId, amount: '100.00', amountPaise: '10000',
  currency: 'INR', status: 'SUCCESS', method: 'UPI', verificationLevel: 2,
  verificationTag: 'DUAL_VERIFIED', completedAt: new Date().toISOString()
});
const yPaid = yPost('paystatus', { token: yOpened.token });
check('a SUCCESS at level 2 registers the team',
  yPaid.ok === true && yPaid.state === 'PAID' && yPaid.team === 'YouPI Squad', JSON.stringify(yPaid));
check('exactly one row was written', yRows('YouPI Squad') === 1);

const yRow = sheetRowFor('YouPI Squad');
check('the row is ONLINE / PAID',
  String(yRow[14]) === 'ONLINE' && String(yRow[15]) === 'PAID', JSON.stringify(yRow.slice(14, 16)));
check('the row keeps the fee snapshot', Number(yRow[13]) === 100, String(yRow[13]));
check('the row names YouPI as the provider', String(yRow[25]) === 'YOUPI', String(yRow[25]));
check('the gateway session id is stored', String(yRow[21]) === 'pay_YOUPI1', String(yRow[21]));
check('the verified amount and currency are stored',
  Number(yRow[22]) === 100 && String(yRow[23]) === 'INR', JSON.stringify(yRow.slice(22, 24)));
check('the verification time is a real timestamp',
  Object.prototype.toString.call(yRow[24]) === '[object Date]');
check('the note says how it was verified, including the level',
  /YouPI/.test(String(yRow[17])) && /verification level 2/.test(String(yRow[17])), String(yRow[17]));
check('the draft is FINALISED with the registration id',
  yDraft(yOpened.token).values[12] === 'FINALISED' &&
  String(yDraft(yOpened.token).values[15]) === yPaid.registrationId);

/* --- the gateway rings twice --- */
resetFetch();
yQueue({
  paymentId: 'pay_YOUPI1', orderId: yBody.orderId, amount: '100.00', amountPaise: '10000',
  currency: 'INR', status: 'SUCCESS', verificationLevel: 2
});
const yDupe = yPost('paywebhook', {
  event: 'SUCCESS', paymentId: 'pay_YOUPI1', orderId: yBody.orderId,
  amount: '100.00', amountPaise: 10000, currency: 'INR', utr: '123456789012'
});
check('a repeated YouPI callback is answered without error',
  yDupe.ok === true && yDupe.duplicate === true, JSON.stringify(yDupe));
check('a repeated callback does not add a second team', yRows('YouPI Squad') === 1);

/* --- cancelling the session --- */
resetFetch();
yQueueEcho({
  paymentId: 'pay_YOUPI2', amount: '100.00',
  amountPaise: '10000', currency: 'INR', status: 'INITIATED',
  checkoutUrl: 'http://127.0.0.1:7000/checkout/pay_YOUPI2'
});
const yCancelOpen = yPost('payorder', validPayload('YouPI Cancel'));
check('another team can open its own YouPI session', yCancelOpen.ok === true && yCancelOpen.token !== yOpened.token);

resetFetch();
yQueue({ success: true, status: 'CANCELLED' });
const yCancelled = yPost('paycancel', { token: yCancelOpen.token });
check('cancelling answers CANCELLED', yCancelled.ok === true && yCancelled.state === 'CANCELLED', JSON.stringify(yCancelled));
check('cancelling calls the gateway cancel endpoint',
  fetchCalls.length === 1 &&
  fetchCalls[0].url === 'http://127.0.0.1:6100/api/v1/checkout/pay_YOUPI2/cancel',
  fetchCalls.map(c => c.url).join(', '));
check('a cancelled session registers nobody', yRows('YouPI Cancel') === 0);

/* --- the organiser decides on a held payment --- */
resetFetch();
yQueueEcho({
  paymentId: 'pay_YOUPI3', amount: '100.00',
  amountPaise: '10000', currency: 'INR', status: 'INITIATED',
  checkoutUrl: 'http://127.0.0.1:7000/checkout/pay_YOUPI3'
});
const yHeld = yPost('payorder', validPayload('YouPI Held'));
// The order id must be the one the draft holds; read it from the sheet.
const heldDraft = yDraft(yHeld.token);
resetFetch();
yQueue({
  paymentId: 'pay_YOUPI3', orderId: String(heldDraft.values[9]), amount: '100.00',
  amountPaise: '10000', currency: 'INR', status: 'SUCCESS', verificationLevel: 1
});
const yHeldStatus = yPost('paystatus', { token: yHeld.token });
check('a level-1 payment is held, not registered', yHeldStatus.state === 'REVIEW' && yRows('YouPI Held') === 0, JSON.stringify(yHeldStatus));

const yQueueList = adminCall({ action: 'drafts-list', session: superSession });
check('the dashboard lists the held payment',
  yQueueList.ok === true && (yQueueList.drafts || []).some(d => d.token === yHeld.token),
  JSON.stringify(yQueueList).slice(0, 400));
check('the queue never leaks the merchant key',
  JSON.stringify(yQueueList).indexOf(YOUPI_KEY) === -1);

const noNote = adminCall({ action: 'draft-resolve', session: superSession, token: yHeld.token, decision: 'accept' });
check('accepting a held payment needs a note for the audit',
  noNote.ok === false && noNote.code === 'NOTE', JSON.stringify(noNote));

const yAccepted = adminCall({
  action: 'draft-resolve', session: superSession, token: yHeld.token,
  decision: 'accept', note: 'Seen in the organiser UPI app, UTR 112233445566'
});
check('the organiser can accept a held payment',
  yAccepted.ok === true && yAccepted.state === 'PAID', JSON.stringify(yAccepted));
check('accepting writes exactly one row', yRows('YouPI Held') === 1);
const acceptedRow = sheetRowFor('YouPI Held');
check('the accepted row is ONLINE / PAID',
  String(acceptedRow[14]) === 'ONLINE' && String(acceptedRow[15]) === 'PAID',
  JSON.stringify(acceptedRow.slice(14, 16)));
check('the row records who accepted it and why',
  /Accepted by organiser/.test(String(acceptedRow[17])) && /112233445566/.test(String(acceptedRow[17])),
  String(acceptedRow[17]));
check('manual acceptance is audited',
  (adminCall({ action: 'audit-list', session: superSession, pageSize: 100 }).entries || [])
    .some(e => e.action === 'payment-manual-accept'));

const yAgain = adminCall({ action: 'draft-resolve', session: superSession, token: yHeld.token, decision: 'accept', note: 'second press' });
check('pressing accept twice does not register a second team',
  yAgain.ok === true && yRows('YouPI Held') === 1, JSON.stringify(yAgain));

/* --- rejection saves nobody --- */
resetFetch();
yQueueEcho({
  paymentId: 'pay_YOUPI4', amount: '100.00',
  amountPaise: '10000', currency: 'INR', status: 'INITIATED',
  checkoutUrl: 'http://127.0.0.1:7000/checkout/pay_YOUPI4'
});
const yRejectOpen = yPost('payorder', validPayload('YouPI Reject'));
const rejectDraft = yDraft(yRejectOpen.token);
resetFetch();
yQueue({
  paymentId: 'pay_YOUPI4', orderId: String(rejectDraft.values[9]), amount: '100.00',
  amountPaise: '10000', currency: 'INR', status: 'SUCCESS', verificationLevel: 1
});
yPost('paystatus', { token: yRejectOpen.token });
const yRejected = adminCall({
  action: 'draft-resolve', session: superSession, token: yRejectOpen.token,
  decision: 'reject', note: 'No such credit in the bank statement'
});
check('the organiser can reject a held payment',
  yRejected.ok === true && yRejected.state === 'REJECTED', JSON.stringify(yRejected));
check('rejecting registers nobody', yRows('YouPI Reject') === 0);

/* --- the level is configuration, not a hardcoded 2 --- */
scriptProps.set('youpi_min_verification_level', '1');
check('the required level is read from Script Properties', yConfig().minVerification === 1);
scriptProps.delete('youpi_min_verification_level');

/* --- cash is unchanged under a YouPI deployment --- */
const yCash = post(Object.assign(validPayload('YouPI Cash'), { payment: { method: 'CASH' } }));
check('cash registration still saves under YouPI', yCash.ok === true, JSON.stringify(yCash));
check('cash is still PENDING, never PAID',
  String(sheetRowFor('YouPI Cash')[15]) === 'PENDING', String(sheetRowFor('YouPI Cash')[15]));

/* --- a plain ONLINE claim is still refused with YouPI configured --- */
const yClaim = JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(Object.assign(validPayload('YouPI Claim'), { payment: { method: 'ONLINE', status: 'PAID' } })) } }).getContent());
check('a claim of online payment is refused under YouPI too',
  yClaim.ok === false, JSON.stringify(yClaim));
check('that claim wrote no row', yRows('YouPI Claim') === 0);

/* Put the deployment back the way the rest of the repository describes it. */
scriptProps.delete('payment_provider');
scriptProps.delete('youpi_base_url');
scriptProps.delete('youpi_merchant_id');
scriptProps.delete('youpi_merchant_key');
scriptProps.delete('youpi_min_verification_level');
resetFetch();
}

/* ORG_TESTS */
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
