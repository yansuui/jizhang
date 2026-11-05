# API deployment and migration

For the invitation/multi-user release, read [MULTIUSER.md](./docs/MULTIUSER.md) first.
It supersedes single-file backup/restore and online password-bootstrap steps below:
the server now holds an exclusive storage lock, identity is in `auth.db`, and full
recovery requires every mapped ledger. Existing production helpers and old image
rollback procedures require review before applying this release. No production
cutover is implied by source or CI verification.

Target: Android / HarmonyOS 4 APK -> `https://jz.yansuu1.xyz/api/v1/**` -> existing Caddy -> Fastify -> existing `/data`.
The supplied inventory shows `caddy` (`caddy:2`) uses **host networking**. Use `127.0.0.1:8081` and the host Caddy site example; do not apply the shared-network Caddy overlay to this server. Inspect the actual config mount/path before editing or reloading.
The image contains no Web UI. `/`, old page routes and static assets return JSON 404. Existing Caddy keeps ports 80/443 and TLS.

These Linux commands are a runbook, not evidence of deployment. Local Docker/Caddy and server access were unavailable during preparation. Image runtime, live data, DNS, HTTPS and APK checks remain required.

## No SSH: upload the API source bundle

Operational update: the operator has now built and trial-verified the new image and has SCP access as `ubuntu@jz.yansuu1.xyz`. The original source-upload procedure below remains for reproducibility. For the inspected final cutover use [CUTOVER-KNOWN-SERVER.md](./deploy/CUTOVER-KNOWN-SERVER.md) and its separately uploaded guarded helper; no image rebuild is needed for that helper.

The prepared package is `artifacts/jizhang-api-source-2026-10-09.tar.gz`, with a matching `.tar.gz.sha256` file. It includes server/shared source, build manifests, Docker/Compose files, `.env.example`, deployment tools and optional cutout source. It excludes Web/native clients, node_modules, dist, real environments, databases, backups, signing keys and repository/task data. It is a **source package**, not a prebuilt Docker image.

Recreate after source changes using Python 3.10+ (no Docker required):

```bash
python deploy/create-source-bundle.py --include-cutout --output artifacts/jizhang-api-source-2026-10-09.tar.gz
python deploy/create-source-bundle.py --verify artifacts/jizhang-api-source-2026-10-09.tar.gz
```

Upload **both files** through the server control panel/file manager into `/opt/jizhang-upload`. Use its Ubuntu terminal, not SSH. Unpack into a **new directory**, leaving the original Compose/environment files untouched:

```bash
cd /opt/jizhang-upload
sha256sum -c jizhang-api-source-2026-10-09.tar.gz.sha256
mkdir /opt/jizhang-api-2026-10-09
tar -xzf jizhang-api-source-2026-10-09.tar.gz -C /opt/jizhang-api-2026-10-09
cd /opt/jizhang-api-2026-10-09/jizhang-api-source
sha256sum -c SHA256SUMS
python3 deploy/create-source-bundle.py --verify /opt/jizhang-upload/jizhang-api-source-2026-10-09.tar.gz
docker version
docker compose version
docker compose config --quiet
JIZHANG_IMAGE=jizhang:api-2026-10-09 docker compose build jizhang
```

Stop on checksum, extraction, dependency, or build failure. This build creates the exact API tag without starting a new service or creating a production data volume. Use a host with sufficient memory/disk; if the server is too small, build on another machine and upload the image archive below. Optional cutout source does not build/start unless requested.

After building, follow **all** existing-installation, backup/restore and migration steps below before `up`. Copy the original protected environment into the new directory only after inspection; do not initialize the old ledger from example credentials. Use the exact external-volume/bind overlay. This server's host-network Caddy needs no shared-network overlay. Current packaging/config validation does not establish engine-tested build or server acceptance.

## Prepare an image on another machine

Use Docker with Compose **2.24+** (`env_file.required` requires 2.24). Build on a machine with enough memory and matching the server architecture; a 1 GB VPS is unsuitable for native dependency/image builds. From the repository root:

```bash
docker version
docker compose version
docker compose config --quiet
JIZHANG_IMAGE=jizhang:api-2026-10-09 docker compose build jizhang
docker save -o jizhang-api-2026-10-09.tar jizhang:api-2026-10-09
# Transfer the tar file through the available server panel/file upload.
# No SSH access is currently available; use the server's Ubuntu terminal.
# On the server:
docker load -i /opt/jizhang/jizhang-api-2026-10-09.tar
```

Registry push/pull is an alternative. Set `JIZHANG_IMAGE` to the tested tag; retain the old image separately. Transfer `.env.example`, all `docker-compose*.yml` and `deploy/` too. Server startup uses `--no-build`.

## Inspect the existing installation

