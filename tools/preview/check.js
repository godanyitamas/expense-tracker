// Stability checks for the dashboard preview, at phone (390px) and desktop (1200px) width:
//  1. Switching months (with and without a category open) never moves any block.
//  2. Tapping things never moves what was tapped (except the smooth reveal of the detail card).
//  3. No JavaScript errors.
// Usage: node tools/preview/check.js [preview.html]   Exit code 1 on any failure.
const { chromium } = require('playwright');
const path = require('path');

const file = 'file://' + path.resolve(process.argv[2] || '/tmp/dashboard-preview.html');
const BLOCKS = ['#now', '#take', '#k1', '#k1-note', '#k2', '#k3', '#k3-note', '#k4', '#k4-note', '#bars-card', '#cats-card', '#heat-card', '#detail'];
const TAP_TOLERANCE = 3; // px; the smooth reveal scroll can start within the same frame
let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };

(async () => {
  const browser = await chromium.launch();
  for (const vp of [{ width: 390, height: 800 }, { width: 1200, height: 900 }]) {
    console.log(`== ${vp.width}x${vp.height}`);
    const p = await browser.newPage({ viewport: vp });
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(file);
    const settle = (ms = 900) => p.waitForTimeout(ms);

    // 1. Month switching
    const seen = {};
    const chips = await p.locator('#chips .chip').count();
    for (const withCat of [false, true]) {
      if (withCat) await p.locator('#cats g').first().click({ force: true });
      for (let i = 0; i < chips; i++) {
        await p.locator('#chips .chip').nth(i).click();
        await settle(50);
        const tops = await p.evaluate((sels) => sels.map((s) => {
          const e = document.querySelector(s);
          return !e || e.closest('.hidden') ? null : Math.round(e.getBoundingClientRect().top + scrollY);
        }), BLOCKS);
        BLOCKS.forEach((s, k) => { if (tops[k] != null) (seen[(withCat ? 'cat ' : '') + s] ||= new Set()).add(tops[k]); });
      }
    }
    for (const [s, set] of Object.entries(seen)) {
      if (set.size > 1) fail(`${s} moves when switching months: y = ${[...set].join(', ')}`);
    }
    console.log(`  month switching: ${chips} months x ${Object.keys(seen).length} blocks checked`);
    await p.locator('#close').click();
    await p.evaluate(() => scrollTo(0, 0));

    // 2. Taps
    const tap = async (label, sel, nth) => {
      const loc = nth === 'last' ? p.locator(sel).last() : p.locator(sel).nth(nth);
      await loc.scrollIntoViewIfNeeded();
      await settle(300);
      const y0 = (await loc.boundingBox()).y;
      await loc.click({ force: true });
      const box = await loc.boundingBox();
      const moved = box ? Math.round(box.y - y0) : 0;
      await settle();
      const state = await p.evaluate(() => {
        const d = document.getElementById('detail');
        if (d.classList.contains('hidden')) return 'closed';
        const r = d.getBoundingClientRect();
        return `open below #${d.previousElementSibling.id || d.previousElementSibling.className}, ` +
          `${Math.round(Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)))}px visible`;
      });
      console.log(`  ${label.padEnd(34)} moved ${String(moved).padStart(3)}px  ${state}`);
      if (Math.abs(moved) > TAP_TOLERANCE) fail(`${label}: tapped element moved ${moved}px`);
    };
    await tap('By category: last row', '#cats g', 'last');
    await tap('trend chart: a month', '#trend rect[fill="transparent"]', 4);
    await tap('total chart: a month', '#bars rect[fill="transparent"]', 3);
    await tap('heatmap: row 2 (moves card)', '#heat g', 1);
    await p.evaluate(() => scrollTo(0, 1e6)); await settle(300);
    await tap('heatmap: row 2 again (closes)', '#heat g', 1);
    await tap('heatmap: row 4', '#heat g', 3);
    await tap('By category: row 1 (moves card)', '#cats g', 0);
    await tap('Close button', '#close', 0);

    if (errors.length) fail('page errors: ' + errors.join(' | '));
    await p.close();
  }
  await browser.close();
  console.log(failures ? `${failures} check(s) failed` : 'All checks passed');
  process.exit(failures ? 1 : 0);
})();
