# Invite-only accounts and recovery

The server uses central `DATA_DIR/auth.db` and one ledger per account. The original
configured account becomes an administrator and retains `DATA_DIR/jizhang.db`,
including AI configuration. New accounts receive empty seeded ledgers under
`DATA_DIR/users/<immutable-user-id>/jizhang.db`; they inherit no owner records or
AI credentials. Administrator permission manages invitations only, not other users' data.

Codes are shown once, expire in seven days and admit one registration. Revocation
and consumption are server-enforced. After a lost registration response, try login
with the chosen credentials. Password rotation invalidates only that account's sessions.

## Upgrade and bootstrap

Keep a verified pre-upgrade backup, old image and protected configuration. Preserve
`JIZHANG_AI_ENCRYPTION_KEY` exactly. The sole matching legacy owner is migrated once;
ambiguous ownership stops startup. Existing sessions are invalidated. Legacy
credential rows are retired after central identity commits. Migration snapshots in
`.identity-migration-backups` contain sensitive legacy credentials: protect them
and keep them outside ordinary user backup listings.

The server and maintenance writers hold exclusive `.jizhang-storage.lock`.
Stop every server/replica/writer before `set-password` or `backup-all`. After a
crash, verify that all writers are stopped before manually removing a stale lock.
PIDs from different containers cannot establish staleness. Never remove an active lock.

For fresh setup, run the interactive password CLI before starting the server.
For reset, `JIZHANG_USERNAME` selects an existing account. It cannot reassign the
original ledger or create another administrator. Use the deployment's exact
Compose overlays and protected environment for every command:

```bash
docker compose stop jizhang
docker compose run --rm jizhang node packages/server/dist/cli.js set-password
docker compose up -d jizhang
```

These are operator instructions, not evidence of production deployment or device acceptance.

## Personal snapshots and full recovery

The authenticated `/backups` API snapshots only the current account's ledger,
including its encrypted AI configuration. It excludes central identity. A personal
file alone cannot recover the multi-user service. Legacy CLI `backup` and `restore`
refuse a multi-user deployment rather than silently back up only the owner.

Use a maintenance window for a full recovery bundle:

```bash
docker compose stop jizhang
docker compose run --rm jizhang node packages/server/dist/cli.js backup-all /data/system-backups
# Keep the printed bundle directory.
docker compose run --rm jizhang node packages/server/dist/cli.js verify-all /data/system-backups/<bundle>
docker compose up -d jizhang
```

`backup-all` uses `VACUUM INTO` for central identity and every bound ledger, then
records SHA256 hashes in a versioned manifest. Verification checks integrity,
required tables, foreign keys and all ledger bindings. No automatic deletion or
retention is applied to full bundles. Protect them as credentials-bearing material
and preserve the matching encryption key separately. The historical production
backup wrapper uses the single-file CLI; review it for this offline procedure
before operational use.

Restore into a new, empty directory, preserving the current deployment:

```bash
node packages/server/dist/cli.js restore-all /protected/bundle /protected/recovered-data
```

Restore verifies the bundle before writing, checks copied hashes, retains relative
bindings and invalidates sessions. An interrupted restore leaves
`.jizhang-restore-in-progress`; the server refuses that directory. Retry into a
different empty directory and preserve the partial copy for diagnosis. Point
`DATA_DIR` or the container mount at the completed recovery, preserve the original
key and verify both accounts' logins, totals, AI settings and photos.

Old single-user images are not transparent rollbacks after new accounts exist.
Keep the entire new data tree and use a matching multi-user image or reviewed
offline restore. Never run old password/restore tools against the new tree.