Find the application container and actual Caddy topology. Inspect specific fields only: full container inspection or `compose config` without `--quiet` can disclose secrets.

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
OLD_CONTAINER=jizhang # change to the actual old application container
# Record mount type, Name/Source and Destination; identify the real database mount.
docker inspect --format '{{range .Mounts}}{{printf "%s %s %s -> %s\n" .Type .Name .Source .Destination}}{{end}}' "$OLD_CONTAINER"
docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$OLD_CONTAINER"
docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$OLD_CONTAINER"
docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$OLD_CONTAINER"
docker inspect --format '{{.Config.User}}' "$OLD_CONTAINER"
df -h
```

Record the original Compose project/files, service, mount and Caddy config path. Obtain the old `.env` securely, without printing it. Preserve original username, authentication configuration, session TTL, `TZ` and **the exact `JIZHANG_AI_ENCRYPTION_KEY`**. That key is outside SQLite; replacing it makes saved provider secrets unreadable. Keep protected original environment/config copies for rollback. Do not replace old credentials with the example defaults.

Set the new `.env`, preserving all original runtime settings:

```dotenv
JIZHANG_IMAGE=jizhang:api-2026-10-09
# Named-volume case: exact Name of the inspected old /data mount.
JIZHANG_DATA_VOLUME=actual-existing-volume-name
# Bridge-network Caddy only, not the current host-network Caddy:
# JIZHANG_CADDY_NETWORK=actual-existing-caddy-network
```

Named-volume upgrades always include `docker-compose.migration.yml`. Its external lookup fails if the exact volume is missing, regardless of project name. Verify with `docker volume inspect actual-existing-volume-name`. Do not guess `jizhang-data`: Compose normally prefixes it.

If mount Type is **bind**, use `docker-compose.bind.yml` **instead of** the migration overlay and set `JIZHANG_DATA_BIND` to the exact absolute Source. It refuses to create a missing directory. Preserve existing ownership; runtime `node` is UID/GID 1000. Never recursively chown an uninspected path. If old DATA_DIR is not `/data`, resolve its actual database and mount before adapting these commands.

## Backup and isolated restore drill

Stop writes for a short maintenance window. These examples assume the inspected named-volume `/data`; for bind use the exact absolute host path as `DATA_MOUNT_SOURCE` and verify that directory instead of `docker volume inspect`.

```bash
DATA_MOUNT_SOURCE=actual-existing-volume-name
# Confirm first: docker run -v would create a missing named volume.
docker volume inspect "$DATA_MOUNT_SOURCE" >/dev/null
MIGRATION_DIR="/opt/jizhang/migration-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$MIGRATION_DIR/data"
chmod 700 "$MIGRATION_DIR"
cp .env "$MIGRATION_DIR/original.env" # the securely preserved OLD env
chmod 600 "$MIGRATION_DIR/original.env"
# Copy original Compose files and Caddy config here too; do not publish them.
OLD_IMAGE="jizhang:rollback-$(date +%Y%m%d-%H%M%S)"
OLD_IMAGE_ID=$(docker inspect --format '{{.Image}}' "$OLD_CONTAINER")
docker tag "$OLD_IMAGE_ID" "$OLD_IMAGE"
printf '%s\n' "$OLD_IMAGE" > "$MIGRATION_DIR/old-image.txt"
docker stop "$OLD_CONTAINER"
# Stop any other writers sharing this database before continuing.
docker run --rm --env-file "$MIGRATION_DIR/original.env" \
  -e NODE_ENV=production -e DATA_DIR=/data \
  -v "$DATA_MOUNT_SOURCE:/data" "$OLD_IMAGE" \
  node packages/server/dist/cli.js backup /data/backups/pre-api 0
# CLI uses VACUUM INTO: includes WAL commits, self-verifies, no pruning.
# With ALL writers stopped, archive the whole /data including old backups.
docker cp "$OLD_CONTAINER:/data/." "$MIGRATION_DIR/data/"
```

Choose `BACKUP_FILE` from the successful output (basename only), not a guessed older snapshot. Photographs are SQLite BLOBs and included in the snapshot. The full archive protects old backups and any additional files. Copy the protected migration directory off-server too.

```bash
BACKUP_FILE=jizhang-YYYY-MM-DDTHH-MM-SS-mmm.db
RESTORE_VOLUME="jizhang-restore-drill-$(date +%Y%m%d-%H%M%S)"
docker volume create "$RESTORE_VOLUME"
docker run --rm --env-file "$MIGRATION_DIR/original.env" \
  -e NODE_ENV=production -e DATA_DIR=/data \
  -v "$RESTORE_VOLUME:/data" -v "$MIGRATION_DIR:/migration:ro" "$OLD_IMAGE" \
  node packages/server/dist/cli.js restore "/migration/data/backups/pre-api/$BACKUP_FILE"
