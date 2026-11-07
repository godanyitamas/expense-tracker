/**
 * Revolut -> Google Sheets expense tracker (via Enable Banking)
 *
 * Script properties (Project Settings -> Script properties):
 *   EB_APP_ID       your Enable Banking application ID
 *   EB_PRIVATE_KEY  full contents of the .pem file
 *   REDIRECT_URL    your web app URL (added after the first deployment)
 *   EB_COUNTRY      optional, defaults to FR
 */

const EB_API = 'https://api.enablebanking.com';
const TX_SHEET = 'Transactions';
const RULES_SHEET = 'Rules';
const BUDGET_SHEET = 'Budgets';
const DASH_SHEET = 'Dashboard';
const TX_HEADERS = ['Key', 'Date', 'Amount', 'Currency', 'Merchant', 'Description', 'Category', 'Account', 'Loaded at'];
const COL = { key: 1, date: 2, amount: 3, currency: 4, merchant: 5, desc: 6, category: 7, account: 8 };
const UNCATEGORIZED = 'Uncategorized';
const MAIN_CURRENCY = 'EUR';
const FIRST_SYNC_DAYS = 730;
const OVERLAP_DAYS = 7;
const REMIND_DAYS = [7, 3, 1];

const STARTER_RULES = [
  ['carrefour', 'Groceries'], ['monoprix', 'Groceries'], ['franprix', 'Groceries'], ['lidl', 'Groceries'],
  ['auchan', 'Groceries'], ['picard', 'Groceries'], ['leclerc', 'Groceries'], ['intermarche', 'Groceries'],
  ['uber eats', 'Eating out'], ['deliveroo', 'Eating out'], ['mcdonald', 'Eating out'], ['starbucks', 'Eating out'],
  ['sncf', 'Transport'], ['ratp', 'Transport'], ['navigo', 'Transport'], ['uber', 'Transport'], ['bolt', 'Transport'],
  ['netflix', 'Subscriptions'], ['spotify', 'Subscriptions'], ['youtube', 'Subscriptions'], ['google', 'Subscriptions'],
  ['amazon', 'Shopping'], ['decathlon', 'Shopping'], ['ikea', 'Home'], ['leroy merlin', 'Home'],
  ['pharmacie', 'Health'], ['doctolib', 'Health'],
];

const props = () => PropertiesService.getScriptProperties();

/* ---------------- Setup ---------------- */

function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetLocale('en_GB'); // keeps formulas and dates predictable

  const tx = getOrCreate_(ss, TX_SHEET);
  if (tx.getLastRow() === 0) {
    tx.appendRow(TX_HEADERS);
    tx.setFrozenRows(1);
    tx.hideColumns(COL.key);
    tx.getRange('B:B').setNumberFormat('yyyy-mm-dd');
    tx.getRange('C:C').setNumberFormat('#,##0.00');
    tx.getRange('I:I').setNumberFormat('yyyy-mm-dd hh:mm');
  }

  const rules = getOrCreate_(ss, RULES_SHEET);
  if (rules.getLastRow() === 0) {
    rules.appendRow(['Merchant contains', 'Category']);
    rules.getRange(2, 1, STARTER_RULES.length, 2).setValues(STARTER_RULES);
    rules.setFrozenRows(1);
  }

  const budgets = getOrCreate_(ss, BUDGET_SHEET);
  if (budgets.getLastRow() === 0) {
    budgets.appendRow(['Category', 'Monthly budget', 'Spent this month', 'Remaining']);
    budgets.setFrozenRows(1);
    const cats = [...new Set(STARTER_RULES.map(r => r[1]))];
    budgets.getRange(2, 1, cats.length, 1).setValues(cats.map(c => [c]));
    for (let r = 2; r <= 40; r++) {
      budgets.getRange(r, 3).setFormula(
        `=IF(A${r}="","",-SUMIFS(Transactions!C:C,Transactions!G:G,A${r},Transactions!D:D,"${MAIN_CURRENCY}",` +
        `Transactions!C:C,"<0",Transactions!B:B,">="&Dashboard!$B$1,Transactions!B:B,"<="&EOMONTH(Dashboard!$B$1,0)))`);
      budgets.getRange(r, 4).setFormula(`=IF(OR(A${r}="",B${r}=""),"",B${r}-C${r})`);
    }
    budgets.getRange('B:D').setNumberFormat('#,##0');
  }

  buildDashboard_(ss);

  ss.getSheets().forEach(s => {
    if (![TX_SHEET, RULES_SHEET, BUDGET_SHEET, DASH_SHEET].includes(s.getName()) && s.getLastRow() === 0) {
      ss.deleteSheet(s);
    }
  });

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyRun')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyRun').timeBased().everyDays(1).atHour(6).create();

  testConnection();
}

