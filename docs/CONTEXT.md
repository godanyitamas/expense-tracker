# Revolut expense tracker — project context

Last updated: 1 Nov 2026. Update this file whenever something structural changes.

## Goal and principles
Automatic, phone-first tracker of Revolut spending. Free, simple, "design once and leave it". The Google Sheet is the single source of truth; dashboards only display it. Later: add an IBKR investments view (official IBKR connector exists in Claude).

## Architecture
1. **Revolut → Enable Banking** (PSD2 aggregator, free "restricted production" mode for own accounts). App name "Expense tracker", Revolut listed under FR, consent max 180 days. Current consent given 1 Nov 2026, so it expires around end of April 2027.
2. **Google Apps Script** bound to the sheet. Daily time trigger runs `dailyRun` at about 6–7 am: syncs booked transactions (pending ones skipped), applies rules, emails renewal reminders 7/3/1 days before consent expiry.
3. **Google Sheet** "Revolut expenses": ID `1s-tz6vRSG-ff2VsANsgPcEq8bDonAoK7KTt3clU2Ve0`.
4. **Dashboards:**
   - Primary: Apps Script web app (`/exec` URL, access "Only myself"), served from `Dashboard.html`, saved to the phone home screen. Reads ChartData on each open.
   - Backup: Claude-hosted dashboard artifact "My spending" (https://claude.ai/artifact/AHZTa8mGcPACrAg2gYYg3L), reads the sheet via the Google Sheets connector.
   - In-sheet: "Overview" tab (styled cards and charts).

Script properties: `EB_APP_ID`, `EB_PRIVATE_KEY`, `REDIRECT_URL` (the `/exec` URL, also registered in Enable Banking), optional `EB_COUNTRY`; the script also stores `SESSION`, `LAST_SYNC`, `AUTH_*`.

## Web app routes (`doGet`)
- `/exec` → dashboard
- `/exec?connect=1` → "Connect Revolut" (consent renewal; emails link here)
- `/exec?code=…&state=…` → Enable Banking callback, then an immediate sync

## Sheet tabs
- **Transactions:** A Key (hidden, `accountUid:txId`), B Date, C Amount (signed, negative = out), D Currency, E Merchant, F Description, G Category, H Account, I Loaded at. Sorted newest first.
- **Rules:** "Merchant contains" → Category. First match wins, so order matters (specific rules above general ones). Matching is case-, accent- and punctuation-insensitive and must start at a word boundary. Credits with no rule become "Income"; debits with no rule become "Uncategorized".
- **ChartData** (hidden, all formulas): A1:C13 last 12 months totals; E:L top-7 categories × month; N:O last full month by category; Q:T category breakdown (this month / last month / 6-month avg); V1:X200 month × category long table; AA1:AE600 spending transactions for the last 12 months (id, date, merchant, category, amount). Both dashboards depend on V:X and AA:AE, and the HTML dashboard also uses A:C.
- **Overview:** styled sheet dashboard and charts built on ChartData.
- **Details:** the old dashboard (renamed). Budgets formulas reference `Details!$B$1`.
- **Budgets:** categories listed, no budgets set (not wanted for now).

## Spending rules (applied in every ChartData formula)
- EUR only (no HUF pocket synced).
- Category "Transfers" is excluded: own top-ups (Google Pay top-up), pocket moves ("To EUR…", "Exchanged to EUR"), money from/to Katia (girlfriend) directly.
- Payments made **from the joint account** (account label contains "KATIA OUTAYEB") are excluded. The monthly €800 personal → joint transfer counts as **Shared household** and covers rent, utilities, cat food and other mutual costs.
- Uber Eats and Deliveroo → "Delivery (food & groceries)" (used for both restaurants and groceries).
- Switzerland (Aug 2026) and Andalusia (Mar–Apr 2026) trip merchants → Travel.
- Peter Herbai → Subscriptions (Spotify family share).
- Remaining small Uncategorized items: deliberately left as is.

## Code.gs key functions
`setup`, `dailyRun`, `syncTransactions`, `applyRules_(force)`, `recategorizeAll`, `onEdit` (fixing an "Uncategorized" row by hand creates a rule for that merchant), `doGet`, `dashboardPage_`, `getDashboardData_`, `startAuth_`, `finishAuth_`, `eb_`, `jwt_`, `normalizePem_`, `norm_`, `categorize_`, `listRevolut`, `testConnection`.

## Gotchas
- **Never re-run `setup`:** it rebuilds Details/Budgets from the old template and would undo the hand-edited formulas. (Exception: re-creating a missing trigger, and then fix formulas after.)
- `recategorizeAll` overwrites every category, including manual fixes.
- Claude's Google Sheets connector can edit the sheet but **not** Apps Script. Code changes need the user to paste them into the editor.
- After changing `Dashboard.html` or `doGet`: Deploy → Manage deployments → edit (pencil) → New version. Never create a new deployment, since the `/exec` URL must stay the same (it is the Enable Banking redirect).
- Rules added through the connector don't trigger `onEdit`; they apply to Uncategorized rows on the next daily sync, or immediately via `recategorizeAll`.
- Sheets QUERY has no unary minus: use `0-sum(C)`, not `-sum(C)`. Spreadsheet locale is en_GB.
- The rule "distri" (Groceries) also catches "Distribusion Aerobus"; known, minor.
- Some money received back is categorized "Income"; this matters only if an income/savings view is added.

## Status
Done: bank connection, daily sync, rules and categories, Overview tab, Claude dashboard, home-screen web-app dashboard (pending user's deploy and confirmation that it works).

Ideas and open items: confirm the trigger runs and the dashboard footer shows "Synced…"; savings view (income minus spending); IBKR investments view; optionally delete the Claude dashboard artifact.
