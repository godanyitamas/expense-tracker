// Builds a standalone preview of src/Dashboard.html with deterministic mock data in place of the
// <?!= dataJson ?> scriptlet (same shape as getDashboardData_ in Code.js).
// Usage: node tools/preview/build.js [out.html]   (default: /tmp/dashboard-preview.html)
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '../../src/Dashboard.html');
const out = path.resolve(process.argv[2] || '/tmp/dashboard-preview.html');

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// Varied on purpose: a long category name, categories missing in some months, a spike month,
// months over and under salary, estimated salary months, no salary in the oldest month (with no average either, so the
// summary line wraps differently), and the current month "so far".
const CATS = ['Groceries', 'Eating out', 'Transport', 'Shared household & utilities', 'Shopping',
  'Subscriptions', 'Health', 'Entertainment', 'Uncategorized'];
const now = new Date();
const months = [], cats = [], tx = [], salary = [];
for (let i = 11; i >= 0; i--) {
  const m = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1)).toISOString().slice(0, 7);
  let total = 0;
  CATS.forEach((c, j) => {
    if (i === 11) return; // first month empty, like a fresh sync
    const amount = j > 3 && rnd() < 0.35 ? 0
      : Math.round((400 / (j + 1)) * (0.6 + rnd()) * (j === 4 && i % 3 === 0 ? 3 : 1) * 100) / 100;
    if (!amount) return;
    total += amount;
    cats.push({ month: m, category: c, amount });
    for (let k = 0; k < 4; k++) {
      tx.push({ date: `${m}-${String(1 + Math.floor(rnd() * 27)).padStart(2, '0')}`,
        merchant: `${c} shop ${k}`, category: c, amount: Math.round((amount / 4) * 100) / 100 });
    }
  });
  months.push({ month: m, total: Math.round(total * 100) / 100 });
  if (i < 10) salary.push({ month: m, amount: i === 0 ? 2500 : 1400 + Math.round(rnd() * 300), estimate: i >= 8 });
}

const data = {
  months, cats, tx, salary,
  syncedAt: now.toISOString(),
  validUntil: new Date(now.getTime() + 150 * 86400000).toISOString(),
  renewUrl: '',
};
const html = fs.readFileSync(src, 'utf8');
if (!html.includes('<?!= dataJson ?>')) throw new Error('Scriptlet <?!= dataJson ?> not found in Dashboard.html');
fs.writeFileSync(out, html.replace('<?!= dataJson ?>', JSON.stringify(data).replace(/</g, '\\u003c')));
console.log(out);