function buildDashboard_(ss) {
  const d = getOrCreate_(ss, DASH_SHEET);
  d.clear();
  const cur = MAIN_CURRENCY;

  d.getRange('A1').setValue('Month');
  d.getRange('B1').setFormula('=DATE(YEAR(TODAY()),MONTH(TODAY()),1)').setNumberFormat('mmmm yyyy');
  d.getRange('A2').setValue('Total spent');
  d.getRange('B2').setFormula('=SUM(B4:B40)').setNumberFormat('#,##0');

  d.getRange('A3').setFormula(
    `=IFERROR(QUERY(Transactions!B:G,"select G, 0-sum(C) where C < 0 and D = '${cur}' and G <> 'Transfers' ` +
    `and B >= date '"&TEXT(B1,"yyyy-mm-dd")&"' and B <= date '"&TEXT(EOMONTH(B1,0),"yyyy-mm-dd")&"' ` +
    `group by G order by 0-sum(C) desc label G 'Category', 0-sum(C) 'Spent (${cur})'",1),"No data yet")`);
  for (let r = 4; r <= 40; r++) {
    d.getRange(r, 3).setFormula(
      `=IF(ISNUMBER(B${r}),SPARKLINE(B${r},{"charttype","bar";"max",MAX($B$4:$B$40);"color1","#5B8DEF"}),"")`);
  }

  d.getRange('E3').setFormula(
    `=IFERROR(QUERY(Transactions!B:G,"select year(B), month(B)+1, 0-sum(C) where C < 0 and D = '${cur}' and G <> 'Transfers' ` +
    `group by year(B), month(B)+1 order by year(B) desc, month(B)+1 desc limit 12 ` +
    `label year(B) 'Year', month(B)+1 'Month', 0-sum(C) 'Spent (${cur})'",1),"No data yet")`);
  for (let r = 4; r <= 15; r++) {
    d.getRange(r, 8).setFormula(
      `=IF(ISNUMBER(G${r}),SPARKLINE(G${r},{"charttype","bar";"max",MAX($G$4:$G$15);"color1","#E8845C"}),"")`);
  }

  d.getRange('B4:B40').setNumberFormat('#,##0');
  d.getRange('G4:G15').setNumberFormat('#,##0');
  d.setColumnWidth(1, 140);
  d.setColumnWidth(3, 120);
  d.setColumnWidth(8, 120);
  d.setFrozenRows(3);
  ss.setActiveSheet(d);
  ss.moveActiveSheet(1);
}

function testConnection() {
  const app = eb_('get', '/application');
  console.log(`Connected to Enable Banking app "${app.name}" (${app.environment || 'production'})`);
  console.log('Redirect URLs registered: ' + JSON.stringify(app.redirect_urls));
  listRevolut();
}

function listRevolut() {
  ['FR', 'LT', 'IE', 'HU'].forEach(country => {
    (eb_('get', '/aspsps', null, { country }).aspsps || [])
      .filter(a => /revolut/i.test(a.name))
      .forEach(a => console.log(`${a.country}  ${a.name}  psu_types=${a.psu_types}  ` +
        `max_consent=${Math.round((a.maximum_consent_validity || 0) / 86400)}d`));
  });
}

