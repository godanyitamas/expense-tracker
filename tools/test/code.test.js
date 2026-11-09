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
      getValue: () => (grid[r0 - 1] || [])[c0 - 1] ?? '',
      getValues: () => grid.slice(r0 - 1, r0 - 1 + nr).map((r) => Array.from({ length: nc }, (_, j) => (r[c0 - 1 + j] ?? ''))),
      setValues: (v) => { v.forEach((row, i) => { grid[r0 - 1 + i] = grid[r0 - 1 + i] || []; row.forEach((x, j) => { grid[r0 - 1 + i][c0 - 1 + j] = x; }); }); },
      sort: () => {},
    }),
  };
  return sh;
}

function setup({ sessions = {}, failUids = [], failBalances = [], balances = {}, pending = {}, claude = null } = {}) {
  const store = {}, mails = [], eb = [], claudeCalls = [];
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
    UrlFetchApp: { fetch: (url, opt) => {
      if (!claude) throw new Error('unexpected fetch ' + url);
      const req = JSON.parse(opt.payload); claudeCalls.push({ url, headers: opt.headers, req });
      const [code, body] = claude(req);
      return { getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    } },
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
    if (path === '/sessions/A-empty') return { status: 'AUTHORIZED', accounts: ['amex-9'] };
    if (path === '/accounts/amex-9/details') return { currency: 'EUR', name: 'Tamas Godanyi' };
    if (path === '/auth') return { url: 'https://auth.example/' + body.aspsp.name };
    if (path === '/sessions') return { session_id: 'S-new', accounts: [{ uid: 'amex-1', currency: 'EUR', name: 'Tamas Godanyi' }], access: { valid_until: '2027-05-01T00:00:00Z' } };
    throw new Error('unexpected ' + path);
  };
  ctx.fetchTransactions_ = (uid) => {
    if (failUids.includes(uid)) throw new Error('consent revoked');
    return (pending[uid] || []).map((amount, i) => ({ transaction_id: `${uid}-p${i}`, booking_date: '2026-11-07', status: 'PDNG',
      credit_debit_indicator: amount < 0 ? 'DBIT' : 'CRDT', transaction_amount: { amount: String(Math.abs(amount)), currency: 'EUR' },
      creditor: { name: 'Pending shop' }, remittance_information: [] })).concat([{ transaction_id: uid + '-t1', booking_date: '2026-11-06', status: 'BOOK', credit_debit_indicator: 'DBIT',
      transaction_amount: { amount: '10.00', currency: 'EUR' }, creditor: { name: 'Shop ' + uid }, remittance_information: [] }]);
  };
  return { ctx, store, mails, rows, eb, sheets, claudeCalls };
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
  [['EUR Tamás', 'CLBD', 1200], ['EUR Tamás', 'ITAV', 1180.5], ['EUR KATIA', 'ITAV', 300], ['Amex EUR ', 'ERROR', ''],
   ['Status: R', 'STATUS', 2], ['Status: A', 'STATUS', 1]]);
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
// 11. Amex consent stored with no accounts (as seen live on 7 Nov 2026): the sync asks Enable
//     Banking again, saves the account with a proper label, and syncs it the same run.
t = setup({ sessions: { SESSION: rev, SESSION_AMEX: { session_id: 'A-empty', accounts: [], valid_until: future } } });
t.ctx.dailyRun();
const fixed = JSON.parse(t.store.SESSION_AMEX);
assert.deepStrictEqual(fixed.accounts, [{ uid: 'amex-9', label: 'Amex EUR Tamas Godanyi' }]);
assert.strictEqual(fixed.status, 'AUTHORIZED');
assert.ok(t.rows.some((r) => r[0] === 'amex-9:amex-9-t1'));
const st = t.sheets.Balances.grid.find((r) => r[0] === 'Status: Amex');
assert.strictEqual(st[2], 1); assert.match(st[6], /"eb_status":"AUTHORIZED"/);
console.log('11 ok empty Amex consent refreshed:', fixed.accounts[0].label, '| status row:', st[6]);
// 12. Pending: saved to the Pending tab, never to Transactions; pending Amex purchases count in
//     "Amex to pay" (booked + pending), Revolut pending ones don't (its available balance has them).
t = setup({ sessions: { SESSION: rev, SESSION_AMEX: amex(future) }, balances: { 'rev-1': [B('ITAV', 500)] },
  pending: { 'amex-1': [-42.5, -7.5], 'rev-1': [-3] } });
