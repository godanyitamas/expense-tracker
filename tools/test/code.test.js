// Server-side tests for src/Code.js: runs it in a Node VM with fake Apps Script services and a
// fake Enable Banking (no network, nothing real is touched). Covers the daily run, multi-bank
// sync, expiry emails and the ?connect= flow.
// Usage: node tools/test/code.test.js   (exit code 1 on failure)
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(process.argv[2] || require("path").join(__dirname, "../../src/Code.js"), "utf8");

function setup({ sessions = {}, failUids = [] } = {}) {
  const store = {}, mails = [], rows = [], eb = [];
  const P = { getProperty: (k) => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = String(v); },
    setProperties: (o) => Object.assign(store, o), deleteProperty: (k) => { delete store[k]; } };
  P.setProperty('REDIRECT_URL', 'https://script.google.com/macros/s/X/exec');
  for (const [prop, s] of Object.entries(sessions)) P.setProperty(prop, JSON.stringify(s));
  const range = (r0, c0, nr, nc) => ({
    getValues: () => rows.slice(r0 - 2, r0 - 2 + nr).map((r) => r.slice(c0 - 1, c0 - 1 + nc)),
    setValues: (v) => { v.forEach((row, i) => { rows[r0 - 2 + i] = rows[r0 - 2 + i] || []; row.forEach((x, j) => { rows[r0 - 2 + i][c0 - 1 + j] = x; }); }); },
    sort: () => {},
  });
  const txSheet = { getLastRow: () => rows.length + 1, getRange: range, getName: () => 'Transactions' };
  const rules = { getLastRow: () => 1, getRange: () => ({ getValues: () => [] }) };
  const ctx = {
    console: { log: () => {} },
    PropertiesService: { getScriptProperties: () => P },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: (n) => (n === 'Transactions' ? txSheet : n === 'Rules' ? rules : null) }) },
    MailApp: { sendEmail: (...a) => mails.push(a) }, GmailApp: { sendEmail: (...a) => mails.push(a) },
    Session: { getScriptTimeZone: () => 'Europe/Paris', getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }), getActiveUser: () => ({ getEmail: () => 'me@example.com' }) },
    Utilities: { getUuid: () => 'uuid-1', formatDate: (d) => d.toISOString().slice(0, 10), base64EncodeWebSafe: (x) => 'h', computeDigest: () => [], DigestAlgorithm: {} },
    HtmlService: { createHtmlOutput: (h) => ({ html: h, setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; } }), XFrameOptionsMode: {} },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  // Fake Enable Banking.
  ctx.eb_ = (method, path, body, query) => {
    eb.push([method, path, body, query]);
    if (path === '/aspsps') return { aspsps: [{ name: 'Revolut', country: 'FR', psu_types: ['personal'], maximum_consent_validity: 15552000 },
      { name: 'American Express', country: 'FR', psu_types: ['business', 'personal'], maximum_consent_validity: 15552000 }] };
    if (path === '/auth') return { url: 'https://auth.example/' + body.aspsp.name };
    if (path === '/sessions') return { session_id: 'S-new', accounts: [{ uid: 'amex-1', currency: 'EUR', name: 'Tamas Godanyi' }], access: { valid_until: '2027-05-01T00:00:00Z' } };
    throw new Error('unexpected ' + path);
  };
  ctx.fetchTransactions_ = (uid) => {
    if (failUids.includes(uid)) throw new Error('consent revoked');
    return [{ transaction_id: uid + '-t1', booking_date: '2026-11-06', status: 'BOOK', credit_debit_indicator: 'DBIT',
      transaction_amount: { amount: '10.00', currency: 'EUR' }, creditor: { name: 'Shop ' + uid }, remittance_information: [] }];
  };
  return { ctx, store, mails, rows, eb };
}
const future = '2027-04-30T00:00:00Z', past = '2026-11-01T00:00:00Z';
const rev = { session_id: 'R', accounts: [{ uid: 'rev-1', label: 'EUR Tamás Godányi …8462' }], valid_until: future };
const amex = (vu) => ({ session_id: 'A', accounts: [{ uid: 'amex-1', label: 'Amex EUR Tamas Godanyi' }], valid_until: vu });
let t;

// 1. Only Revolut connected: same behaviour as before.
t = setup({ sessions: { SESSION: rev } });
t.ctx.dailyRun();
assert.deepStrictEqual(t.rows.map((r) => r[0]), ['rev-1:rev-1-t1']); assert.strictEqual(t.mails.length, 0);
console.log('1 ok  Revolut only: synced, no emails');