// Logs every bank/card provider Enable Banking offers whose name matches `pattern` (default:
// American Express), in every Enable Banking country, and writes them to the "Banks" tab.
// Read-only towards Enable Banking. Run it from the editor and check the log or the tab.
const EB_COUNTRIES = ['FR', 'GB', 'IE', 'DE', 'AT', 'BE', 'NL', 'LU', 'ES', 'PT', 'IT', 'MT', 'CY', 'GR',
  'SE', 'FI', 'DK', 'NO', 'IS', 'EE', 'LV', 'LT', 'PL', 'CZ', 'SK', 'HU', 'SI', 'HR', 'RO', 'BG', 'LI'];

function listBanks(pattern) {
  const re = pattern instanceof RegExp ? pattern
    : typeof pattern === 'string' && pattern ? new RegExp(pattern, 'i') : /american express|amex/i;
  let found = 0;
  const failed = [], rows = [];
  EB_COUNTRIES.forEach(country => {
    let list;
    try {
      list = eb_('get', '/aspsps', null, { country }).aspsps || [];
    } catch (err) {
      failed.push(`${country} (${err.message.slice(0, 80)})`);
      return;
    }
    list.filter(a => re.test(a.name || '')).forEach(a => {
      found++;
      const { logo, ...info } = a; // the logo is a long URL/data blob, not useful here
      rows.push([a.country, a.name, String(a.psu_types || ''), Math.round((a.maximum_consent_validity || 0) / 86400),
        !!a.beta, JSON.stringify(info)]);
      console.log(`${a.country}  ${a.name}  psu_types=${a.psu_types}  ` +
        `max_consent=${Math.round((a.maximum_consent_validity || 0) / 86400)}d  ` +
        `beta=${!!a.beta}\n${JSON.stringify(info)}`);
    });
  });
  const summary = `${found} match(es) for ${re} in ${EB_COUNTRIES.length - failed.length} countries.` +
    (failed.length ? ` Failed: ${failed.join(', ')}` : '');
  console.log(summary);
  const sh = getOrCreate_(SpreadsheetApp.getActive(), 'Banks');
  sh.clear();
  sh.getRange(1, 1, 2, 1).setValues([[`listBanks run at ${new Date().toISOString()}`], [summary]]);
  sh.getRange(3, 1, 1, 6).setValues([['Country', 'Name', 'PSU types', 'Max consent (days)', 'Beta', 'Details']]);
  if (rows.length) sh.getRange(4, 1, rows.length, 6).setValues(rows);
  return found;
}

// Writes the raw Enable Banking records of recent transactions to the "RawSample" tab, plus which
// fields have a value in any of them and how many carry a merchant category code (MCC).
function saveRawSample_(days, perAccount) {
  days = days || 14;
  perAccount = perAccount || 15;
  const session = getSession_();
  if (!session) throw new Error('Not connected.');
  const counts = {}, rows = [];
  let total = 0, withMcc = 0;
  for (const acc of session.accounts) {
    const txs = fetchTransactions_(acc.uid, addDays_(new Date(), -days));
    txs.forEach(t => {
      total++;
      if (t.merchant_category_code) withMcc++;
      Object.keys(t).forEach(k => {
        const v = t[k];
        if (v !== null && v !== '' && !(Array.isArray(v) && !v.length)) counts[k] = (counts[k] || 0) + 1;
      });
    });
    txs.slice(0, perAccount).forEach(t =>
      rows.push([acc.label, t.booking_date || t.value_date || '', JSON.stringify(t).slice(0, 45000)]));
  }
  const fields = Object.keys(counts).sort().map(k => `${k} (${counts[k]})`).join(', ');
  const sh = getOrCreate_(SpreadsheetApp.getActive(), 'RawSample');
  sh.clear();
  sh.getRange(1, 1, 4, 1).setValues([
    [`saveRawSample_ run at ${new Date().toISOString()}, last ${days} days, ${session.accounts.length} account(s)`],
    [`merchant_category_code present in ${withMcc} of ${total} transactions`],
    [`Fields with a value (number of transactions): ${fields}`],
    ['Account | Date | Raw transaction (JSON)'],
  ]);
  if (rows.length) sh.getRange(5, 1, rows.length, 3).setValues(rows);
  console.log(`RawSample: ${rows.length} rows, MCC in ${withMcc}/${total}`);
}

