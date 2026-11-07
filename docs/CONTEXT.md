# Revolut expense tracker — project context

Last updated: 7 Nov 2026. Update this file whenever something structural changes.

## Goal and principles
Automatic, phone-first tracker of Revolut spending. Free, simple, "design once and leave it". The Google Sheet is the single source of truth; dashboards only display it. Later: add an IBKR investments view (official IBKR connector exists in Claude).

## Architecture
0. **Banks:** Revolut (since 1 Nov 2026) and, prepared but not yet connected, American Express France (Enable Banking lists "American Express", FR, personal and business, 180-day consent, not beta; card received 6 Nov 2026). Each bank has its own consent in its own script property (`SESSION` = Revolut, `SESSION_AMEX` = Amex; see `BANKS` in Code.gs).
1. **Revolut → Enable Banking** (PSD2 aggregator, free "restricted production" mode for own accounts). App name "Expense tracker", Revolut listed under FR, consent max 180 days. Current consent given 1 Nov 2026, so it expires around end of April 2027.
2. **Google Apps Script** bound to the sheet. Daily time trigger runs `dailyRun` at about 6–7 am: syncs booked transactions (pending ones skipped), applies rules, emails renewal reminders 7/3/1 days before consent expiry.
3. **Google Sheet** "Revolut expenses": ID `1s-tz6vRSG-ff2VsANsgPcEq8bDonAoK7KTt3clU2Ve0`.
4. **Dashboards:**
   - Primary: Apps Script web app (`/exec` URL, access "Only myself"), served from `Dashboard.html`, saved to the phone home screen. Reads ChartData on each open.
   - Backup: Claude-hosted dashboard artifact "My spending" (https://claude.ai/artifact/AHZTa8mGcPACrAg2gYYg3L), reads the sheet via the Google Sheets connector.
   - In-sheet: "Overview" tab (styled cards and charts).

Script properties: `EB_APP_ID`, `EB_PRIVATE_KEY`, `REDIRECT_URL` (the `/exec` URL, also registered in Enable Banking), optional `EB_COUNTRY`; the script also stores `SESSION` (Revolut), `SESSION_AMEX`, `LAST_SYNC`, `AUTH_*`.

## Web app routes (`doGet`)
- `/exec` → dashboard
- `/exec?connect=1` → "Connect Revolut" (consent renewal; emails link here)
- `/exec?connect=amex` → "Connect Amex" (same flow; `AUTH_BANK` remembers which bank the callback is for)
- `/exec?code=…&state=…` → Enable Banking callback, then an immediate sync

## Sheet tabs
- **Transactions:** A Key (hidden, `accountUid:txId`), B Date, C Amount (signed, negative = out), D Currency, E Merchant, F Description, G Category, H Account, I Loaded at. Sorted newest first.
- **Rules:** "avanade" → Salary is the first rule. "Merchant contains" → Category. First match wins, so order matters (specific rules above general ones). Matching is case-, accent- and punctuation-insensitive and must start at a word boundary. Credits with no rule become "Income"; debits with no rule become "Uncategorized".
- **ChartData** (hidden, all formulas): A1:C13 last 12 months totals; E:L top-7 categories × month; N:O last full month by category; Q:T category breakdown (this month / last month / 6-month avg); V1:X200 month × category long table; AA1:AE600 spending transactions for the last 12 months (id, date, merchant, category, amount). Both dashboards depend on V:X and AA:AE, and the HTML dashboard also uses A:C.
- **Salary:** A month (budget month), B salary in EUR, C source; E1:F2 hold a fixed HUF→EUR rate (0.002735017, Google Finance on 2 Nov 2026) and 560,000 HUF. Jan–Mar 2026 = estimate (560,000 HUF × fixed rate). From Apr 2026 B is a formula summing Transactions rows with category "Salary": paid on day 1–15 counts for that month, after the 15th for the next month. Rows run to Dec 2027; extend them after that. The HTML dashboard reads this tab (`getDashboardData_` → `salary`).
- **Balances:** written by every sync (`saveBalances_`), overwritten each time: one row per account and balance type as Enable Banking reports it (Account, Type, Amount, Currency, Reference date, Fetched at, Raw JSON); an account whose balance request fails gets an ERROR row. The dashboard's "Right now" card reads it.
- **Overview:** styled sheet dashboard and charts built on ChartData.
- **Details:** the old dashboard (renamed). Budgets formulas reference `Details!$B$1`.
- **Budgets:** categories listed, no budgets set (not wanted for now).

## Spending rules (applied in every ChartData formula)
- EUR only (no HUF pocket synced).
- Category "Transfers" is excluded: own top-ups (Google Pay top-up), pocket moves ("To EUR…", "Exchanged to EUR"), money from/to Katia (girlfriend) directly.
- **Salary** (category "Salary", credits, so never counted as spending): Accenture Hungary until Oct 2026, paid by the 10th to OTP and moved to Revolut as "Google Pay Top-Up by *4749" (one per month, 6th–10th, Apr–Oct 2026 tagged by hand; extra top-ups in the same month stay Transfers). Avanade France from 28 Oct 2026, paid at the end of the month for the next month's budget, tagged by the "avanade" rule. The HUF Revolut account is not synced, so Jan–Mar 2026 salary is an estimate.
- Payments made **from the joint account** (account label contains "KATIA OUTAYEB") are excluded. The monthly €800 personal → joint transfer counts as **Shared household** and covers rent, utilities, cat food and other mutual costs.
- Uber Eats and Deliveroo → "Delivery (food & groceries)" (used for both restaurants and groceries).
- Switzerland (Aug 2026) and Andalusia (Mar–Apr 2026) trip merchants → Travel.
- Peter Herbai → Subscriptions (Spotify family share).
- Remaining small Uncategorized items: deliberately left as is.

## Code.gs key functions
`setup`, `dailyRun`, `activeBanks_`, `syncTransactions`, `applyRules_(force)`, `recategorizeAll`, `onEdit` (fixing an "Uncategorized" row by hand creates a rule for that merchant), `doGet`, `dashboardPage_`, `getDashboardData_`, `startAuth_`, `finishAuth_`, `eb_`, `jwt_`, `normalizePem_`, `norm_`, `categorize_`, `listRevolut`, `testConnection`.

## Gotchas
- **Never re-run `setup`:** it rebuilds Details/Budgets from the old template and would undo the hand-edited formulas. (Exception: re-creating a missing trigger, and then fix formulas after.)
- `recategorizeAll` overwrites every category, including manual fixes. That includes the 7 hand-tagged salary top-ups (Apr–Oct 2026), which would go back to Transfers.
- Claude's Google Sheets connector can edit the sheet but **not** Apps Script. Code changes need the user to paste them into the editor.
- After changing `Dashboard.html` or `doGet`: Deploy → Manage deployments → edit (pencil) → New version. Never create a new deployment, since the `/exec` URL must stay the same (it is the Enable Banking redirect).
- Rules added through the connector don't trigger `onEdit`; they apply to Uncategorized rows on the next daily sync, or immediately via `recategorizeAll`.
- Sheets QUERY has no unary minus: use `0-sum(C)`, not `-sum(C)`. Spreadsheet locale is en_GB.
- The rule "distri" (Groceries) also catches "Distribusion Aerobus"; known, minor.
- Some money received back is categorized "Income"; this matters only if an income/savings view is added.
- **Daily run with several banks:** each bank's expiry email (7/3/1 days, and daily once expired) uses that bank's link; an expired bank is skipped and the others still sync. If one account fails mid-consent, the other accounts' rows are saved first, then the run fails with the error (Google emails the failure).
- **"Right now" card (dashboard):** On Revolut = personal account balance (preferred type ITAV > CLAV > XPCD > ITBD > CLBD, see `pickBalance_`); Amex to pay = −(sum of booked EUR Amex rows), i.e. purchases − refunds − bill payments received (`amexOwed_`, exact because the card was new on 6 Nov 2026; pending Amex purchases are not included); Free to spend = Revolut − Amex to pay. Joint balance shown below. Savings vaults are not exposed by Revolut's open banking. Which balance types Revolut actually reports: check the Balances tab after a sync.
- **Amex bill (to do after the first statement):** if it is paid from Revolut, add rules so the Revolut payment to Amex and the "payment received" on the Amex side are both "Transfers" (otherwise spending is double counted and the Amex credit becomes "Income"). Check the exact labels first; a broad "american express" rule would also catch the annual fee.
- **Revolut data (checked 7 Nov 2026, RawSample tab):** no merchant category codes (MCC always empty). Available: transaction type (CARD_PAYMENT/TRANSFER/TOPUP/REV_PAYMENT), card last 4 (6975 = Tamás on personal; on the joint account 2969 = Tamás, 5023 = Katia), payer name, exchange rate for HUF payments, IBANs on transfers, pending status. Helpers: `listBanks(pattern)`, `saveRawSample_(days, perAccount, bank)`.

## Status
Done: bank connection, daily sync, rules and categories, Overview tab, Claude dashboard, home-screen web-app dashboard (pending user's deploy and confirmation that it works).

Done 2 Nov 2026: Salary tab; dashboard shows "Left from salary" (salary − spending, % saved), salary in the summary line and green salary marks on the monthly chart; layout fixed across months; taps no longer scroll the page.

Ideas and open items: confirm the trigger runs and the dashboard footer shows "Synced…"; IBKR investments view; optionally delete the Claude dashboard artifact.
