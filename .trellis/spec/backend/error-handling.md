# Error Handling — Backend

> The whole backend answers with one error shape. This file is the contract.

---

## The wire format

```json
{ "error": { "code": "VALIDATION", "message": "amountCents must be an integer number of cents." } }
```

Rendered by the single error handler in `app.ts`. Routes never build this object by hand
— they throw.

---

## Two error kinds

### 1. Domain errors carry `statusCode` + `code`

`ValidationError` (400), `NotFoundError` (404), `UnauthorizedError` (401) and `CsrfError`
(403) are thrown from services and plugins. The handler passes their `message` through
unchanged, because it was written to be read by a human:

```ts
throw new ValidationError(
  'amountCents must be an integer number of cents (got 1998.99). ' +
    'Convert yuan to cents with Math.round(value * 100) on the client.',
);
```

These messages are written for the *user of the app*, not for a developer reading a stack
trace. Say what was wrong and what to do instead.

### 2. Unexpected errors become 5xx with a fixed message

Anything reaching the handler with no usable `statusCode`, or with one `>= 500`, is logged
with its full stack and answered with:

```json
{ "error": { "code": "INTERNAL_ERROR", "message": "Internal Server Error" } }
```

**No stack, no internal message, ever.** Verified behaviour: a route throwing
`new Error("SECRET-INTERNAL: /data/jizhang.db at line 42")` returns the fixed string above,
and the real message appears only in the log.

---

## Auth failures must not leak account existence

`POST /auth/login` answers **byte-identical** responses for "wrong username", "wrong
password" and a malformed credential body: `401 INVALID_CREDENTIALS`. Login resolves
the actual central identity, not `config.username`. An unknown or disabled user runs
password verification against a cached dummy Argon2 hash; never restore the old
configured-username shortcut, which skipped expensive work for unknown accounts.
Oversized request bodies are separately rejected with 413. Authentication rate or
concurrency limits produce `429 RATE_LIMITED` before password hashing.

The real reason lives only in the server log: `reason: 'no-user' | 'wrong-password'`.

Registration is a separate invitation-authorized operation: invalid/expired/revoked/used
codes share `400 INVALID_INVITATION`; after validating a real invitation, an existing
username returns `409 USERNAME_TAKEN`. Administrator routes enforce `403 FORBIDDEN`
even when a client forges its UI role. Exact DTOs, limits and recovery behavior are
in [Multi-user identity](./multiuser-identity.md).

> An earlier version returned 400 for a missing field and 401 for a bad password, which
> told an attacker whether the account existed.

---

## 401 vs 403 vs 404 on the API

| Situation | Answer | Why |
|---|---|---|
| No or expired session on `/api/**` | `401 UNAUTHORIZED` | |
| Mutating request without `X-Requested-With: fetch` | `403 CSRF_REQUIRED` | second layer behind `SameSite=Lax` |
| **Unknown `/api/**` path while signed out** | **`401`, not 404** | a 401/404 difference would let anyone enumerate which routes exist on a public hostname |
| Unknown `/api/**` path while signed in | `404 NOT_FOUND`, JSON | never the SPA shell |
| Root or unknown non-API path | `404 NOT_FOUND`, JSON | public Web hosting is retired |

The guard runs *before* routing, which is what produces the third row. Do not "fix" it.

---

## Validation lives in the service, not the route

Routes parse and delegate; services validate. That is why the same rules apply whether a
value arrives over HTTP, from a test, or from the CLI:

- `TransactionService.requireIntegerCents` rejects non-integers and values `<= 0`.
- Reference checks (`assertCategoryUsable`) reject an unknown **or soft-deleted** category,
  so a stale client cannot file a transaction against something invisible.
- `isValidCycleStartDay` bounds `budget.cycle_start_day` to 1..28, and a stored
  out-of-range value reads back as *unset* rather than being trusted.

---

## A bodiless mutating request needs no `Content-Type`

Sending `Content-Type: application/json` with an empty body is a client error: Fastify
answers `FST_ERR_CTP_EMPTY_JSON_BODY` (400) before the route runs. That is what a
bodiless `POST /auth/logout` hit during verification.