/* ---------------- Daily run ---------------- */

function dailyRun() {
  const session = getSession_();
  if (!session) {
    return notify_('Connect your Revolut', 'No bank connection yet. Open this link on your phone:\n' + connectUrl_());
  }
  const daysLeft = Math.ceil((new Date(session.valid_until) - new Date()) / 86400000);
  if (daysLeft <= 0) {
    return notify_('Revolut access expired', 'Tap to reconnect (takes a minute):\n' + connectUrl_());
  }
  syncTransactions();
  if (REMIND_DAYS.includes(daysLeft)) {
    notify_(`Revolut access expires in ${daysLeft} day(s)`, 'Tap to renew:\n' + connectUrl_());
  }
}

function syncTransactions() {
  const session = getSession_();
  if (!session) throw new Error('Not connected yet. Open the web app link to connect Revolut.');

  const sheet = SpreadsheetApp.getActive().getSheetByName(TX_SHEET);
  const last = sheet.getLastRow();
  const data = last > 1 ? sheet.getRange(2, 1, last - 1, TX_HEADERS.length).getValues() : [];
  const seen = new Set(data.map(r => r[0]));
  const rules = loadRules_();
  const now = new Date();
  const newRows = [];

  for (const acc of session.accounts) {
    const latest = data
      .filter(r => String(r[0]).startsWith(acc.uid + ':') && r[COL.date - 1] instanceof Date)
      .reduce((max, r) => (!max || r[COL.date - 1] > max ? r[COL.date - 1] : max), null);

    let txs;
    if (latest) {
      txs = fetchTransactions_(acc.uid, addDays_(latest, -OVERLAP_DAYS));
    } else {
      try {
        txs = fetchTransactions_(acc.uid, addDays_(now, -FIRST_SYNC_DAYS));
      } catch (err) {
        console.log('Long history refused, retrying with 89 days: ' + err.message);
        txs = fetchTransactions_(acc.uid, addDays_(now, -89));
      }
    }

    for (const t of txs) {
      if (t.status && t.status !== 'BOOK') continue; // skip pending, they come back once booked
      const row = toRow_(acc, t, now, rules);
      if (seen.has(row[0])) continue;
      seen.add(row[0]);
      newRows.push(row);
    }
  }

  if (newRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, TX_HEADERS.length).setValues(newRows);
    sheet.getRange(2, 1, sheet.getLastRow() - 1, TX_HEADERS.length).sort({ column: COL.date, ascending: false });
  }
  applyRules_();
  props().setProperty('LAST_SYNC', now.toISOString());
  console.log(`Added ${newRows.length} transactions`);
  return newRows.length;
}

function fetchTransactions_(uid, from) {
  const out = [];
  let ck = null;
  do {
    const query = { date_from: fmtDate_(from) };
    if (ck) query.continuation_key = ck;
    const r = eb_('get', `/accounts/${encodeURIComponent(uid)}/transactions`, null, query);
    out.push(...(r.transactions || []));
    ck = r.continuation_key;
  } while (ck);
  return out;
}

