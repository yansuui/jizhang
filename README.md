# jizhang

Invite-only accounting with private per-user ledgers, native Kotlin/Compose Android and SwiftUI iPhone clients, a Fastify API and SQLite. Android also targets HarmonyOS 4. The backend serves the API; this repository no longer contains the retired Web client.

The existing server was previously recorded as running the older Web Docker image. Repository changes do **not** establish that production has been upgraded; server and device acceptance remain separate. See [DEPLOY.md](./DEPLOY.md) for delivery, existing-data migration and rollback.

## Features and contracts

See [Android current feature inventory](./clients/android/README.md) for the maintained, source-backed page, field, action, API and known-gap catalogue. The [UI redesign plan](./clients/android/ui-redesign/README.md) describes intended design and is not proof of current implementation.

The [iOS client](./clients/ios/README.md) prioritizes AI conversations and compact provider configuration, with read-only native presentation of the other accounting domains. Its GitHub macOS workflow tests and builds an unsigned IPA for local Sideloadly signing. iOS feature scope and validation are tracked separately from Android.

- Transactions, refunds, accounts, tags, transfers and recycle bin.
- Salary allocations, budget templates, historical cycles and carryover pool.
- Recurring rules, explicit generation, confirmation and ignore.
- Statistics, CSV and WeChat/Alipay portability, consistent SQLite backups.
- AI conversations and confirmation before writes; encrypted provider credentials.
- Personal items, photographs and optional private cutout inference.
- Native navigation, system/light/dark appearance and color presets.
- Invitation registration, original-account administration, and private ledger/AI configuration per user. See [multi-user migration and recovery](./docs/MULTIUSER.md).

Money is integer cents; timestamps are epoch milliseconds. Server/shared owns all budget and aggregation rules; Android displays responses. `TZ=Asia/Shanghai` governs the server calendar. Transfers move money between accounts without counting as transaction income or expense. Refunds are income transactions and do not reduce ordinary gross spending. The four-purpose financial execution view is separate and nets only confirmed refund splits. See [USAGE.md](./USAGE.md) for user-facing accounting notes.

## Repository

| Path                           | Responsibility                                              |
| ------------------------------ | ----------------------------------------------------------- |
| `clients/android/`             | Kotlin + Compose APK                                        |
| `clients/ios/`                 | SwiftUI iPhone app, XCTest and unsigned IPA build            |
| `clients/README.md`            | Client status and validation                                |
| `packages/server/`             | Fastify API, SQLite, auth and maintenance CLI               |
| `packages/shared/`             | Pure accounting/date/portability contracts                  |
| `packages/cutout/`              | Optional private inference worker                           |
| `Dockerfile`                   | Server/shared build, Node 22 non-root runtime               |
| `docker-compose.yml`           | Loopback API, persistent data, opt-in cutout profile        |
| `docker-compose.migration.yml` | Exact existing external data volume                         |
| `docker-compose.bind.yml`      | Existing bind-mount alternative                             |
| `docker-compose.caddy.yml`     | Alternative bridge-network Caddy connection                 |
| `deploy/`                      | Caddy examples and read-only backup comparison              |

HarmonyOS sources remain a separate client and are outside this repository simplification task.

## API development

Node.js >= 22.12 and pnpm 10.12.2 are required. From the root:

```bash
pnpm install --frozen-lockfile
cp .env.example packages/server/.env
# Edit packages/server/.env and use an isolated DATA_DIR for development.
pnpm dev
```

The root development command builds shared first and then watches both shared and server sources, so changes to shared accounting logic are rebuilt. Ensure the local `.env` points to a disposable development data directory when testing mutations.

Health is `http://127.0.0.1:8081/api/v1/health`. Copying `.env` does not create a database login: build the server, then run `node dist/cli.js set-password` from `packages/server` in an interactive terminal so the CLI and server use the same local `.env` and data directory. Existing upgrades preserve login. Gitignored `.env` is read locally outside production; Compose uses its own root configuration and injects container settings.

```bash
pnpm --filter @jizhang/shared build
pnpm --filter @jizhang/shared test
pnpm --filter @jizhang/server lint
pnpm --filter @jizhang/server typecheck
pnpm --filter @jizhang/server test
pnpm --filter @jizhang/server build
```

Android builds from `clients/android` using `gradlew.bat :app:assembleDebug :app:lintDebug` (Windows) or `./gradlew` (Linux/macOS). Release signing belongs to the owner; keep keys/secrets outside Git and Docker contexts. APK build success does not establish device usability.

iOS builds in GitHub Actions or Xcode on a Mac. See [iOS build and installation](./clients/ios/README.md) for the exact workflow, artifact verification and local Sideloadly steps. Apple credentials stay on the signing computer. A successful IPA build is distinct from installation and device acceptance.

## Docker

For a **new local/disposable instance**, initialize `.env` then:

```bash
docker compose config --quiet
docker compose build jizhang
docker compose run --rm jizhang node packages/server/dist/cli.js set-password
docker compose up -d --force-recreate jizhang
curl -fsS http://127.0.0.1:8081/api/v1/health
```

For the **existing server**, follow [DEPLOY.md](./DEPLOY.md): inspect the original mount, preserve credentials/AI encryption key, verify restored backups, and include the migration/bind overlay on every command. API publishes only `127.0.0.1:8081`; existing Caddy retains 80/443. The supplied inventory shows the `caddy` container uses **host networking**, so it uses loopback and needs no Caddy shared-network overlay. Validate/reload with `docker exec caddy` after confirming its config path. The alternative bridge-network Caddy example uses a shared network and `jizhang-api:8081`. No new proxy/TLS container is created.

Cutout is opt-in: set its URL and use `--profile cutout` on an adequately sized server. It retains a private network, no published ports and resource limits. Ordinary item/photo operations work without inference.

SQLite and historical backups live in `/data`; photos are SQLite BLOBs. Never copy a live database alone: CLI backup produces a WAL-consistent snapshot. Restore requires every writer stopped. Retain protected off-server backups and old image/configuration for schema-compatible rollback.
