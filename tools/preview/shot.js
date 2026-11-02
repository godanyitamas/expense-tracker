// Screenshots of the dashboard preview, several states side by side in one PNG.
// Usage: node tools/preview/shot.js <preview.html> <out.png> [state ...]
//   state = <width>[:dark][:m<chip index>][:c<category row>][:y<scrollY>]
//   e.g.  390:m0  390:dark:m3:c0:y900  1200:m1
//   chip index 0 = newest month; c<n> opens the n-th row of "By category".
const { chromium } = require('playwright');
const path = require('path');

const [file, out, ...states] = process.argv.slice(2);
if (!file || !out) { console.error('Usage: node shot.js <preview.html> <out.png> [state ...]'); process.exit(2); }

(async () => {
  const browser = await chromium.launch();
  const shots = [];
  for (const st of states.length ? states : ['390:m0', '390:dark:m0']) {
    const parts = st.split(':');
    const width = Number(parts[0]);
    const opt = (k) => { const x = parts.find((q) => q[0] === k && /^\d+$/.test(q.slice(1))); return x ? Number(x.slice(1)) : null; };
    const p = await browser.newPage({ viewport: { width, height: width < 600 ? 1000 : 900 }, deviceScaleFactor: 2,
      colorScheme: parts.includes('dark') ? 'dark' : 'light' });
    await p.goto('file://' + path.resolve(file));
    if (opt('m') != null) await p.locator('#chips .chip').nth(opt('m')).click();
    if (opt('c') != null) await p.locator('#cats g').nth(opt('c')).click({ force: true });
    await p.waitForTimeout(900);
    if (opt('y') != null) { await p.evaluate((y) => scrollTo(0, y), opt('y')); await p.waitForTimeout(200); }
    shots.push({ w: width, b64: (await p.screenshot()).toString('base64') });
    await p.close();
  }
  const W = shots.reduce((s, x) => s + x.w + 20, 0);
  const page = await browser.newPage({ viewport: { width: W, height: 1000 }, deviceScaleFactor: 2 });
  await page.setContent('<body style="margin:0;display:flex;gap:20px;align-items:flex-start;background:#888">' +
    shots.map((s) => `<img style="width:${s.w}px" src="data:image/png;base64,${s.b64}">`).join('') + '</body>');
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log(out);
})();
