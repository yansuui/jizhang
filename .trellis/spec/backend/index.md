# Backend Development Guidelines

> `packages/server` — a single API-only Fastify (TypeScript, ESM) service serving
> `/api/v1/**` for native clients. Public Web hosting is retired.

---

## Overview

Three properties shape everything below:

1. **It uses invitation-only identities and private SQLite ledgers.** Central identity
   lives in `auth.db`; the original owner retains `jizhang.db` and invited users get
   separate ledger files. See [identity and invitations](./multiuser-identity.md).
   The Fastify app remains a small service; optional
   CPU-heavy item-photo inference runs in a separate private, resource-capped container.
   No ORM, persistent job queue, or cache layer. Complexity has to earn its place.
2. **The accounting rules live in `@jizhang/shared`**, not here. The server reads rows and
   hands them to pure functions; it does not own the arithmetic.
3. **Money is integer cents and time is epoch milliseconds**, everywhere, with the
   conversion done once at the boundary.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization, and the auth-plugin encapsulation trap | Done |
| [Private Account Ownership](./tenancy.md) | Per-user service contexts, request/worker lifetime, file and cutout ownership | Source and automated tests |
| [Database Guidelines](./database-guidelines.md) | better-sqlite3, migrations, soft delete, backup | Done |
| [Multi-user identity](./multiuser-identity.md) | Original-owner migration, private bindings, sessions and invite consumption | Source and fixture tests; production migration separate |
| [Error Handling](./error-handling.md) | One error shape, 401 vs 403 vs 404, no leaks | Done |
| [Assistant Streaming](./assistant-streaming.md) | Generation v1 SSE, clarification, lifecycle and cancellation | Done (source/tests; runtime pending) |
| [AI Provider Integration](./ai-provider.md) | Configurable provider HTTP, encrypted secrets, draft contract | Done |
| [Merged Bill Import](./merged-bill-import.md) | Dedicated bounded multi-file batch routes, review, live-view and atomic confirmation | Source-backed; real export benchmark not established || [Personal Item Assets](./item-assets.md) | Item lifecycle API, isolated ledger links, bounded photo BLOBs, and private cutout jobs | Done |
| [Independent Financial Plan](./financial-plan.md) | Four-purpose planning, manual reserve, exact-cents forecast and no-ledger-write boundary | Source/local automated verification complete; device/deployment pending |
| [Financial Execution System](./financial-execution.md) | Salary cycles, frozen windows, category rules, refund splits, and net execution | Done (source/local checks; device/deployment pending) |
| [Statistics windows](./statistics-window.md) | Server-owned windows, gross totals and exact complete drilldown | Source/local checks; device pending |
| [Quality Guidelines](./quality-guidelines.md) | Gate commands, Docker field notes, verification rules | Done |
| [Native Client Delivery](./native-delivery.md) | API-only hosting, native bill-account query ownership, inventory maintenance and deployment acceptance | Done (source/local checks; device acceptance tracked separately) |
| [Logging Guidelines](./logging-guidelines.md) | pino levels, what may never be logged | Done |

---

## Where to look first

| If you are… | Read |
|---|---|
| adding an endpoint | `directory-structure.md` (routes → services → shared), then `error-handling.md` |
| changing merged bill import | `merged-bill-import.md` (dedicated bounded routes, review/live-view, atomic final transaction) |
| touching the schema | `database-guidelines.md` |
| wiring a new cross-cutting concern (auth, rate limiting) | `directory-structure.md` § "Authentication is a single module" — this is the mistake that cost the most time |
| about to report a task as verified | `quality-guidelines.md` — the field notes at the bottom are all real incidents |

---

## The three rules that were learned the hard way

1. **A hook and the routes it should protect must be registered in ONE plugin.** Two sibling
   `app.register(...)` calls silently leave the routes unguarded, and the unit tests written
   against that wiring will all pass.