t.ctx.dailyRun();
assert.deepStrictEqual(t.rows.map((r) => r[0]).sort(), ['amex-1:amex-1-t1', 'rev-1:rev-1-t1']); // booked only
const pend = t.sheets.Pending.grid;
assert.deepStrictEqual(pend.slice(1).map((r) => [r[1], r[6]]).sort((a, b) => a[0] - b[0]),
  [[-42.5, 'Amex EUR Tamas Godanyi'], [-7.5, 'Amex EUR Tamas Godanyi'], [-3, 'EUR Tamás Godányi …8462']]);
const now3 = JSON.parse(JSON.stringify(t.ctx.getMoneyNow_()));
assert.deepStrictEqual(now3.amex, { owed: 60, booked: 10, pending: 50 });
assert.strictEqual(now3.freeToSpend, 440);
console.log('12 ok pending kept apart; Amex to pay =', now3.amex.owed, '(booked', now3.amex.booked, '+ pending', now3.amex.pending + '), free =', now3.freeToSpend);
// The next sync after booking: pending list is rebuilt from the bank, so nothing is counted twice.
t.ctx.fetchTransactions_ = (uid) => [{ transaction_id: uid + '-t1', booking_date: '2026-11-06', status: 'BOOK', credit_debit_indicator: 'DBIT',
  transaction_amount: { amount: '10.00', currency: 'EUR' }, creditor: { name: 'Shop' }, remittance_information: [] }];
t.ctx.syncTransactions();
assert.strictEqual(t.sheets.Pending.grid.length, 1);
console.log('   ok next sync without pending: Pending tab emptied');

// 13-16. Claude categorizing. Fake Claude API: answers per merchant from a table.
const recent = new Date(Date.now() - 3 * 86400000), old = new Date(Date.now() - 200 * 86400000);
const TX = (k, d, amt, m, desc, cat) => [k, d, amt, 'EUR', m, desc, cat, 'EUR Tamás Godányi …8462', d];
function claudeSetup(answers, opts = {}) {
  const t = setup({ ...opts, claude: (req) => {
    const items = JSON.parse(req.messages[0].content.split('Merchants to categorize (JSON):\n')[1]);
    if (opts.fail) return [529, { type: 'error', error: { type: 'overloaded_error' } }];
    const results = items.map((i) => ({ id: i.id, ...(answers[i.merchant] || { category: 'Uncategorized', match: '' }) }));
    return [200, { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ results }) }] }];
  } });
  t.sheets.Rules.grid.push(['ab bifenzi', 'Groceries'], ['zara', 'Shopping'], ['salaire', 'Salary']);
  t.sheets.Transactions.grid.push(
    TX('k1', recent, -437.9, 'DF64 COFFEE GRINDER', 'SP DF64 COFFEE GRINDER  SINGAPORE', 'Uncategorized'),
    TX('k2', recent, -54.34, 'Telekomszaml*023133445', 'Telekomszaml*023133445', 'Uncategorized'),
    TX('k3', recent, -60.04, 'Telekomszaml*023133445', 'Telekomszaml*023133445', 'Uncategorized'), // same merchant: asked once
    TX('k4', recent, -20, 'Sajeer Mohamed', 'To Sajeer M', 'Uncategorized'),                        // a person: stays
    TX('k5', recent, 15, 'Someone', 'Refund', 'Uncategorized'),                                       // credit: never sent (rules make it Income)
    TX('k6', old, -7.6, 'Aux Delices Du Chate', 'Aux Delices Du Chat', 'Uncategorized'),             // older than 30 days
    TX('k7', recent, -9.61, 'Ab.bifenzi', 'Ab.bifenzi', 'Groceries'));
  return t;
}
const ANSWERS = { 'DF64 COFFEE GRINDER': { category: 'Shopping', match: 'df64' },
  'Telekomszaml*023133445': { category: 'Groceries', match: 'telekomszaml' },
  'Aux Delices Du Chate': { category: 'Groceries', match: 'aux delices du chat' } };
const cat = (t, k) => t.rows.find((r) => r[0] === k)[6];

// 13. No API key: nothing is sent, the sync works as before.
t = claudeSetup(ANSWERS, { sessions: { SESSION: rev } });
t.ctx.dailyRun();
assert.strictEqual(t.claudeCalls.length, 0); assert.strictEqual(cat(t, 'k1'), 'Uncategorized');
console.log('13 ok no ANTHROPIC_API_KEY: Claude not called');

