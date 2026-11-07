// Server-side tests for src/Code.js: runs it in a Node VM with fake Apps Script services and a
// fake Enable Banking (no network, nothing real is touched). Covers the daily run, multi-bank
// sync, expiry emails and the ?connect= flow.
// Usage: node tools/test/code.test.js   (exit code 1 on failure)
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(process.argv[2] || require("path").join(__dirname, "../../src/Code.js"), "utf8");

// A fake sheet: grid[0] is row 1. Supports what Code.js uses (getRange, setValues, clear, sort).
function fakeSheet(name, grid = []) {
  const sh = {
    grid, getName: () => name,
    getLastRow: () => grid.length,
    clear: () => { grid.length = 0; },
    getRange: (r0, c0, nr = 1, nc = 1) => ({
      getValues: () => grid.slice(r0 - 1, r0 - 1 + nr).map((r) => Array.from({ length: nc }, (_, j) => (r[c0 - 1 + j] ?? ''))),
      setValues: (v) => { v.forEach((row, i) => { grid[r0 - 1 + i] = grid[r0 - 1 + i] || []; row.forEach((x, j) => { grid[r0 - 1 + i][c0 - 1 + j] = x; }); }); },
      sort: () => {},
    }),
  };
  return sh;
}

function setup({ sessions = {}, failUids = [], failBalances = [], balances = {} } = {}) {
  const store = {}, mails = [], eb = [];
  const P = { getProperty: (k) => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = String(v); },
    setProperties: (o) => Object.assign(store, o), deleteProperty: (k) => { delete store[k]; } };
  P.setProperty('REDIRECT_URL', 'https://script.google.com/macros/s/X/exec');
  for (const [prop, s] of Object.entries(sessions)) P.setProperty(prop, JSON.stringify(s));
  const sheets = {
    Transactions: fakeSheet('Transactions', [['Key', 'Date', 'Amount', 'Currency', 'Merchant', 'Description', 'Category', 'Account', 'Loaded at']]),
    Rules: fakeSheet('Rules', [['Merchant contains', 'Category']]),
  };
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = fakeSheet(n)) };
  // Data rows of the Transactions tab (without the header), as before.
  const rows = new Proxy([], { get: (_, k) => { const d = sheets.Transactions.grid.slice(1); const v = d[k]; return typeof v === 'function' ? v.bind(d) : v; } });
  const ctx = {
    console: { log: () => {} },
    PropertiesService: { getScriptProperties: () => P },
    SpreadsheetApp: { getActive: () => ss },
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
    const bal = path.match(/^\/accounts\/(.+)\/balances$/);
    if (bal) {
      const uid = decodeURIComponent(bal[1]);
      if (failBalances.includes(uid)) throw new Error('balances unavailable');
      return { balances: balances[uid] || [] };
    }
    if (path === '/auth') return { url: 'https://auth.example/' + body.aspsp.name };
    if (path === '/sessions') return { session_id: 'S-new', accounts: [{ uid: 'amex-1', currency: 'EUR', name: 'Tamas Godanyi' }], access: { valid_until: '2027-05-01T00:00:00Z' } };
    throw new Error('unexpected ' + path);
  };
  ctx.fetchTransactions_ = (uid) => {
    if (failUids.includes(uid)) throw new Error('consent revoked');
    return [{ transaction_id: uid + '-t1', booking_date: '2026-11-06', status: 'BOOK', credit_debit_indicator: 'DBIT',
      transaction_amount: { amount: '10.00', currency: 'EUR' }, creditor: { name: 'Shop ' + uid }, remittance_information: [] }];
  };
  return { ctx, store, mails, rows, eb, sheets };
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
// 9. Balances: saved for every account during the sync; one failing account doesn't stop the
//    others or the sync. The dashboard picks the available balance and subtracts what Amex is owed.
const B = (type, amount) => ({ balance_type: type, balance_amount: { amount: String(amount), currency: 'EUR' }, reference_date: '2026-11-07' });
const joint = { session_id: 'R', accounts: [{ uid: 'rev-1', label: 'EUR Tamás Godányi …8462' }, { uid: 'rev-2', label: 'EUR KATIA OUTAYEB & TAMAS ARON GODANYI …3504' }], valid_until: future };
t = setup({ sessions: { SESSION: joint, SESSION_AMEX: amex(future) },
  balances: { 'rev-1': [B('CLBD', 1200), B('ITAV', 1180.5)], 'rev-2': [B('ITAV', 300)] }, failBalances: ['amex-1'] });
t.ctx.dailyRun();
const bal = t.sheets.Balances.grid;
assert.deepStrictEqual(bal[0].slice(0, 3), ['Account', 'Type', 'Amount']);
assert.deepStrictEqual(bal.slice(1).map((r) => [r[0].slice(0, 9), r[1], r[2]]),
  [['EUR Tamás', 'CLBD', 1200], ['EUR Tamás', 'ITAV', 1180.5], ['EUR KATIA', 'ITAV', 300], ['Amex EUR ', 'ERROR', '']]);
assert.strictEqual(t.rows.length, 3); // all three accounts' transactions still synced
// Amex: one €10 purchase synced above; add a refund (+4) and a non-EUR row that must be ignored.
t.sheets.Transactions.grid.push(['amex-1:r', '2026-11-07', 4, 'EUR', 'Shop', '', 'Shopping', 'Amex EUR Tamas Godanyi'],
  ['amex-1:h', '2026-11-07', -99, 'HUF', 'Shop', '', 'Shopping', 'Amex EUR Tamas Godanyi']);
const now = JSON.parse(JSON.stringify(t.ctx.getMoneyNow_()));
assert.strictEqual(now.revolut.type, 'ITAV'); assert.strictEqual(now.revolut.amount, 1180.5);
assert.strictEqual(now.joint.amount, 300);
assert.strictEqual(now.amex.owed, 6);           // 10 spent − 4 refunded
assert.strictEqual(now.freeToSpend, 1174.5);    // 1180.5 − 6
console.log('9 ok  balances saved (Amex error kept as a row), free to spend =', now.freeToSpend, 'from', now.revolut.type);

// 10. Without Amex connected: no Amex line, free to spend = Revolut balance; booked-only fallback.
t = setup({ sessions: { SESSION: rev }, balances: { 'rev-1': [B('CLBD', 950)] } });
t.ctx.dailyRun();
const now2 = JSON.parse(JSON.stringify(t.ctx.getMoneyNow_()));
assert.strictEqual(now2.amex, null); assert.strictEqual(now2.revolut.type, 'CLBD'); assert.strictEqual(now2.freeToSpend, 950);
console.log('10 ok no Amex: free to spend = booked balance', now2.freeToSpend);
console.log('ALL SERVER TESTS PASSED');