2. **Never reason about money or dates from a hand-computed expectation.** Dump the actual
   rows first. Three separate "engine bugs" in development were arithmetic mistakes in the
   expectation, and one was a stale database snapshot from copying a WAL-mode file.
3. **A backup is not a backup until it has been restored.** `cli-db.ts` verifies its own
   output, and the T10 drill restores one for real.

---

## Income is not only transactions

`StatsService.monthlyTrend` computes `incomeCents` as **income transactions plus salary
records**. Salaries live in their own table (`salary_records`) because they carry an
allocation snapshot rather than a category, so aggregating the ledger alone reported an
income of 0 for a month whose only income was a recorded salary.

Two things follow, and both are load-bearing:

- **`categoryShare` deliberately does NOT include salaries.** A salary has no category, and
  inventing one would misreport the composition of spending. If you are reading
  `categoryShare` and wondering why salary income is missing, this is the answer — it is not
  a bug.
- **Any new screen that shows "income" must agree with the others.** The home dashboard and
  the charts page both read `monthlyTrend` for this reason. If you find yourself adding
  income up from a second place, stop and read the section above it.

### The duplicate-entry limit is intentional

If a user records a salary with 记工资 *and* also enters an income transaction for the same
money, both are counted. There is no de-duplication, on purpose: two rows are two recorded
facts, and any rule that guessed they were the same (matching amount? same day? same note?)
would eventually delete real data. This is a data-entry behaviour, not a defect.

---

## Account balances: a derived stock, not a stored number

`GET /api/v1/accounts/balances` answers "how much money is in each account". The arithmetic is
`packages/shared/src/account-balance.ts`; `AccountBalanceService` only reads rows and renames
them to camelCase.

```
balance = initialBalance + income − netExpense + salaries
```

Four properties are load-bearing, and each has been got wrong somewhere before:

1. **It is derived, never stored.** There is no `balance_cents` column and there must not be one
   — the same rule as the envelope engine (`database-guidelines.md`: "No materialised balances,
   ever"). `db.test.ts` asserts the absence of such columns.
2. **A refund is income and RAISES the balance without reducing spending.** The current
   `expenseContribution` / `incomeContribution` contract in `shared/src/types.ts` uses
   income transactions (`type=1`) with `isRefund=true`; `refund_links` records the original
   expenses. Do not revive the older net-expense model or duplicate this arithmetic in
   native clients.
3. **No date filter.** Every live row counts, whatever its date. The bill list does not hide a
   future-dated row either, so filtering here would make the home total disagree with what the
   user can add up on screen. There is also nothing to filter by: a recurring bill is not money
   until it is confirmed.
4. **A salary is `salaryCents`, not `incomeCents`.** The two are separate buckets for the same
   reason `monthlyTrend` adds salaries separately from transactions — a salary has no category.

### Deleting an account removes its balance from the total

`deleteAccount` does **not** refuse when bills reference the account (the reference count is only
surfaced to the UI through `/accounts/:id/usage` for a warning). So a soft-deleted account can
still own live bills, and the balance endpoint simply does not read it:

- `items` covers **live** accounts only, and `totalBalanceCents` is the sum of those rows;
- the account's balance therefore leaves the balance sheet, while its historical bills stay in
  the ledger.

That is the documented soft-delete rule ("a soft-deleted row must disappear from derived views
too"), and it is a choice rather than an accident — the management screen prints how much will
leave the total before the user confirms. Do not "fix" it by counting deleted accounts into the
total; that would make the total disagree with the rows printed under it.

### A salary must name its account

`salary_records.account_id` is required by `SalaryService.create`. A missing or unknown id is a
`400`, never a silent fallback to the default account — same orientation as the CSV import, which
refuses unknown names rather than inventing them. The column is `NOT NULL DEFAULT
'builtin-default-account'` only so that migration 003 could backfill pre-existing rows in the
same statement that added it.

---

## Transfers are a separate table, and that IS the design

A transfer moves money between two of the user's own accounts. It is **neither income nor
expense**, and the way that is guaranteed is worth understanding before touching anything here.

The tempting encoding is two linked transactions (outflow as an expense, inflow as an income)
sharing a `transfer_group_id`. It is wrong: `expenseContribution` would then count the outflow as
spending and `incomeContribution` would count the inflow as earning, so the budget engine, the
carryover pool, the monthly trend, the category share and the dashboard would **each** need a
`transfer_group_id IS NULL` guard. One missed guard is a silently wrong budget, and the frontend
would additionally have to render a category a transfer does not have.

So `transfers` is its own table, and nothing that computes money reads it except
`computeAccountBalances`. **The budget engine and the statistics service needed zero changes for
this feature** — that is the property to preserve, and `e2e-transfers.mjs` asserts it by comparing
`monthly-trend` / `category-share` / `pool-trend` / `budget/overview` / the ledger **byte for
byte** before and after a transfer, on a ledger that actually has a budget and spending in it.

Two consequences worth stating because they look like bugs:

- **`Σ_accounts transferFlowCents(t, accountId) === 0`.** A transfer creates and destroys no
  money, so the balance-sheet total is unchanged by one. That is the mathematical form of "not
  income and not expense", and `transferFlowCents` is the only place the from/to decision lives.
- **`fromAccountId === toAccountId` is rejected** (`TransferService`). The net-zero property
  relies on the two branches in `transferFlowCents` being mutually exclusive, so the service, not
  the arithmetic, is what keeps it true.

A transfer touching a **soft-deleted** account still counts on the live side: `<live> -> <deleted>`
reduces the live account's balance and the total drops by the same amount. That is the same thing
that happens when a positive-balance account is deleted, not a special case. Discarding the whole
movement instead would make a live account silently ignore money that really left it.

Transfers have **no recycle bin** and are **not in the CSV export**, both following the existing
scope decision that the bin and the CSV cover transactions only. The costs are documented in
`USAGE.md` rather than left implicit.

---

## Naming a budget cycle

The engine's three view functions are **positional**: `computeModuleViews` and
`computeCarryoverPool` read `groups[0]` (the newest allocation group) and take no target
cycle, and none of them reads a clock. So "the current cycle" means *the newest cycle that
has an allocation* — not "the cycle containing today". A salary recorded three months ago
makes that cycle "current".

To report any cycle, name it by `periodStart`: the engine's own `group.start`, which
`computePoolTrend` already exposes as `PoolTrendPoint.periodStart`.

- `natural-month` → the **earliest salary day in that month**, NOT the 1st.
- `start-day` → the configured boundary.

`listCycleStarts()` is the authoritative "which cycles exist" and is unit-tested to equal
`computePoolTrend(...).map(p => p.periodStart)` point for point. Use it to validate a
requested period.

**Do not** identify a cycle by the `year * 100 + month` key: it cannot express a cycle that
begins on the 5th. And normalise a requested timestamp with `dateOnly` before matching,
because `group.start` already is.

Three rules that keep this honest:

1. **An unknown `periodStart` is a 400, never a silent fallback to the current cycle.**
   Falling back would render one month's figures under another month's heading.
2. **Omitting `periodStart` must stay byte-identical** to the pre-existing behaviour. That
   is asserted field-for-field, including the pool.
3. **A historical cycle's carryover pool comes from the trend series**, at the point for
   that cycle — not from re-running the pool arithmetic over a truncated allocation list.
   `computeCarryoverPool`'s current-cycle branch only carries an *overspent* module's
   shortfall; a closed cycle's leftover from un-overspent modules enters through its
   historical branch. Truncating would therefore produce a wrong number.

---

## Recurring bills: two rules that are easy to get wrong

### Advance from the anchor, never from the previous due date

`packages/shared/src/recurring.ts` computes every occurrence from `anchorDate`. Adding a
month to the *previous* occurrence looks equivalent and is not:

```
anchor 1/31:   1/31 -> 2/28 -> 3/31 -> 4/30 -> 5/31   (from the anchor: correct)
               1/31 -> 2/28 -> 3/28 -> 4/28 -> ...    (from the previous: permanent drift)
```

The drift is invisible in the first step and permanent afterwards, so it is pinned by a
test with a fixed date, not by a plausible-looking single step.

### Confirmation must be idempotent

`confirmOccurrence` runs in one transaction and returns the existing bill when the
occurrence is already confirmed (`created: false`) instead of creating a second one. This
is the feature's most dangerous path: a double confirmation counts money twice and nothing
on screen says so. Ignoring a confirmed occurrence is a `409`, not a silent success —
there IS a bill, and pretending otherwise would mislead the caller.

Two operational notes that cost debugging time here:

- **Generation is an explicit `POST`, not a side effect of `GET /pending`.** A read with a
  write side effect turns every retry and prefetch into a write. The frontend calls it when
  the dashboard or the queue mounts; it is idempotent, so calling it often is harmless.
- **A bodiless mutating request needs the CSRF header WITHOUT `Content-Type`.** The
  convenient thing is to reuse one `jsonHeaders` object everywhere, and it fails here:
  `POST /recurring/generate` and the ignore/confirm calls take no body, so sending
  `Content-Type: application/json` makes Fastify answer `400 FST_ERR_CTP_EMPTY_JSON_BODY`
  before the route runs. The symptom reads like "nothing was generated" and looks like a
  UI bug.

### The cap keeps the NEWEST periods

When more than `MAX_LOOKBACK_PERIODS` (12) periods are due, the most recent twelve are
materialised and `hasOlderDue` is set. Collecting every due date and then slicing from the
front keeps the *oldest* twelve — that is a real bug this code had, found only by a test
that pushed the window past the cap. Keep the window bounded as you walk it.

---

## Data portability: CSV export and import

`packages/shared/src/csv.ts` owns the escaping rules; `PortabilityService` owns the file
shape. Four things there are policy, not implementation detail.

### The export starts with a UTF-8 BOM, and that is not cosmetic

Without it, Windows Excel decodes the bytes using the local ANSI code page and every
Chinese character becomes garbage. The file is still plain UTF-8; the BOM is the signal
Excel needs.

**Test the BOM on the BYTES, never on a decoded string.** `fetch(...).text()` strips a
leading U+FEFF while decoding, so `text.startsWith('\uFEFF')` is false for a file that
genuinely has one — an assertion written that way fails against correct code. Fetch the
`arrayBuffer` and check `EF BB BF`. This cost a debugging round.

### Deduplication keys on the exported `id`

A natural key (date + amount + note) looks tidier and is wrong: two identical coffees on
one day are two real bills, and that rule would collapse them and lose money. Losing a row
is the one failure this feature must not have, so the round trip asserts the row COUNT and
the NET TOTAL, not just "no error".

### Import is all-or-nothing, and unknown names fail loudly

One transaction for the whole file. Failures here mean the file is wrong, not that row 37
is unlucky, and a half-imported ledger is harder to reason about than a rejected one.

An unknown **category or account name** aborts the import and names the offender. It is
neither created on the fly (that would let an import silently pollute master data the user
curates) nor silently skipped (that would lose money). The error carries the line number so
the file can be fixed.

Names, not ids, are what the export writes: the file is meant to be read by a person, and a
UUID cannot be checked by eye.

### Restore is not offered in the UI

`restoreBackup` requires the server to be stopped, because it replaces the database file and
a live process would keep writing to a deleted inode. A button inside the app cannot stop
the app, so the data screen prints the command instead. Do not "finish" this feature by
adding a restore endpoint.

The backup listing returns **file names only** — the host path is useless to a client that
cannot read the filesystem and leaks deployment detail.

---

**Language**: All documentation is written in **English**, matching the code comments.
User-facing strings (error messages, UI copy) are in **Chinese**, because the user is.
