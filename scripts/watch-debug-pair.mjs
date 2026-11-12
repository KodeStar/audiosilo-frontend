#!/usr/bin/env node
// Mint a v1 `pair` message for the watch apps' debug sign-in (CONVENTIONS.md, "Apple Watch app"
// and "Wear OS app"). Signs in to a (scratch) server, asks it for a 10 minute pairing token for
// that user (`POST /auth/pair {"ttl_seconds":600}`, what the phone's Set up watch sends), signs
// its own session out again, and prints the message as one line of JSON:
//
//   node scripts/watch-debug-pair.mjs http://192.168.1.5:8080 admin 'password'
//
// Apple Watch simulator (a DEBUG build):
//   SIMCTL_CHILD_AUDIOSILO_DEBUG_PAIR="$(node scripts/watch-debug-pair.mjs ...)" \
//     xcrun simctl launch --terminate-running-process <watch-udid> app.audiosilo.watchkitapp
//
// Wear OS emulator (a debug build; the emulator reaches the host as 10.0.2.2):
//   adb -s <wear> shell am start -n app.audiosilo/app.audiosilo.wear.MainActivity \
//     --es debug_pair "'$(node scripts/watch-debug-pair.mjs http://10.0.2.2:8080 ...)'"
//
// The token is single use: mint a new message for every fresh sign-in.

const [base, username, password = process.env.AUDIOSILO_PASSWORD] = process.argv.slice(2);
if (!base || !username || !password) {
  console.error(
    'usage: watch-debug-pair.mjs <server-url> <username> [password | $AUDIOSILO_PASSWORD]',
  );
  process.exit(2);
}
const root = base.replace(/\/+$/, '');

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${root}/api/v1${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

try {
  const server = await call('GET', '/server');
  const session = await call('POST', '/auth/login', {
    body: { username, password, device_name: 'watch debug pair' },
  });
  const pairing = await call('POST', '/auth/pair', {
    token: session.token,
    body: { ttl_seconds: 600 },
  });
  await call('POST', '/auth/logout', { token: session.token });
  const message = {
    v: 1,
    type: 'pair',
    server_id: pairing.server_id ?? server.server_id,
    server_name: pairing.server_name ?? server.name ?? 'AudioSilo',
    user_id: session.user.id,
    user_name: session.user.username,
    base_url: pairing.base_url ?? root,
    server_url: root,
    addresses: pairing.addresses ?? session.addresses ?? {},
    pairing_token: pairing.pairing_token,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    phone_name: 'watch-debug-pair',
    // What the phone's Data Layer item carries (Wear echoes it in its receipt; Apple ignores it).
    sent_at: new Date().toISOString(),
  };
  console.log(JSON.stringify(message));
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
}
