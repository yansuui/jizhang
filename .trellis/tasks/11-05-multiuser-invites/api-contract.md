# Multi-user native API contract

Approved product scope; implementation coordination contract (2026-11-05).

- All paths below are under `/api/v1`. Existing mutation CSRF header remains `X-Requested-With: fetch`.
- `GET /auth/me`, `POST /auth/login` and `POST /auth/register` return `{ id: string, username: string, role: "admin" | "member", capabilities: string[], expiresAt: number }`. Times are epoch milliseconds. `capabilities` contains `manageInvitations` for administrators. Existing username/expiry fields remain.
- `POST /auth/register` body is `{ username, password, invitationCode }`. Success 201 creates a session using the same cookie as login. It must use a fresh client cookie scope and not trigger global session-expired handling on registration rejection. Password confirmation is client-only.
- Username: trimmed, 3–64 ASCII letters/digits/underscore/hyphen/dot, case-sensitive. Existing legacy usernames remain usable for login. Password: 8–128 characters, never trimmed by the client. Invitation code: trim outer whitespace only.
- `GET /admin/invitations` returns `{ invitations: Invitation[] }` (newest first, bounded server list).
- `POST /admin/invitations` accepts `{}` and returns 201 `{ invitation: Invitation, code: string }`; plaintext code is shown only at creation. Default single use, seven days.
- `DELETE /admin/invitations/:id` returns `{ ok: true }`; revokes an unconsumed invitation. Unknown/foreign identifiers return 404.
- `Invitation` is `{ id: string, createdAt: number, expiresAt: number, status: "active" | "used" | "expired" | "revoked", usedAt: number | null }`. No secret/code/hash in list rows.
- Error envelope remains `{ error: { code: string, message: string } }`. Registration: 400 `VALIDATION`/`WEAK_PASSWORD`/`INVALID_INVITATION`, 409 `USERNAME_TAKEN`, 429 `RATE_LIMITED`; admin authorization 403 `FORBIDDEN`. Clients display useful Chinese recovery guidance with server fallback.
- Accounts have private ledger and AI configuration. Administrator capability grants invitation management only, not access to another user's financial data.
- Native ownership uses normalized server + immutable `id` plus request generation. Legacy servers may omit new identity fields: permit existing login while keeping admin controls hidden; never replay unresolved legacy financial writes into a newly registered account.

## Backend implementation coordination

Identity worker owns `identity/**`, auth service/routes/plugin, invitation service/routes and identity/auth tests. Tenant worker owns `tenancy/**`, all business route groups, `app.ts`, `index.ts`, required business-service lifecycle changes and tenant tests. Root owns CLI/operations and Android until delegated.

Identity store will expose a typed lookup of immutable user ID to `{ userId, dbFile, dataDir }`, a separate identity DB handle and AuthService. Coordinate exported names directly between workers before cross-module wiring. No mutable global DB swap, per-user Fastify app, or SQL proxy.
