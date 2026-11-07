# Revolut expense tracker

Google Apps Script project bound to the "Revolut expenses" Google Sheet, managed with clasp.
Full project context (architecture, sheet layout, spending rules, gotchas): **read `docs/CONTEXT.md` first** and keep it up to date when something structural changes.

## Layout
- `src/` – Apps Script sources synced with clasp (`Code.js`, `Dashboard.html`, `appsscript.json`). clasp stores `.gs` files as `.js` locally.
- `.clasp.json` – points clasp at the bound script (`rootDir: src`).
- `scripts/clasp-auth.sh` – writes `~/.clasprc.json` from the `CLASPRC_B64` (base64) or `CLASPRC_JSON` env var.
- `docs/CONTEXT.md` – project context.
- `tools/preview/` – local dashboard preview: mock data, layout-stability checks, screenshots (see its README).
- `tools/test/code.test.js` – server-side tests for `Code.js` (daily run, multi-bank sync, connect flow) with fake Google services and a fake Enable Banking. Run `node tools/test/code.test.js` before pushing changes to `Code.js`, and extend it when you change that logic.

## Session start
1. Run `scripts/clasp-auth.sh`. If neither variable is set, tell the user and continue with offline work only.
2. If `.clasp.json` does not exist yet: `clasp clone <scriptId> --rootDir src`, then commit.
3. Run `clasp pull` and check `git status`. If the remote differs from git (the user edited in the browser editor), commit that as "Sync from Apps Script editor" before making changes.

## Workflow rules
- **Always `clasp pull` before `clasp push`.** `push` replaces the whole remote project with `src/`; anything edited only in the browser is lost.
- `clasp push` updates HEAD immediately, and the daily trigger (`dailyRun`) and `onEdit` run HEAD code. Only push code that is ready.
- The web app (`/exec`) serves a versioned deployment. After changing `Dashboard.html` or `doGet`, update **the existing deployment**:
  `clasp deploy -i <deploymentId> -d "<description>"` (find the ID with `clasp deployments`; it's the one that is not `@HEAD`).
  **Never run `clasp deploy` without `-i`**: a new deployment gets a new `/exec` URL, which breaks the Enable Banking redirect and the home-screen shortcut.
- Before pushing a `Dashboard.html` change, preview it locally: `node tools/preview/build.js /tmp/preview.html`, then `node tools/preview/check.js /tmp/preview.html` (must pass) and `node tools/preview/shot.js /tmp/preview.html /tmp/shot.png 390:m0 390:dark:m0` to show the user screenshots. If `getDashboardData_` gets a new field, add it to the mock data in `build.js`.
- **Never run `setup`** and don't run `recategorizeAll` without asking (see `docs/CONTEXT.md`).
- Secrets live in Script Properties (`EB_APP_ID`, `EB_PRIVATE_KEY`, …). Never hard-code them or commit them.
- The sheet itself (formulas, Rules tab) is edited through the Google Sheets connector, not clasp.
- Commit the code to git after every successful push, so git matches what is live.
