# Multi-user invitation design — approved scope

Status: scope approved by the user on 2026-11-05. Implement and verify against synthetic fixtures; production data has not been changed.

## Change boundary

The missing behavior is account ownership across the existing API, followed by invitation registration. Authentication alone is insufficient: all current business routes share one SQLite database and stateful service graph. Keep monetary calculations and business rules in the existing shared/services layers.

The recommended implementation uses a separate central identity database and one ledger context per user. This preserves existing financial SQL, built-in IDs and unique constraints inside each ledger instead of introducing account predicates throughout 48 business tables. One Fastify application continues to register routes once; the authenticated request selects a ledger service context.

## Storage and identity

- Central identity store: immutable user ID, username, password hash, role/status, sessions, invitation hashes/expiry/revocation/consumption, migration version and ledger bindings. Use its own versioned schema/verification rather than confusing the existing ledger migration journal with authentication migrations.
- Existing `DATA_DIR/jizhang.db` stays bound to the original configured owner. New ledgers live under server-generated user-ID directories; no username, invitation, request path or client-supplied tenant identifier becomes a filesystem path.
- Preserve original owner identity and password. Import only the unambiguously identified configured legacy account; if legacy ownership is ambiguous, stop before exposing the API and require explicit operator resolution. Never make the first invited registrant an administrator.
- Once identity migration is committed, it is authoritative. Restart must not reimport stale ledger users/sessions or overwrite an already-changed central password. Legacy credential cleanup and migration completion must have repeatable recovery checks.
- Credential records must not leak through ordinary ledger backup/export. Central auth backups are administrative operational backups. Keep migration safety snapshots protected and separate from ordinary user backup listings.
- Existing category/account/template seed IDs may repeat across isolated ledger files. Do not clone the owner's ledger, provider key, import files, conversations or photos for new users.

## Registration and invitations

Suggested APIs, finalized together with native DTOs before implementation:

| Operation | Proposed route | Access |
|---|---|---|
| Register | `POST /api/v1/auth/register` | Public, CSRF header still required, valid invitation mandatory |
| Identity | Existing login and `GET /api/v1/auth/me` | Add actual user ID and role/capabilities, preserve username/expiry |
| List invitations | `GET /api/v1/admin/invitations` | Administrator |
| Create invitation | `POST /api/v1/admin/invitations` | Administrator; return plaintext code once |
| Revoke invitation | `DELETE /api/v1/admin/invitations/:id` | Administrator |

- Proposed MVP default: single-use, seven-day expiry; native create/copy/revoke with status, no complex permissions editor.
- Use a cryptographic random code with at least 128 bits of entropy, store its hash, bound input sizes and never include passwords/codes/provider keys in logs. Revocation/expiry/consumption checks happen again at the committing transaction, not just before password hashing.
- Reject client-provided role/capability escalation. Add request throttling before expensive password work. Unknown and incorrect login credentials retain the same response; use comparable password-verification work instead of the existing early configured-name shortcut.
- Username collision or failed provisioning must not consume a usable invitation. Registration success follows durable user activation, invite consumption and a fully initialized ledger. A lost response must not cause duplicate accounts; ordinary login can recover a successfully created account.
- Do not claim atomicity across SQLite WAL files. Prepare an unreachable fresh ledger first or use a persisted provisioning state, then use **one central transaction** to activate the user and consume the invitation with a conditional update. Faults before/after each phase require explicit retry/orphan handling; no active user can be routed to a partial or wrong ledger.

## Request, worker and stream ownership

- Resolve user from the session in the existing auth module. Derive ledger context solely from that immutable ID. Keep the guard and protected route registrars inside one Fastify encapsulation scope.
- Each context contains a real DB handle, personal data/backup directory, and lazily constructed reusable services. Do not swap a process-global DB pointer, rewrite SQL transparently, or create another Fastify server per user.
- Resolve the context in route handlers; never default an unresolved request to the owner database. Existing service methods operate only inside their selected ledger.
- Assistant runners, import/organization jobs, locks and subscriber maps belong to the context for their full lifetime. Recovery runs once when a context opens, not once per HTTP request. Pin contexts during requests/SSE/background jobs; release/drain work before idle eviction or shutdown closes the DB.
- Audit file paths beyond SQL: import comparisons, migration reports, backup lists and archive creation use the selected user's directory and actual DB path. CSV export is personal. Full identity/all-user backup and restore remain operator actions.
- The external cutout worker is an explicit additional boundary. Persist job owner mappings and check status, preview, result and cancel authorization before proxying to the worker. A random job ID alone is not authorization.
- Two-account tests must exercise reused natural/seed/request IDs, guessed foreign IDs, concurrent streams and background completion after account switching. Financial results continue using existing authoritative server calculations.

## Native clients

- iOS: extend auth DTO/session identity with additive user ID/capability fields; add compact registration sheet and administrator-only invitation management under My. Registration follows fresh-login cookie isolation, safe error presentation and API UUID root replacement.
- Android: add matching registration and capability-gated invitation UI, update public-auth 401 handling and discard prior account cookies. Scope cached state and pending financial operations to immutable user identity as well as server; do not replay old username-bound operations into a new account. Preserve documented existing feature behavior and update `clients/android/README.md`.
- Both: form fields are username/password/confirmation/invitation, with password visibility and copy/paste conveniences. Do not store form passwords/codes. Server permissions are authoritative even if someone forges UI state. Account switching replaces all feature ownership, not only the username label.
- This does not broaden the iOS accounting editing scope or reintroduce Web hosting.

## Migration and operations

1. Before serving requests, verify a consistent legacy backup and identify the original owner; never raw-copy a live WAL DB.
2. Initialize/migrate the identity DB, bind the original ledger, perform repeatable credential cutover and seed only new ledgers.
3. Update bootstrap/password CLI, backup/verify/restore commands and container mount assumptions to recognize identity plus multiple ledgers. Keep all tenant files under the existing persistent data volume.
4. Make coordinated offline backup/restore verifiable and prevent an old single-user binary from being treated as a safe automatic rollback after new-user writes. Preserve new ledgers if reverting service code; do not silently discard them.
5. Implement against synthetic legacy/two-user fixtures first. Source push and CI are authorized in the original repository; production cutover is a separate delivery step after reviewable migration evidence exists.

## Source-informed alternatives and evidence

- Shared DB with `user_id` everywhere: possible, but requires complete query/join/unique-key/reference/backfill coverage across all current business tables and SQL call sites; one omission leaks data. Keep as an alternative only if shared ledgers become an actual requirement.
- Central identity plus per-user ledgers: recommended for the proposed private-account scope; operational cost is coordinated migrations/backup and bounded stateful service lifetimes. Database separation alone does not secure the worker/files boundaries.
- [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) supports checks on every request and direct object reference, including non-HTML resources.
- [OWASP token guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) concerns password recovery; we apply its random, expiring, single-use token properties to invitations by analogy, not as a claim that it specifies this product.
- [SQLite ATTACH documentation](https://sqlite.org/lang_attach.html) warns that a crash can leave attached WAL databases at different commit states. Provisioning therefore needs recoverable phases around the central transaction.

Detailed source inventory and independent review are recorded in `research/`.