// 2. Both connected: both synced, labels kept.
t = setup({ sessions: { SESSION: rev, SESSION_AMEX: amex(future) } });
t.ctx.dailyRun();
assert.deepStrictEqual(t.rows.map((r) => r[7]).sort(), ['Amex EUR Tamas Godanyi', 'EUR Tamás Godányi …8462']);
console.log('2 ok  both banks synced:', t.rows.map((r) => r[7]).join(' | '));

// 3. Amex expired: Revolut still syncs, one "Amex access expired" email with the amex link.
t = setup({ sessions: { SESSION: rev, SESSION_AMEX: amex(past) } });
t.ctx.dailyRun();
assert.deepStrictEqual(t.rows.map((r) => r[0]), ['rev-1:rev-1-t1']);
assert.strictEqual(t.mails.length, 1); assert.match(JSON.stringify(t.mails[0]), /Amex access expired.*connect=amex/);
console.log('3 ok  Amex expired: Revolut synced, email:', JSON.stringify(t.mails[0]).slice(0, 110));

// 4. Amex fails mid-consent: Revolut rows are still saved, then the error is reported.
t = setup({ sessions: { SESSION: rev, SESSION_AMEX: amex(future) }, failUids: ['amex-1'] });
assert.throws(() => t.ctx.dailyRun(), /sync failed for Amex EUR Tamas Godanyi: consent revoked/);
assert.deepStrictEqual(t.rows.map((r) => r[0]), ['rev-1:rev-1-t1']);
console.log('4 ok  Amex failing: Revolut saved, error raised after');

// 5. Revolut expiry reminder still says Revolut with ?connect=1.
t = setup({ sessions: { SESSION: { ...rev, valid_until: new Date(Date.now() + 2.5 * 86400000).toISOString() } } });
t.ctx.dailyRun();
assert.match(JSON.stringify(t.mails[0]), /Revolut access expires in 3 day\(s\).*connect=1/);
console.log('5 ok  Revolut reminder:', JSON.stringify(t.mails[0]).slice(0, 100));

// 6. Connect flow: ?connect=amex picks American Express; the callback stores SESSION_AMEX, Revolut untouched.
t = setup({ sessions: { SESSION: rev } });
const page = t.ctx.doGet({ parameter: { connect: 'amex' } });
assert.match(page.html, /Connect Amex/); assert.match(page.html, /auth\.example\/American Express/);
assert.strictEqual(t.store.AUTH_BANK, 'amex');
const done = t.ctx.doGet({ parameter: { code: 'c', state: 'uuid-1' } });
assert.match(done.html, /Amex connected/);
assert.strictEqual(JSON.parse(t.store.SESSION).session_id, 'R');
assert.strictEqual(JSON.parse(t.store.SESSION_AMEX).accounts[0].label.slice(0, 5), 'Amex ');
assert.ok(!('AUTH_BANK' in t.store));
assert.deepStrictEqual(t.rows.map((r) => r[0]).sort(), ['amex-1:amex-1-t1', 'rev-1:rev-1-t1']);
console.log('6 ok  ?connect=amex -> Amex consent, SESSION kept, SESSION_AMEX =', JSON.parse(t.store.SESSION_AMEX).accounts[0].label);

// 7. ?connect=1 still means Revolut; unknown bank is refused.
t = setup({ sessions: { SESSION: rev } });
assert.match(t.ctx.doGet({ parameter: { connect: '1' } }).html, /Connect Revolut.*auth\.example\/Revolut/s);
assert.match(t.ctx.doGet({ parameter: { connect: 'nope' } }).html, /Unknown bank/);
console.log('7 ok  ?connect=1 -> Revolut, unknown bank refused');

// 8. Dashboard data lists both connections.
t = setup({ sessions: { SESSION: rev, SESSION_AMEX: amex(future) } });
const conns = vm.runInContext(`BANK_IDS.filter(b => getSession_(b)).map(b => [BANKS[b].name, connectUrl_(b)])`, t.ctx);
assert.deepStrictEqual(JSON.parse(JSON.stringify(conns)), [['Revolut', 'https://script.google.com/macros/s/X/exec?connect=1'], ['Amex', 'https://script.google.com/macros/s/X/exec?connect=amex']]);
console.log('8 ok  connections:', JSON.stringify(conns));
console.log('ALL SERVER TESTS PASSED');
