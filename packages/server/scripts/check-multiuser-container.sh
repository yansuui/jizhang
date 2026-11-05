#!/usr/bin/env bash
# Disposable CI resources only. Never use a production volume or deployment name.
set -euo pipefail
image=${JIZHANG_TEST_IMAGE:-jizhang-verification}
suffix="${GITHUB_RUN_ID:-local}-$$"
volume="jizhang-verification-${suffix}"
container="jizhang-verification-${suffix}"
env_args=(-e JIZHANG_USERNAME=owner -e JIZHANG_PASSWORD_HASH=fixture-only -e LOG_LEVEL=warn)
docker volume create "$volume" >/dev/null
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm "${env_args[@]}" -v "$volume:/data" --entrypoint node "$image" --input-type=module -e '
  const {loadConfig} = await import("/app/packages/server/dist/config.js");
  const {openDatabase, initializeDatabase} = await import("/app/packages/server/dist/db/index.js");
  const {openIdentityStore} = await import("/app/packages/server/dist/identity/store.js");
  const config = loadConfig();
  const db = openDatabase(config);
  initializeDatabase(db, null);
  const identity = openIdentityStore({config, legacyDb: db});
  await identity.bootstrapPassword("owner", "fixture-password-only");
  identity.close(); db.close();
'
docker run -d --name "$container" "${env_args[@]}" -p 127.0.0.1:18081:8081 -v "$volume:/data" "$image" >/dev/null
test "$(docker exec "$container" whoami)" = node
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18081/api/v1/health >/dev/null; then break; fi
  sleep 1
done
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:18081/api/v1';
const post = async (url, body, cookie = '') => {
  const response = await fetch(base + url, {method: 'POST', headers: {
    'content-type': 'application/json', 'x-requested-with': 'fetch', cookie,
  }, body: JSON.stringify(body)});
  assert.ok(response.ok, `${url}: ${response.status} ${await response.clone().text()}`);
  return {data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? ''};
};
const owner = await post('/auth/login', {username: 'owner', password: 'fixture-password-only'});
assert.equal(owner.data.role, 'admin');
const invitation = await post('/admin/invitations', {}, owner.cookie);
const member = await post('/auth/register', {username: 'member', password: 'fixture-password-only', invitationCode: invitation.data.code});
assert.equal(member.data.role, 'member');
assert.notEqual(member.data.id, owner.data.id);
const forbidden = await fetch(base + '/admin/invitations', {headers: {cookie: member.cookie}});
assert.equal(forbidden.status, 403);
for (const cookie of [owner.cookie, member.cookie]) {
  assert.equal((await fetch(base + '/accounts', {headers: {cookie}})).status, 200);
}
NODE
# A running server must prevent a coordinated backup from crossing live writes.
if docker exec "$container" node packages/server/dist/cli.js backup-all /data/full-backups; then
  echo 'Online complete backup unexpectedly bypassed the storage lock' >&2; exit 1
fi
docker stop "$container" >/dev/null
docker run --rm "${env_args[@]}" -v "$volume:/data" --entrypoint node "$image" --input-type=module -e '
  const {createSystemBackup, verifySystemBackup, restoreSystemBackup} = await import("/app/packages/server/dist/cli-system.js");
  const bundle = createSystemBackup("/data", "/data/full-backups");
  const manifest = verifySystemBackup(bundle);
  if (manifest.files.length !== 3) throw new Error("Expected identity and two ledgers");
  restoreSystemBackup(bundle, "/data/recovery-drill");
'
docker start "$container" >/dev/null
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18081/api/v1/health >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:18081/api/v1/health
docker stop "$container" >/dev/null

# Start the actual image against the restored directory, not just the original
# volume. A structurally valid bundle must also be usable by the server runtime.
docker rm "$container" >/dev/null
docker run -d --name "$container" "${env_args[@]}" -e DATA_DIR=/data/recovery-drill \
  -p 127.0.0.1:18081:8081 -v "$volume:/data" "$image" >/dev/null
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18081/api/v1/health >/dev/null; then break; fi
  sleep 1
done
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:18081/api/v1';
for (const username of ['owner', 'member']) {
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-requested-with': 'fetch'},
    body: JSON.stringify({username, password: 'fixture-password-only'}),
  });
  assert.equal(login.status, 200, `${username} must sign in after complete restore`);
  const identity = await login.json();
  assert.equal(identity.username, username);
  assert.equal(identity.role, username === 'owner' ? 'admin' : 'member');
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.equal((await fetch(base + '/accounts', {headers: {cookie}})).status, 200);
}
NODE
docker stop "$container" >/dev/null
