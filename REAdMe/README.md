# Library Management System — Layer 1 (Front-end Prototype)

A college library web app built with **HTML5, CSS3 and vanilla JavaScript only**. Data is saved in the browser's **LocalStorage**.
There is no Node.js, Supabase, PostgreSQL, stored procedure or framework in this layer. Those belong to **Layer 2**.

> **This is a front-end prototype.** The role selector is a demonstration, **not authentication or authorization**, and LocalStorage is **not secure storage**.

## Required files

```
library-ms/
├── index.html
├── css/style.css
├── js/
│   ├── data.js      sample data only (data model version 2)
│   ├── storage.js   LocalStorage persistence, validation/migration, and ALL business rules (LibraryAPI)
│   ├── ui.js        rendering helpers and page views
│   └── app.js       routing, role selector, events, forms
├── tests/run-tests.js   optional automated tests (needs Node, not needed to run the app)
└── README.md
```

## How to run

Open `index.html` in a modern browser (Chrome, Edge, Firefox, Safari). No server or build step is needed.

Optional automated tests: `node tests/run-tests.js` (tests the data layer and renders every page in Node; see "Testing evidence").

## How LocalStorage persistence works

- All data is stored as one JSON object under the key `lms_demo_data_v1` (data model `version: 2`). Every change is written immediately, so it survives refreshes.
- On load the data is validated. If it is corrupted or has the wrong structure, the bad value is backed up to `lms_demo_data_v1_corrupt_backup`, the sample data is restored, and a warning is shown. Malformed individual records (reports, history entries, reservations) are dropped instead of crashing the app.
- Older saved data (Part 1 / first Part 2 build) is upgraded in place. The history log is backfilled once from existing records and those entries are marked "sample/earlier data".
- Records use stable IDs (`B001`, `B001-C01`, `M-2026-001`, `T-0001`, `DR-0001`, `R-0001`, `EV-0001`, `CL-0001`), never array positions.
- Data is per browser and per device. Clearing site data erases it.

## Demo roles (not security)

Use the **DEMO ROLE** selector in the top bar. Anyone can change it or edit LocalStorage.

| Role | Pages | Can do |
|---|---|---|
| Student / Faculty | Book Catalog, My Loans and Renewals, My Borrowing History | Search/view books; see only their own loans and history; renew their own eligible loans (choose which member you are) |
| Librarian | Everything except Settings | Books, copies, members, borrowing and returns, renewals, reservations, damage/lost reports, overdue, history, reports |
| System Administrator | Everything | All of the above, plus Settings and Reset Demo Data |

A member's "renewal request" is applied immediately when the loan is eligible, or rejected with a reason. There is no approval queue.

## How to reset sample data

Switch to **System Administrator** → **Settings** → **Reset Demo Data** → confirm. This restores the original sample data **and default settings** (the chosen demo role is kept). Nothing is erased without the confirmation dialog.

## Implemented features

- **Dashboard**: live statistics (including damaged/repair/lost, open reports, renewed today), copies-by-status chart, recent transactions, overdue list. The library name from Settings is shown in the sidebar, page title and dashboard.
- **Book Catalog / Book Copies / Members**: search, filters, add/edit, duplicate ISBN and email checks, unique copy IDs, book-details dialog.
- **Borrowing and Returns**: due dates from Settings, borrowing limits, eligibility checks, duplicate-borrow and double-return prevention, late fines.
- **Damage and Lost Books**: report a specific copy (type, description, reporting librarian, automatic date/time); searchable and filterable table; statuses **Reported → Under Repair → Resolved → Closed**. Repair needs "Under Repair" first; "Written off" closes the report and withdraws the copy; Closed is final. Copies that are Damaged, Under Repair, Lost or Withdrawn cannot be borrowed. A copy returns to Available only when Repaired or Found, with a usable (not Worn) condition and no active loan. A copy on loan can only be reported Lost: the loan closes as "Lost" and stays in history. Confirmation dialogs guard report, repair, resolve, write-off and close actions. Every change adds to a per-copy condition history.
- **Due Dates and Renewals**: configurable renewal days, maximum renewals and overdue-renewal policy. Rejection reasons: loan not found, already returned, member not Active, copy not eligible, renewal limit reached, overdue policy, or another member's active reservation. Each renewal records the previous and new due date. A confirmation dialog plus a repeated-click guard prevents duplicate renewals, and nothing changes when validation fails. A simple reservation list demonstrates the reservation rule.
- **Overdue Books**: transaction ID, member name and ID, title, copy ID, due date, days overdue, renewal count, status, projected fine; search and filters (scope, member type, days-overdue range); "View" jumps to the transaction's history; Return and Renew buttons; list updates after a return or renewal; CSV export.
- **Transaction History**: an append-only **Activity Log** (stable event ID, type, timestamp, related transaction/copy/report/member IDs, acting demo user, description) covering borrowed, returned, renewed, lost loan, damage reported, lost reported, moved to repair, repair completed, copy found, written off, report closed, status changed and reservations. Search by member, book, copy, transaction or event ID; filter by event type and date range; sort newest/oldest; CSV export. A second tab shows the **Copy Condition** history (status and condition changes).
- **Reports** (live data, date filter for activity sections): inventory summary, available vs borrowed copies, overdue transactions, damaged and lost copies, loan and return activity, renewal activity, all-time circulation summary; empty-period messages; Print; CSV export for Overdue Books and Transaction History (commas, quotes, newlines and formula characters are escaped; files named like `overdue_books_YYYY-MM-DD.csv`).
- **Settings** (System Administrator): library name, borrowing duration and limit (students and faculty separately), renewal duration, maximum renewals, overdue-renewal policy, fine per day; validated and saved; applies to later operations (loan period changes affect new loans only).
- **UI**: responsive layout, shared table/badge/form/modal styles, empty and error states, accessible names for controls, dialog roles, focus outlines, no dead buttons (checked statically).