docker run --rm -v "$RESTORE_VOLUME:/data:ro" -v "$PWD/deploy:/tools:ro" "$OLD_IMAGE" \
  node /tools/db-manifest.mjs /data/jizhang.db > "$MIGRATION_DIR/restored-manifest.json"
docker run --rm -v "$MIGRATION_DIR:/migration:ro" -v "$PWD/deploy:/tools:ro" "$OLD_IMAGE" \
  node /tools/db-manifest.mjs "/migration/data/backups/pre-api/$BACKUP_FILE" > "$MIGRATION_DIR/backup-manifest.json"
diff -u "$MIGRATION_DIR/backup-manifest.json" "$MIGRATION_DIR/restored-manifest.json"
```

Successful restore, integrity `ok` and matching table counts/digests are the drill evidence. The manifest utility logs no rows, keys or tokens. Keep the drill volume until acceptance. On failure restart the unchanged old container and investigate; do not upgrade using an unverified backup. CLI loopback checks cannot detect a different container writing the same volume: stop **every** writer.

## Start the API with preserved data

In Bash, retain an array so every command includes the correct overlay:

```bash
compose=(docker compose -f docker-compose.yml -f docker-compose.migration.yml)
# Bind: replace migration.yml with docker-compose.bind.yml.
# Bridge-network Caddy only: append -f docker-compose.caddy.yml.
# Current server's host-network caddy: do not append the Caddy overlay.
"${compose[@]}" config --quiet
```

If using the old Compose project, set `COMPOSE_PROJECT_NAME` to its inspected name and keep service/container names so Compose replaces the old stopped container. A different project with the same `container_name` conflicts: after backup/image/config recording, rename the old container (e.g. `docker rename "$OLD_CONTAINER" jizhang-pre-api`) and record the new name for rollback. Never start old and new against the same data together.

```bash
"${compose[@]}" up -d --no-build --force-recreate jizhang
"${compose[@]}" exec -T jizhang whoami               # node
curl -fsS http://127.0.0.1:8081/api/v1/health
curl -sS -D - http://127.0.0.1:8081/                   # 404 application/json
curl -sS -D - http://127.0.0.1:8081/dashboard          # 404 application/json
"${compose[@]}" exec -T jizhang node deploy/db-manifest.mjs /data/jizhang.db \
  > "$MIGRATION_DIR/new-manifest.json"
```

Compare old/new manifests **before new writes**. Migrations can legitimately add tables/columns: investigate changes against the actual migrations rather than accepting unexplained differences. Confirm existing ledger, salary allocations, budgets, conversations and photographs in the APK. Roll back if health/login/data fail.

For a **brand-new installation** only, use the base Compose file, which initializes a project-scoped volume. Create `.env` from the example, then provision the login interactively after startup:

```bash
docker compose exec -it jizhang node packages/server/dist/cli.js set-password
```

The environment password hash is a boot validation setting, not a database login provisioner. Existing users remain in the old database; an upgrade needs no password reset.

## Existing Caddy: actual topology determines upstream

Replace only the `jz.yansuu1.xyz` site block. Remove its old SPA/file_server fallback and proxy the complete URI. Preserve other domains, global settings, imports and certificate storage. DNS A/AAAA must resolve to this server and its existing 80/443 must reach Caddy. A prior local probe concerned the superseded `.com` domain. Verify the confirmed `.xyz` domain on the server/public resolvers before requesting TLS.

**Current server: host-network Caddy container.** The supplied inventory records `caddy:2` with network `host`, `jizhang:64be4b1` on `jizhang_default` and `jizhang_cutout-internal`, and `jizhang-cutout:64be4b1` on the internal network. `komari` is unrelated and must remain untouched. The old `64be4b1` tag is rollback inspection evidence, not the new API image tag. Data mounts and Caddy config paths are still unconfirmed.

Host networking shares the host's network namespace. Merge [Caddyfile.host.example](./deploy/Caddyfile.host.example), upstream `127.0.0.1:8081`. Use base Compose plus the inspected data migration/bind overlay, **without** `docker-compose.caddy.yml`; retain existing Caddy host networking and other site blocks. After inspecting its actual config path/mount, validate and reload inside the existing container:

```bash
CADDY_CONTAINER=caddy
# Set to the verified path INSIDE this container; no config path is assumed.
CADDY_CONFIG=/actual/inspected/path/Caddyfile
docker exec "$CADDY_CONTAINER" caddy validate --config "$CADDY_CONFIG" --adapter caddyfile
docker exec "$CADDY_CONTAINER" caddy reload --config "$CADDY_CONFIG" --adapter caddyfile
```

**Alternative: Caddy as a host service.** Use the same host site example and loopback upstream. Inspect its actual systemd unit/config first. Typical commands, only if matching that installation:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

**Alternative: bridge-network Caddy container.** Merge [Caddyfile.container.example](./deploy/Caddyfile.container.example), use the Caddy Compose overlay. Set `JIZHANG_CADDY_NETWORK` to the existing shared network and ensure alias `jizhang-api` has no collision. Persist that network in the **existing Caddy's** Compose config; an ad-hoc network connection is lost when it is recreated. API diagnostics remain loopback-only. In bridge networking, Caddy's `127.0.0.1` points to its own namespace, so use `jizhang-api:8081`. This alternative does not apply to the supplied host-network server inventory.

```bash
CADDY_CONTAINER=actual-caddy-container
# Confirm the actual config path/mount first.
docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Validate using the existing service's modules, environment and permissions. Some modules reserve exclusive resources during provisioning; inspect module guidance if validation conflicts rather than stopping all sites. Graceful reload retains active configuration if new provisioning fails. Recheck all other sites after reload.

