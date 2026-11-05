# Multi-user identity and invitation registration

## 1. Scope / trigger

Use this contract when changing authentication, registration, ownership, account
provisioning or deployment migration. Each account has a private ledger and AI
configuration. Administrator privilege allows invitation management only; it does
not grant access to other accounts' financial data.

## 2. Signatures

`identity/store.ts` exports `openIdentityStore({ config, legacyDb, now? }): IdentityStore`
and `IDENTITY_DB_FILENAME = 'auth.db'`. `legacyDb` is the already initialized original
ledger and remains caller-owned. The store exposes:

- `db`, `dbFile`, `authService`, `close()`.
- `getLedger(userId): { userId, dbFile, dataDir } | undefined` and `listLedgers()`.
- `bootstrapPassword(username, password): Promise<string>` for operator bootstrap/reset.
- `register(username, password, invitationCode): Promise<UserRow>`.
- `createInvitation(userId)`, `listInvitations(userId)`, `revokeInvitation(userId, id)`.

The central schema uses `identity_migrations(version, applied_at)`, currently version 1;
`users` contains `role` (`admin`/`member`) and `status` (`active`/`disabled`); `sessions`
holds token hashes. `ledger_bindings(user_id, storage_key, created_at)` stores `owner`
for the original file, otherwise a validated UUID matching `user_id`. Relative keys
allow restoring a complete deployment to a new data directory.

`identity_metadata(key, value)` records `legacy_import_complete`, `original_owner_id`
and an optional relative `legacy_snapshot` path. `invitations` contains code hash,
issuer, creation/expiry/revocation/redemption timestamps and the consuming user.
`ledger_provisions(user_id, created_at)` identifies unreachable staging directories.
`cutout_job_owners(job_id, user_id, created_at)` authorizes external worker proxies.

## 3. Contracts

All routes below use `/api/v1`. Existing mutation CSRF header remains
`X-Requested-With: fetch`. The auth hook and every protected registrar share the
same Fastify module. `identityStore` must be supplied to enable registration and
admin routes; legacy isolated test mode cannot expose registration.

| Route | Input | Success |
|---|---|---|
| `POST /auth/login` | `{username,password}` | 200 identity and session cookie |
| `GET /auth/me` | Session cookie | 200 actual session identity |
| `POST /auth/register` | `{username,password,invitationCode}` only | 201 identity and session cookie |
| `GET /admin/invitations` | Admin session | `{invitations: Invitation[]}` |
| `POST /admin/invitations` | Empty object or no body | 201 `{invitation,code}` |
| `DELETE /admin/invitations/:id` | Admin session, own invitation ID | `{ok:true}` |

Identity is `{id,username,role,capabilities,expiresAt}`; capabilities are
`['manageInvitations']` for admins and `[]` for members. Times are epoch milliseconds.
Invitation is `{id,createdAt,expiresAt,status,usedAt}`. Status is `active`, `used`,
`expired` or `revoked`; `usedAt` is nullable. Plaintext codes appear only once, in
the create response, never in list rows or logs. Codes use 32 random bytes and
SHA-256 storage; each permits one registration and expires after seven days.
The newest-first list includes all outstanding invitations plus the 100 newest
history rows, bounded at 200; old active codes cannot disappear behind recent history.

Username registration accepts trimmed ASCII `[a-zA-Z0-9_.-]{3,64}` and is
case-sensitive. Passwords are never trimmed: new passwords require 8–128 UTF-16
code units. Existing login/current-password values remain usable within the route
body limit, preserving old passwords longer than the new registration policy.
Auth JSON bodies are limited to 4096 bytes; invitation creation to 1024 bytes.

### Migration and crash recovery

Before cutover, the sole legacy account must match `JIZHANG_USERNAME`; ambiguity
fails closed. A WAL-safe `VACUUM INTO` snapshot in `.identity-migration-backups/`
is checked for SQLite integrity and owner hash before central transfer. The original
ID/password/ledger stay intact. Central metadata, administrator identity and owner
binding commit together, then legacy users/sessions are cleared. Existing sessions
expire during this upgrade. Later starts do not import stale hashes or reinterpret
the owner when `JIZHANG_USERNAME` changes. The snapshot is operational evidence,
not a runtime dependency after completed migration.