function toRow_(acc, t, now, rules) {
  const amt = t.transaction_amount || {};
  const debit = t.credit_debit_indicator === 'DBIT';
  const amount = Number(amt.amount || 0) * (debit ? -1 : 1);
  const party = (debit ? t.creditor : t.debtor) || {};
  const desc = (t.remittance_information || []).join(' ');
  const merchant = party.name || desc || '';
  const id = t.transaction_id || t.entry_reference ||
    Utilities.base64EncodeWebSafe(Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_1, [acc.uid, t.booking_date, amount, desc].join('|')));
  return [
    acc.uid + ':' + id,
    parseDate_(t.booking_date || t.value_date),
    amount,
    amt.currency || '',
    merchant,
    desc,
    categorize_(merchant, desc, amount, rules),
    acc.label,
    now,
  ];
}

/* ---------------- Categories ---------------- */

function loadRules_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(RULES_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues()
    .filter(r => r[0] && r[1])
    .map(r => [norm_(r[0]), String(r[1]).trim()])
    .filter(r => r[0]);
}

function categorize_(merchant, desc, amount, rules) {
  const text = ' ' + norm_(merchant + ' ' + desc) + ' ';
  const hit = rules.find(([match]) => text.includes(' ' + match)); // match must start at a word boundary
  if (hit) return hit[1];
  return amount > 0 ? 'Income' : UNCATEGORIZED;
}

// Lowercase, strip accents and punctuation, collapse spaces: "Uber   *eats" -> "uber eats".
function norm_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Re-runs the rules on EVERY row, overwriting existing categories (including manual edits).
// Use after changing rules in bulk.
function recategorizeAll() {
  applyRules_(true);
}