Caddy automatically forwards `X-Forwarded-Proto`. Keep `TRUST_PROXY=true` with this private upstream, without exposing 8081 publicly or overriding proxy headers indiscriminately.

## Optional cutout

Default Compose starts only the API. Item CRUD/photo upload works without inference. On an adequately sized host, set `JIZHANG_ITEM_CUTOUT_SERVICE_URL=http://jizhang-cutout:8090` and a tested `JIZHANG_CUTOUT_IMAGE`, then build/transfer the worker separately:

```bash
docker compose --profile cutout build jizhang-cutout
# On the server with the chosen overlays:
"${compose[@]}" --profile cutout up -d --no-build --force-recreate jizhang jizhang-cutout
```

The worker has no public ports: internal network, 3 GB memory/swap cap, 2 CPUs and 512 MB temporary image tmpfs. Do not impose it on a 1 GB server. Outage shows a cutout error while ordinary upload remains available. To disable, unset the URL, recreate the API and stop the worker. Preserve an existing worker only after resource/compatibility checks.

## HTTPS and APK acceptance

Run the read-only API retirement probe locally, then against the real domain. It checks health, JSON 404 for old Web paths and absence of HTML; it performs no ledger writes:

```bash
node packages/server/scripts/check-api-only.mjs http://127.0.0.1:8081
node packages/server/scripts/check-api-only.mjs https://jz.yansuu1.xyz
```

Run from a source checkout (the runtime image does not contain server test scripts).

```bash
curl -fsS https://jz.yansuu1.xyz/api/v1/health
curl -sS -D - https://jz.yansuu1.xyz/                 # JSON 404, no HTML
curl -sS -D - https://jz.yansuu1.xyz/login            # JSON 404, no HTML
```

In the APK verify login, process restart/session restoration, historical data/photos, encrypted AI configuration, new transaction -> budget change, imports/exports, logout and expired-session return to login. Check HTTPS login's `Secure`, `HttpOnly`, SameSite and TTL attributes without logging cookie values. Mutations require `X-Requested-With: fetch`; bodiless POST must omit JSON Content-Type. Verify CSRF and unauthenticated rejection separately. Keep TLS verification enabled.

## Rollback

Stop the new API and **all writers**. If users wrote after migration, preserve a new consistent snapshot first; reverting to the pre-upgrade ledger needs reconciliation of later writes. Changing only the image does not roll back schema migrations.

```bash
"${compose[@]}" stop jizhang
docker run --rm --env-file "$MIGRATION_DIR/original.env" \
  -e NODE_ENV=production -e DATA_DIR=/data \
  -v "$DATA_MOUNT_SOURCE:/data" "$OLD_IMAGE" \
  node packages/server/dist/cli.js restore "/data/backups/pre-api/$BACKUP_FILE"
```

Restore original Compose/environment files and recorded project/image tag, then start the old service with `--no-build --force-recreate`, or start the retained renamed old container after releasing the new port. Restore this site's old Caddy block only if changed; validate/reload, then verify old health/login/ledger and other sites. CLI restore removes stale WAL/SHM and keeps a safety copy. Rollback uses the verified snapshot, not that safety copy; the full cold archive protects other files.

Never use `docker compose down -v`, volume pruning or guessed empty production volumes for migration. Retain old image/config, protected off-server backup and drill evidence until Android/server acceptance.

## Official references

Checked 2026-10-09: [Docker host networking](https://docs.docker.com/engine/network/drivers/host/), [external volumes and exact names](https://docs.docker.com/reference/compose-file/volumes/), [Compose service/env_file/profile options](https://docs.docker.com/reference/compose-file/services/), [Caddy URI and forwarded headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [Caddy validate/reload](https://caddyserver.com/docs/command-line).