// 14. With a key: the daily sync sends recent Uncategorized debits once per merchant, saves the
//     answers as rules marked "claude", and leaves people / unknowns Uncategorized (remembered).
t = claudeSetup(ANSWERS, { sessions: { SESSION: rev } });
t.store.ANTHROPIC_API_KEY = 'sk-test';
t.ctx.dailyRun();
assert.strictEqual(t.claudeCalls.length, 1);
const call = t.claudeCalls[0];
assert.strictEqual(call.url, 'https://api.anthropic.com/v1/messages'); assert.strictEqual(call.headers['x-api-key'], 'sk-test');
assert.strictEqual(call.req.model, 'claude-opus-5-5'); assert.strictEqual(call.req.output_config.format.type, 'json_schema');
const sent = JSON.parse(call.req.messages[0].content.split('Merchants to categorize (JSON):\n')[1]).map((i) => i.merchant);
assert.deepStrictEqual(sent.sort(), ['DF64 COFFEE GRINDER', 'Sajeer Mohamed', 'Shop rev-1', 'Telekomszaml*023133445']);
const enumCats = call.req.output_config.format.schema.properties.results.items.properties.category.enum;
assert.ok(enumCats.includes('Shopping') && enumCats.includes('Uncategorized') && !enumCats.includes('Salary'));
assert.strictEqual(cat(t, 'k1'), 'Shopping'); assert.strictEqual(cat(t, 'k2'), 'Groceries'); assert.strictEqual(cat(t, 'k3'), 'Groceries');
assert.strictEqual(cat(t, 'k4'), 'Uncategorized'); assert.strictEqual(cat(t, 'k5'), 'Income'); assert.strictEqual(cat(t, 'k6'), 'Uncategorized');
const added = t.sheets.Rules.grid.filter((r) => /^claude/.test(r[2] || ''));
assert.deepStrictEqual(added.map((r) => [r[0], r[1]]), [['df64', 'Shopping'], ['telekomszaml', 'Groceries']]);
assert.strictEqual(t.sheets.Rules.grid[0][2], 'Added by');
assert.deepStrictEqual(JSON.parse(t.store.CLAUDE_SKIPPED).sort(), ['sajeer mohamed', 'shop rev 1']);
// Next sync: nothing new to ask (people and unknowns are remembered).
t.ctx.syncTransactions();
assert.strictEqual(t.claudeCalls.length, 1);
console.log('14 ok daily: 4 merchants asked once, rules added:', added.map((r) => r[0] + '→' + r[1]).join(', '), '| skipped remembered');

// 15. Fixing a Claude-categorized row by hand updates the rule and the other rows it categorized.
const tx = t.sheets.Transactions, rowOf = (k) => tx.grid.findIndex((r) => r[0] === k) + 1;
tx.grid[rowOf('k2') - 1][6] = 'Phone & internet';
t.ctx.onEdit({ range: { getSheet: () => tx, getColumn: () => 7, getNumRows: () => 1, getRow: () => rowOf('k2') }, value: 'Phone & internet', oldValue: 'Groceries' });
const fixedRule = t.sheets.Rules.grid.find((r) => r[0] === 'telekomszaml');
assert.strictEqual(fixedRule[1], 'Phone & internet'); assert.match(fixedRule[2], /fixed by hand/);
assert.strictEqual(cat(t, 'k3'), 'Phone & internet'); assert.strictEqual(cat(t, 'k7'), 'Groceries');
// A manual change on a row categorized by a normal rule stays a one-off.
tx.grid[rowOf('k7') - 1][6] = 'Eating out';
t.ctx.onEdit({ range: { getSheet: () => tx, getColumn: () => 7, getNumRows: () => 1, getRow: () => rowOf('k7') }, value: 'Eating out', oldValue: 'Groceries' });
assert.deepStrictEqual(t.sheets.Rules.grid.find((r) => r[0] === 'ab bifenzi'), ['ab bifenzi', 'Groceries']);
console.log('15 ok hand fix of a Claude rule: rule now', fixedRule[1], '; normal rules untouched');

// 16. "Categorize all" also takes old rows; an API failure doesn't break the daily sync.
t.ctx.categorizeWithClaude();
assert.strictEqual(cat(t, 'k6'), 'Groceries');
t = claudeSetup(ANSWERS, { sessions: { SESSION: rev }, fail: true });
t.store.ANTHROPIC_API_KEY = 'sk-test';
t.ctx.dailyRun();
assert.strictEqual(t.claudeCalls.length, 1); assert.strictEqual(cat(t, 'k1'), 'Uncategorized');
assert.ok(t.rows.some((r) => r[0] === 'rev-1:rev-1-t1'));
console.log('16 ok backlog run categorizes old rows; Claude API error: sync still completes');
console.log('ALL SERVER TESTS PASSED');