function applyRules_(force) {
  const sh = SpreadsheetApp.getActive().getSheetByName(TX_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  const rules = loadRules_();
  const range = sh.getRange(2, 1, sh.getLastRow() - 1, TX_HEADERS.length);
  const rows = range.getValues();
  let changed = false;
  const cats = rows.map(r => {
    const current = r[COL.category - 1];
    if (!force && current && current !== UNCATEGORIZED) return [current];
    const next = categorize_(r[COL.merchant - 1], r[COL.desc - 1], r[COL.amount - 1], rules);
    if (next !== current) changed = true;
    return [next];
  });
  if (changed) sh.getRange(2, COL.category, cats.length, 1).setValues(cats);
}

// Fixing an "Uncategorized" row creates a rule for that merchant. Editing Rules re-applies them.
function onEdit(e) {
  const sh = e.range.getSheet();
  if (sh.getName() === RULES_SHEET) return applyRules_();
  if (sh.getName() !== TX_SHEET || e.range.getColumn() !== COL.category ||
      e.range.getNumRows() !== 1 || e.range.getRow() < 2) return;

  const cat = String(e.value || '').trim();
  const old = String(e.oldValue || '').trim();
  if (!cat || cat === UNCATEGORIZED || (old && old !== UNCATEGORIZED)) return; // one-off overrides stay one-off
  const merchant = String(sh.getRange(e.range.getRow(), COL.merchant).getValue()).trim();
  if (!merchant) return;
  SpreadsheetApp.getActive().getSheetByName(RULES_SHEET).appendRow([merchant.toLowerCase(), cat]);
  applyRules_();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Expense tracker')
    .addItem('Sync now', 'syncTransactions')
    .addItem('Re-apply rules', 'applyRules_')
    .addToUi();
}

/* ---------------- Consent flow (web app) ---------------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.error) return page_('Authorization failed', esc_(p.error_description || p.error));
    if (p.code) {
      const session = finishAuth_(p.code, p.state);
      let result;
      try {
        result = `Imported ${syncTransactions()} new transactions.`;
      } catch (err) {
        result = 'Connected, but the first sync failed: ' + esc_(err.message);
      }
      return page_('Revolut connected',
        `${session.accounts.length} account(s), access valid until ` +
        `${esc_(fmtDate_(new Date(session.valid_until)))}.<br><br>${result}`);
    }
    if (!p.connect) return dashboardPage_();
    const url = startAuth_();
    return page_('Connect Revolut',
      `<a href="${esc_(url)}" target="_top" style="display:inline-block;padding:14px 22px;background:#191c1f;` +
      `color:#fff;border-radius:10px;text-decoration:none;font-size:18px">Connect Revolut</a>` +
      `<p style="color:#666">You'll approve read-only access in the Revolut app, then come back here.</p>`);
  } catch (err) {
    return page_('Something went wrong', esc_(err.message));
  }
}

/* ---------------- Home-screen dashboard (web app) ---------------- */

function connectUrl_() {
  return redirectUrl_() + '?connect=1';
}

function dashboardPage_() {
  const t = HtmlService.createTemplateFromFile('Dashboard');
  t.dataJson = JSON.stringify(getDashboardData_()).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle('My spending')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .addMetaTag('mobile-web-app-capable', 'yes');
}

// Reads the summary tables the sheet already computes on the hidden ChartData tab.
function getDashboardData_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName('ChartData');
  if (!sh) throw new Error('ChartData tab not found.');
  const tz = ss.getSpreadsheetTimeZone();
  const ym = v => (v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM') : String(v).slice(0, 7));
  const ymd = v => (v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v).slice(0, 10));
  const num = v => (typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, '')) || 0);
  const last = sh.getLastRow();

  const months = sh.getRange('A2:C13').getValues()
    .filter(r => r[0] !== '')
    .map(r => ({ month: ym(r[0]), total: num(r[2]) }));
  const cats = sh.getRange(2, 22, Math.max(1, last - 1), 3).getValues() // V:X
    .filter(r => r[0] !== '' && r[1] !== '')
    .map(r => ({ month: ym(r[0]), category: String(r[1]), amount: num(r[2]) }));
  const tx = sh.getRange(2, 27, Math.max(1, last - 1), 5).getValues() // AA:AE
    .filter(r => r[0] !== '' && r[1] !== '')
    .map(r => ({ date: ymd(r[1]), merchant: String(r[2]), category: String(r[3]), amount: num(r[4]) }));

  // Salary tab: A month (budget month), B salary in EUR, C source. Empty months are skipped.
  const salSh = ss.getSheetByName('Salary');
  const salary = salSh && salSh.getLastRow() > 1
    ? salSh.getRange(2, 1, salSh.getLastRow() - 1, 3).getValues()
      .filter(r => r[0] !== '' && num(r[1]) > 0)
      .map(r => ({ month: ym(r[0]), amount: num(r[1]), estimate: /estimate/i.test(String(r[2])) }))
    : [];

  const session = getSession_();
  let renewUrl = '';
  try { renewUrl = connectUrl_(); } catch (e) { /* REDIRECT_URL not set */ }
  return {
    months, cats, tx, salary,
    syncedAt: props().getProperty('LAST_SYNC') || '',
    validUntil: (session && session.valid_until) || '',
    renewUrl,
  };
}

function startAuth_() {
  const country = props().getProperty('EB_COUNTRY') || 'FR';
  const aspsp = (eb_('get', '/aspsps', null, { country }).aspsps || [])
    .find(a => /revolut/i.test(a.name) && (!a.psu_types || a.psu_types.includes('personal')));
  if (!aspsp) throw new Error(`Revolut not found for ${country}. Run listRevolut() and set EB_COUNTRY.`);

  const seconds = aspsp.maximum_consent_validity || 90 * 86400;
  const validUntil = new Date(Date.now() + (seconds - 600) * 1000).toISOString();
  const state = Utilities.getUuid();
  props().setProperties({ AUTH_STATE: state, AUTH_VALID_UNTIL: validUntil });

  return eb_('post', '/auth', {
    access: { valid_until: validUntil },
    aspsp: { name: aspsp.name, country: aspsp.country },
    state,
    redirect_url: redirectUrl_(),
    psu_type: 'personal',
  }).url;
}

