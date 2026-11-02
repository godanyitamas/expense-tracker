# Dashboard preview

Render `src/Dashboard.html` locally with mock data, check that the layout never jumps, and take
screenshots, without pushing anything to Apps Script. Uses the Playwright + Chromium that is
pre-installed in Claude Code cloud sessions (`require('playwright')`, nothing to install).

```bash
node tools/preview/build.js /tmp/preview.html      # Dashboard.html + mock data -> standalone page
node tools/preview/check.js /tmp/preview.html      # stability checks, exit 1 on failure
node tools/preview/shot.js /tmp/preview.html /tmp/shot.png 390:m0 390:dark:m3 1200:m0
```

- **Mock data** (`build.js`) has the same shape as `getDashboardData_()` in `Code.js`
  (`months`, `cats`, `tx`, `salary`, `syncedAt`, `validUntil`, `renewUrl`). It is generated, not
  real: no personal amounts in git. If `getDashboardData_` gains a field, add it here too.
- **Checks** (`check.js`), at 390px and 1200px: no block moves when switching months (with and
  without a category open), tapped elements stay put, no JavaScript errors.
- **Screenshot states** (`shot.js`): `<width>[:dark][:m<chip>][:c<category row>][:y<scrollY>]`,
  e.g. `390:dark:m3:c0:y900` = phone, dark mode, 4th-newest month, first category opened,
  scrolled to 900px. Several states end up side by side in one PNG.

For real numbers, read the sheet through the Google Sheets connector and swap them into the
`data` object of a local copy of `build.js`. Don't commit that copy.
