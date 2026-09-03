const test = require('node:test');
const assert = require('node:assert/strict');
const { createBridgeClient } = require('../addon/content/bridge-client.js');

function harness(handshake = { protocol: 1, url: 'http://127.0.0.1:54321', token: 'a'.repeat(43) }) {
  const requests = [];
  let launches = 0;
  let killed = 0;
  let chunks = [JSON.stringify(handshake).slice(0, 20), JSON.stringify(handshake).slice(20) + '\n'];
  const client = createBridgeClient({
    serverID: () => 'library-a',
    launch: async () => {
      launches += 1;
      return {
        read: async () => chunks.shift() || '',
        stop: async () => { killed += 1; },
      };
    },
    request: async (url, options) => {
      requests.push({ url, ...options });
      return { status: 200, data: { ok: true, result: { zotero: { server_id: 'library-a' } } } };
    },
  });
  return { client, requests, launches: () => launches, killed: () => killed };
}

test('concurrent RPC shares one private child and binds the originating library', async () => {
  const h = harness();
  await Promise.all([h.client.rpc('health', {}), h.client.rpc('item_context', { item_key: 'PARENT23' })]);
  assert.equal(h.launches(), 1);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].url, 'http://127.0.0.1:54321/rpc');
  assert.equal(h.requests[0].headers.Authorization, 'Bearer ' + 'a'.repeat(43));
  assert.equal(h.requests[0].body.expected_server_id, 'library-a');
  assert.equal(h.requests[0].headers.Origin, undefined);
  assert.equal(JSON.stringify(h.client).includes('a'.repeat(43)), false);
  await h.client.close();
  assert.equal(h.killed(), 1);
});

test('invalid startup URLs or tokens are rejected before transmitting any request', async () => {
  for (const handshake of [
    { protocol: 1, url: 'https://external.example', token: 'a'.repeat(43) },
    { protocol: 1, url: 'http://127.0.0.1:12@external.example', token: 'a'.repeat(43) },
    { protocol: 1, url: 'http://127.0.0.1:54321', token: 'short' },
  ]) {
    const h = harness(handshake);
    await assert.rejects(h.client.rpc('health', {}));
    assert.equal(h.requests.length, 0);
    assert.equal(h.killed(), 1);
  }
});

test('closing during child startup stops it and sends no request', async () => {
  let completeLaunch;
  let stops = 0;
  const client = createBridgeClient({
    serverID: () => 'library-a',
    launch: () => new Promise((resolve) => { completeLaunch = resolve; }),
    request: async () => { assert.fail('closed child must not send'); },
  });
  const request = client.rpc('health', {});
  await Promise.resolve();
  const closing = client.close();
  completeLaunch({ read: async () => '', stop: async () => { stops += 1; } });
  await assert.rejects(request);
  await closing;
  assert.equal(stops, 1);
});

test('close cancels an unresolved handshake immediately without HTTP or unhandled rejection', async () => {
  const token = 'b'.repeat(43);
  const requests = [];
  let completeLaunch;
  let readStarted;
  let rejectRead;
  let stops = 0;
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);

  const client = createBridgeClient({
    serverID: () => 'library-a',
    launch: () => new Promise((resolve) => { completeLaunch = resolve; }),
    request: async (...args) => { requests.push(args); },
  });
  const pending = client.rpc('health', {});
  await Promise.resolve();

  const child = {
    read: async () => {
      readStarted();
      return new Promise((_, reject) => { rejectRead = reject; });
    },
    stop: async () => {
      stops += 1;
      rejectRead(new Error(token));
    },
  };
  const handshakeReadStarted = new Promise((resolve) => { readStarted = resolve; });
  completeLaunch(child);
  await handshakeReadStarted;

  try {
    const closing = client.close();
    assert.equal(stops, 1);
    await assert.rejects(pending, (error) => {
      assert.equal(String(error).includes(token), false);
      return true;
    });
    let deadline;
    try {
      await Promise.race([
        closing,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('close remained pending')), 250);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.equal(requests.length, 0);
  assert.equal(unhandled.length, 0);
});