function finishAuth_(code, state) {
  const expected = props().getProperty('AUTH_STATE');
  if (!expected || state !== expected) throw new Error('This link is stale. Open the web app again and restart.');
  const s = eb_('post', '/sessions', { code });
  const session = {
    session_id: s.session_id,
    accounts: (s.accounts || []).map(a => (typeof a === 'string'
      ? { uid: a, label: a.slice(0, 8) }
      : { uid: a.uid, label: accountLabel_(a) })),
    valid_until: (s.access && s.access.valid_until) || props().getProperty('AUTH_VALID_UNTIL'),
  };
  props().setProperty('SESSION', JSON.stringify(session));
  props().deleteProperty('AUTH_STATE');
  return session;
}

function accountLabel_(a) {
  const iban = (a.account_id && a.account_id.iban) || '';
  return [a.currency, a.name, iban ? '…' + iban.slice(-4) : ''].filter(Boolean).join(' ') || a.uid.slice(0, 8);
}

function getSession_() {
  const raw = props().getProperty('SESSION');
  return raw ? JSON.parse(raw) : null;
}

/* ---------------- Enable Banking API ---------------- */

function eb_(method, path, payload, query) {
  let url = EB_API + path;
  if (query) {
    url += '?' + Object.keys(query).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k])).join('&');
  }
  const opts = {
    method,
    headers: { Authorization: 'Bearer ' + jwt_() },
    contentType: 'application/json',
    muteHttpExceptions: true,
  };
  if (payload) opts.payload = JSON.stringify(payload);
  const res = UrlFetchApp.fetch(url, opts);
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 300) throw new Error(`${method.toUpperCase()} ${path} -> ${code}: ${text}`);
  return JSON.parse(text);
}

function jwt_() {
  const appId = props().getProperty('EB_APP_ID');
  const rawKey = props().getProperty('EB_PRIVATE_KEY');
  if (!appId || !rawKey) throw new Error('Set EB_APP_ID and EB_PRIVATE_KEY in Script properties.');
  const now = Math.floor(Date.now() / 1000);
  const enc = o => Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, '');
  const input = enc({ typ: 'JWT', alg: 'RS256', kid: appId }) + '.' +
    enc({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 });
  const sig = Utilities.computeRsaSha256Signature(input, normalizePem_(rawKey));
  return input + '.' + Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '');
}

// Script properties often lose line breaks when you paste; rebuild a valid PEM.
function normalizePem_(raw) {
  const s = String(raw).trim();
  const m = s.match(/-+\s*BEGIN\s+([A-Z ]+?)\s*-+([\s\S]*?)-+\s*END/);
  let type = 'PRIVATE KEY';
  let body;
  if (m) {
    type = m[1].trim();
    body = m[2];
  } else if (/^[A-Za-z0-9+\/=\s]+$/.test(s) && s.replace(/\s/g, '').length > 500) {
    body = s; // only the base64 part was pasted
  } else {
    throw new Error(`EB_PRIVATE_KEY doesn't look like a key: it starts with "${s.slice(0, 12)}" ` +
      `and is ${s.length} characters long (a key is usually 1,600-1,800).`);
  }
  if (type !== 'PRIVATE KEY') {
    throw new Error(`Key type is "${type}", but Apps Script needs a "PRIVATE KEY" (PKCS#8) key.`);
  }
  body = body.replace(/[^A-Za-z0-9+\/=]/g, '').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

/* ---------------- Helpers ---------------- */

function redirectUrl_() {
  const url = props().getProperty('REDIRECT_URL');
  if (!url) throw new Error('Set REDIRECT_URL in Script properties (your web app URL).');
  return url;
}

function notify_(subject, body) {
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '[Expense tracker] ' + subject, body);
}

function page_(title, html) {
  return HtmlService.createHtmlOutput(
    `<div style="font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px;line-height:1.5">` +
    `<h2>${esc_(title)}</h2><div>${html}</div></div>`)
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getOrCreate_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function parseDate_(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function addDays_(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function esc_(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}