This bites integration scripts specifically, because the convenient thing to do is reuse
one `jsonHeaders` object for every request. `DELETE /api/v1/trash/:id` and
`POST /api/v1/trash/restore-all` take no body, so they must send the CSRF header
**without** `Content-Type` — `e2e-reset.mjs` exposes a `csrfOnlyHeaders` set for exactly
this. The symptom is deceptive: every such call answers `400` with a body about JSON
parsing, which reads like a payload bug rather than a header bug.

## 401 vs 403 on an unauthenticated mutating request

The CSRF check runs **before** the auth guard, so a mutating call with no session and no
`X-Requested-With` header answers `403 CSRF_REQUIRED`, not `401`. When asserting "this
endpoint requires a session", send the CSRF header — otherwise the test proves the CSRF
guard and silently says nothing about the session guard. `test/budget.test.ts:660-662`
and `test/trash.test.ts` both do it this way.

### …and do not build that header from `csrfOnlyHeaders`

`lib/e2e-reset.mjs` exports `csrfOnlyHeaders` as `{ 'X-Requested-With': 'fetch', Cookie: <session> }`
— CSRF header **plus a valid session**, because its purpose is bodiless writes while signed in.
Reusing it for a "requires a session" assertion therefore sends an authenticated request, and the
endpoint answers `200` / `400` / `404` instead of `401`. Because those are the responses a working
endpoint gives, **the suite reports a misleading pass-or-fail and never touches the session guard
at all**. This actually happened in the first version of `e2e-transfers.mjs`.

Build the header inline for these assertions:

```js
const noSession = { 'X-Requested-With': 'fetch' };   // deliberately NO Cookie
```

A useful tell: if an unauthenticated `GET` of a **list** endpoint answers `200`, the request was
authenticated — a list can only be non-empty by accident, and an empty one still means the guard
let it through.

---

## Merged import errors use dedicated stable codes within the existing envelope

Batch errors still serialize as `{error:{code,message}}`; they do not create a second response shape. Observed codes include `ASSISTANT_INVALID`, `IMPORT_BATCH_LIMIT_EXCEEDED`, `IMPORT_BATCH_DUPLICATE_FILE`, `IMPORT_BATCH_FILE_FAILED`, `IMPORT_BATCH_IDENTITY_CONFLICT`, `IMPORT_BATCH_CATEGORY_REQUIRED`, `IMPORT_BATCH_CATEGORY_CONFLICT`, `IMPORT_BATCH_STALE_VERSION`, `IMPORT_BATCH_IDEMPOTENCY_MISMATCH`, `IMPORT_BATCH_ALREADY_CONFIRMED`, `ASSISTANT_ACTION_STALE`, `ASSISTANT_NOT_FOUND`, and `ASSISTANT_GENERATION_ACTIVE`. Exact route/condition matrix and status behavior are recorded in [Merged Bill Import](./merged-bill-import.md).

Specific boundaries: a failed file remains inspectable but blocks review/confirm until explicitly removed/replaced; a live-view/ledger change is stale rather than a silent skip; limits reject the whole input rather than truncate; no internal stack or raw provider response belongs in the wire error.



- `reply.status(500).send({ error: error.message })` — leaks internals.
- Inventing a second error body shape (`{ message: ... }`, `{ error: "..." }`).
- Branching the HTTP response on *why* authentication failed.
- Throwing a bare `Error` for a condition the user can act on (use `ValidationError`).
- Catching an error only to re-throw it with a different status, adding no context.
- Logging a password, a session token, or a password hash.

---

## Testing requirements

- Every 4xx path has a test asserting **both** the status and the body shape.
- Login failure paths assert the bodies are *equal*, not merely both 401.
- A 5xx test asserts the internal message does **not** appear in the response.
- User-facing messages are asserted by content (e.g. `/at least/i`), so a reworded message
  that loses its meaning fails the suite.
- The `401`-not-`404` behaviour for an unknown `/api` path is asserted, so nobody
  "corrects" it into an enumeration surface.

## Assistant generation SSE exception
Generation events use authenticated text/event-stream; errors before headers retain JSON contract, after headers are durable safe terminal events. A transport disconnect is not a successful response or instruction to rerun the model. See [Assistant streaming](./assistant-streaming.md).