### Business-rule notes
- A loan is overdue when today is **after** its due date; a book due today is not overdue. Dates are calendar dates (`YYYY-MM-DD`) handled in local time, so time zones do not shift due dates.
- Renewing a non-overdue loan: new due date = current due date + renewal days. Renewing an overdue loan (if allowed): new due date = today + renewal days; overdue days already incurred are still charged on return.

## Known limitations
- No real login, passwords or server-side checks; role checks can be bypassed.
- LocalStorage is limited (about 5 MB), per browser, and has no concurrency control.
- Borrowing duration and limit are set separately for students and faculty (a deliberate extension of "default duration / limit").
- No replacement-cost charges for lost books, no fine payments, no email/SMS notices, no deleting books.
- Seeded history entries are generated from the sample records and labeled as such; they are not real past user actions.
- The reporting librarian is a typed name (prefilled with the demo user), not a verified identity.

## Prototype vs. the future backend system (Layer 2)
`LibraryAPI` (`js/storage.js`) is the only layer the UI calls and returns `{ok, data}` / `{ok:false, error}` everywhere, so it can be re-implemented later without redesigning the UI.

| Layer 1 (this prototype) | Layer 2 (planned) |
|---|---|
| LocalStorage JSON | Supabase / PostgreSQL tables with keys and constraints |
| Business rules in JavaScript | Stored procedures (issue, return, renew, report, repair, resolve) running as single transactions |
| Demo role selector | Real authentication and Row Level Security |
| Append-only `eventLog` array | Audit/event tables written by the procedures |
| Synchronous calls | Async calls through RPC/database-function wrappers |

## Testing evidence

Run on the delivered code with `node tests/run-tests.js`: **50 tests, 50 passed, 0 failed**, also passing when run with `TZ` set to Pacific/Auckland, America/Los_Angeles, Asia/Manila, UTC and Pacific/Kiritimati. The tests run the data layer and render every page for every role in Node with a fake LocalStorage.

**Not executed:** manual testing in a real browser (clicks, modals, `confirm()` dialogs, layout on desktop/tablet/mobile, file download of CSVs, Print). Please run the manual script below.

### Required scenarios

| # | Scenario | Automated test (tag in test name) | Real-browser check |
|---|---|---|---|
| 1 | Report a damaged copy | `[S1]` passed | not done |
| 2 | Prevent borrowing a damaged copy | `[S2]` passed | not done |
| 3 | Report lost copy, keep borrowing history | `[S3]` passed | not done |
| 4 | Resolve a damage report after repair | `[S4]` passed (2 tests) | not done |
| 5 | Reject invalid status transition | `[S5]` passed | not done |
| 6 | Renew an eligible loan (staff and member) | `[S6]` passed (2 tests) | not done |
| 7 | Reject renewal at maximum count | `[S7]` passed | not done |
| 8 | Reject renewal with competing reservation | `[S8]` passed | not done |
| 9 | Reject renewal of returned transaction | `[S9]` passed | not done |
| 10 | Reject overdue renewal when policy disallows | `[S10]` passed | not done |
| 11 | Correct overdue-day calculation | `[S11]` passed, plus time-zone test | not done |
| 12 | Return/renewal removes loan from overdue list | `[S12]` passed | not done |
| 13 | Renewal and condition history persist after reload | `[S13]` passed (reload simulated with a new context) | not done |
| 14 | Valid CSV | `[S14]` passed (escaping, row builders) | **file download not tested** |
| 15 | Settings affect future operations | `[S15]` passed (2 tests) | not done |
| 16 | Reset after confirmation | `[S16]` passed for the data reset; the `confirm()` dialog itself is **not** covered | not done |
| 17 | Part 1 workflows still work | `[S17]` passed (4 tests) | not done |

### Manual browser script (please run)
1. Click every sidebar link; switch each demo role and check the visible pages.
2. Damage and Lost Books: report a copy → try to borrow it → start repair → resolve → close; check both History tabs.
3. Due Dates and Renewals: renew `T-0011`; try `T-0012` (reservation), `T-0010` twice (limit), `T-0008` (overdue); double-click a Renew button quickly.
4. Overdue Books: use every filter; View; Return a loan and watch it disappear; Export CSV and open the file.
5. Reports: change the date range; export both CSVs; Print.
6. Settings (Administrator): change the library name and renewal values, then check the sidebar, dashboard and a renewal. Refresh the page. Reset Demo Data.

## Final implementation checklist

| Requirement | Status |
|---|---|
| 1. Damage / lost management incl. statuses, confirmations, history, borrow block, restore rules | Complete (browser-untested) |
| 2. Renewal rules, settings, history, duplicate-click guard, reservations | Complete (browser-untested) |
| 3. Overdue Books page, filters, navigation, return, dynamic updates | Complete (browser-untested) |
| 4. Transaction and condition history (persistent event log, filters, sort) | Complete (browser-untested) |
| 5. Reports with date filters and CSV for history and overdue | Complete (CSV download and print browser-untested) |
| 6. Settings page with validation, persistence, reset with confirmation | Complete (browser-untested) |
| 7. Demo roles and permissions, clearly labeled as not secure | Complete (browser-untested) |
| 8. UI consistency, responsive, accessibility basics, no dead buttons | Implemented; **responsive layout and keyboard use not verified in a browser**; no formal accessibility audit |
| 9. Code integration (data / rules / UI / events separated, stable IDs, malformed data handled) | Complete |
| 10. Required testing | Automated parts done (50/50); **manual browser testing not done** |
| 11. README | Complete |
| Real database, authentication, RLS, stored procedures | **Not included by design (Layer 2)** |