Fresh installations remain unconfigured until operator `bootstrapPassword` creates
the configured original administrator. Public registration never bootstraps an admin.
Passwords for later existing accounts can be reset, but the CLI cannot create a new
uninvited member. Central and ledger files stay inside the persistent data volume.

Registration validates a usable invite, hashes the password, revalidates the invite
and username, records a generated UUID provision, initializes/closes a fresh seeded
ledger, then atomically inserts user/binding and consumes the invite in `auth.db`.
Failure before activation leaves the invite usable and cleans the provisional
directory. Startup retries persisted cleanup. Cleanup checks that no committed
binding exists before removing a directory. Failure after commit preserves the
account and consumed invite; the user recovers by ordinary login.

Do not claim cross-file WAL atomicity. Full recovery needs central identity and all
mapped ledgers together; restoring a user's ledger cannot restore central credentials.
Old single-user binaries are not a safe rollback for multi-user writes.

## 4. Validation and error matrix

| Condition | HTTP / code |
|---|---|
| Wrong/missing login credentials or disabled user | 401 `INVALID_CREDENTIALS` |
| Missing/expired session | 401 `UNAUTHORIZED` |
| Missing mutation CSRF header | 403 `CSRF_REQUIRED` |
| Ordinary user accesses invitation administration | 403 `FORBIDDEN` |
| Malformed username/body or extra registration permission fields | 400 `VALIDATION` |
| New password outside bounds | 400 `WEAK_PASSWORD` |
| Invalid/expired/revoked/used invite, or disabled issuer | 400 `INVALID_INVITATION` |
| Existing username after valid invite check | 409 `USERNAME_TAKEN` |
| Revoking an already used invitation | 409 `INVITATION_USED` |
| Unknown/foreign invitation ID | 404 `NOT_FOUND` |
| Auth limit or 100 outstanding invitations | 429 `RATE_LIMITED` |
| Oversized auth JSON body | 413 |
| Unexpected DB/provisioning failure | 500, generic error message |

The process-local limiter permits per IP 20 login attempts/15 minutes, 5 registration
attempts/hour and 10 password changes/hour. It also bounds concurrent auth work to
8, overall attempts to 300/15 minutes, and remembered address buckets to 4096.
Expired buckets are removed; excess work is refused before hashing. Restart resets
these in-memory counters. Deployment-wide abuse controls may additionally live in
the existing reverse proxy; client-supplied usernames are never a lockout key.

## 5. Good / base / bad cases

- Good: owner creates an invite; member redeems it and receives only a fresh seeded
  ledger. Their cookie resolves to their immutable ID, and admin endpoints deny them.
- Base: old owner upgrades, signs in again with the same password, and sees unchanged
  categories, ledger records and provider settings. Password reset affects their sessions only.
- Bad: two requests redeem the same code, a client posts `role:'admin'`, or a guessed
  foreign job ID reaches a shared worker. Exactly one registration may activate;
  role injection and foreign resources must be rejected before side effects.

## 6. Required tests

`test/identity.test.ts` covers file-backed migration/restart, preserved owner rows,
ambiguous ownership, bootstrap, provisional cleanup, concurrent single use, expired/
revoked/disabled-issuer codes, no secret in lists, weak/colliding registration,
faults before and after activation, individual session invalidation, CSRF/admin
authorization, body limits and limiter expiry/concurrency. `test/auth.test.ts`
retains existing password/session/error compatibility. Tenant isolation tests must
also cover every business route family and external file/worker/SSE boundaries.
Passing source tests is separate from a real native device or production migration.

## 7. Wrong vs correct

Wrong: add `/auth/register` while all routes still capture the original `db`; a second
login then inherits the owner's entire ledger. Correct: enable registration only
with central immutable identity and explicit per-user ledger/service resolution.

Wrong: copy a live `.db` file or consume a code before ledger initialization and
describe it as atomic. Correct: use WAL-safe snapshots, persist unreachable provision
state, and commit activation plus consumption in the central transaction only after
the new ledger is initialized; preserve and recover every boundary explicitly.
