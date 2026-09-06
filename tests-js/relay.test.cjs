const test = require('node:test');
const assert = require('node:assert/strict');
const relay = require('../addon/content/relay.js');

function makeStore(options = {}) {
  let clock = 0;
  const timers = [];
  const setTimeoutFn = (fn, ms) => { timers.push({ fn, ms, at: clock }); return timers.length; };
  const clearTimeoutFn = () => {};
  const store = relay.createRelayStore({
    now: () => clock,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    ...options,
  });
  return { store, tick: (ms) => { clock += ms; } };
}

const SECRET = 'session-secret-0123456789';

test('overview materials contain all short-paper text, independent of query language', () => {
  const result = relay.overviewMaterial([
    { number: 1, text: 'Abstract and methods.' },
    { number: 2, text: '' },
    { number: 3, text: 'Results and limitations.' },
  ]);
  assert.equal(result.kind, 'full-text');
  assert.deepEqual(result.spans.map(s => [s.page, s.text]), [
    [1, 'Abstract and methods.'], [3, 'Results and limitations.'],
  ]);
});

test('long-paper overview includes beginning, middle and end within its explicit budget', () => {
  const pages = Array.from({ length: 30 }, (_, i) => ({ number: i + 1, text: 'H'.repeat(2000) + 'T'.repeat(2000) }));
  const result = relay.overviewMaterial(pages, 1600);
  assert.equal(result.kind, 'overview-excerpts');
  assert.ok(result.spans.some(s => s.page === 1));
  assert.ok(result.spans.some(s => s.page > 10 && s.page < 20));
  assert.ok(result.spans.some(s => s.page === 30));
  assert.ok(result.spans.some(s => /^T+$/.test(s.text)), 'tail paragraphs must not disappear');
  assert.ok(result.spans.reduce((n, s) => n + s.text.length, 0) <= 1600);
});

function connect(store, secret = SECRET) {
  const result = store.connect({ sessionSecret: secret, ai: 'Gemini', url: 'https://gemini.google.com/' });
  assert.equal(result.status, 'connected');
}

test('rankEvidence scores keyword pages and strips empty queries', () => {
  const pages = [
    { number: 1, text: 'The methods section describes a randomized experiment with 40 samples.' },
    { number: 2, text: 'Results: measured improvement in the experiment group.' },
    { number: 3, text: '完全不同的中文内容，讨论别的主题。' },
  ];
  const spans = relay.rankEvidence(pages, 'experiment results', 2);
  assert.equal(spans.length, 2);
  assert.ok(spans[0].score >= spans[1].score);
  assert.match(spans[0].text, /experiment/);
  assert.equal(relay.rankEvidence(pages, '   ', 3).length, 0);
  // CJK query hits the Chinese page.
  const chinese = relay.rankEvidence(pages, '中文', 1);
  assert.equal(chinese.length, 1);
  assert.match(chinese[0].text, /中文/);
});

test('connect supersedes old page and old page sees SESSION_EXPIRED', async () => {
  const { store } = makeStore();
  connect(store, 'secret-old-1234567890');
  connect(store, 'secret-new-1234567890');
  assert.deepEqual(await store.poll({ sessionSecret: 'secret-old-1234567890' }, 0), { error: 'SESSION_EXPIRED' });
  assert.deepEqual(await store.poll({ sessionSecret: 'secret-new-1234567890' }, 0), {});
});

test('poll claims queued task; waiting poll resolves on enqueue', async () => {
  const { store } = makeStore();
  connect(store);
  const id = store.enqueueTask({ messages: [{ text: '总结本页' }], meta: { title: 'P' } });
  const polled = await store.poll({ sessionSecret: SECRET }, 0);
  assert.equal(polled.task.id, id);
  assert.equal(polled.task.messages[0].text, '总结本页');
  // Queue drained: a second poll with waitMs=0 returns empty.
  assert.deepEqual(await store.poll({ sessionSecret: SECRET }, 0), {});
});

test('waiting poll resolves when a task is enqueued later', async () => {
  const { store } = makeStore();
  connect(store);
  const pending = store.poll({ sessionSecret: SECRET }); // long wait
  await new Promise((resolve) => setTimeout(resolve, 10));
  store.enqueueTask({ messages: [{ text: 'hello' }], meta: {} });
  const result = await pending;
  assert.equal(result.task.messages[0].text, 'hello');
});

test('update streams progress and finalizes with done', async () => {
  const { store } = makeStore();
  connect(store);
  const events = [];
  store.subscribe((event) => events.push(event));
  const id = store.enqueueTask({ messages: [{ text: 'q' }], meta: { title: 'T' } });
  await store.poll({ sessionSecret: SECRET }, 0);
  assert.deepEqual(store.update({ sessionSecret: SECRET, id, text: '部分', isDone: false }), { ok: true });
  assert.deepEqual(store.update({ sessionSecret: SECRET, id, text: '部分+完整', isDone: true }), { ok: true });
  const kinds = events.map((event) => event.type);
  assert.deepEqual(kinds, ['progress', 'answer']);
  assert.equal(events[1].text, '部分+完整');
  // Duplicate completion is idempotent.
  assert.deepEqual(store.update({ sessionSecret: SECRET, id, text: 'x', isDone: true }), { ok: true });
});

test('rejects foreign secret, unknown task, oversized text', () => {
  const { store } = makeStore();
  connect(store);
  const id = store.enqueueTask({ messages: [{ text: 'q' }], meta: {} });
  assert.deepEqual(store.update({ sessionSecret: 'wrong-secret-123456', id, text: 'x' }), { error: 'SESSION_EXPIRED' });
  assert.deepEqual(store.update({ sessionSecret: SECRET, id: 'nope', text: 'x' }), { error: 'UNKNOWN_TASK' });
  assert.deepEqual(
    store.update({ sessionSecret: SECRET, id, text: 'a'.repeat(200001), isDone: true }),
    { error: 'TEXT_TOO_LONG' },
  );
});

test('failTask marks the task failed and notifies with error', async () => {
  const { store } = makeStore();
  connect(store);
  const events = [];
  store.subscribe((event) => events.push(event));
  const id = store.enqueueTask({ messages: [{ text: 'q' }], meta: {} });
  await store.poll({ sessionSecret: SECRET }, 0);
  store.failTask(id, '未找到发送按钮');
  const answer = events.find((event) => event.type === 'answer');
  assert.equal(answer.error, '未找到发送按钮');
  assert.equal(answer.done, true);
});

test('disconnect clears session; reconnect works', async () => {
  const { store } = makeStore();
  connect(store);
  assert.deepEqual(store.disconnect({ sessionSecret: SECRET }), { status: 'disconnected' });
  assert.deepEqual(await store.poll({ sessionSecret: SECRET }, 0), { error: 'SESSION_EXPIRED' });
  connect(store);
  assert.equal(store.state().connected, true);
});

test('enqueue rejects empty messages and overflow queue', () => {
  const { store } = makeStore();
  connect(store);
  assert.throws(() => store.enqueueTask({ messages: [], meta: {} }), /不能为空/);
  for (let index = 0; index < 8; index += 1) store.enqueueTask({ messages: [{ text: 'q' }], meta: {} });
  assert.throws(() => store.enqueueTask({ messages: [{ text: 'q' }], meta: {} }), /过多/);
});

test('update accepts a failed flag and surfaces the error', async () => {
  const { store } = makeStore();
  connect(store);
  const events = [];
  store.subscribe((event) => events.push(event));
  const id = store.enqueueTask({ messages: [{ text: 'q' }], meta: {} });
  await store.poll({ sessionSecret: SECRET }, 0);
  assert.deepEqual(
    store.update({ sessionSecret: SECRET, id, text: '', isDone: true, failed: '无法填充输入框' }),
    { ok: true },
  );
  const answer = events.find((event) => event.type === 'answer');
  assert.equal(answer.error, '无法填充输入框');
  assert.equal(answer.done, true);
});

test('takeover releases old polls and hands a task to exactly one current poll', async () => {
  const { store } = makeStore();
  connect(store);
  const oldPoll = store.poll({ sessionSecret: SECRET });
  const newSecret = 'new-page-session-secret';
  connect(store, newSecret);
  const firstPoll = store.poll({ sessionSecret: newSecret });
  const secondPoll = store.poll({ sessionSecret: newSecret });
  const id = store.enqueueTask({ messages: [{ text: 'one task' }] });
  assert.deepEqual(await oldPoll, { error: 'SESSION_EXPIRED' });
  assert.equal((await firstPoll).task.id, id);
  store.disconnect({ sessionSecret: newSecret });
  assert.deepEqual(await secondPoll, { error: 'SESSION_EXPIRED' });
});

test('disconnect terminates claimed tasks so the sidebar can retry explicitly', async () => {
  const { store } = makeStore();
  connect(store);
  const events = [];
  store.subscribe(event => events.push(event));
  const id = store.enqueueTask({ messages: [{ text: 'question' }] });
  await store.poll({ sessionSecret: SECRET }, 0);
  store.disconnect({ sessionSecret: SECRET });
  assert.equal(events.find(event => event.type === 'answer' && event.id === id)?.done, true);
});

test('stale claims are failed and freed after the timeout', async () => {
  let clock = 0;
  const timers = [];
  const store = relay.createRelayStore({
    now: () => clock,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  });
  connect(store);
  const events = [];
  store.subscribe((event) => events.push(event));
  const id = store.enqueueTask({ messages: [{ text: 'q' }], meta: {} });
  await store.poll({ sessionSecret: SECRET }, 0);
  clock += 91000; // beyond STALE_CLAIM_MS with no update heartbeat
  await store.poll({ sessionSecret: SECRET }, 0);
  const answer = events.find((event) => event.type === 'answer' && event.error);
  assert.ok(answer, 'stale task failed with an error');
  assert.match(answer.error, /长时间未回传/);
  // The slot is free: a new task flows through immediately.
  const id2 = store.enqueueTask({ messages: [{ text: 'q2' }], meta: {} });
  const polled = await store.poll({ sessionSecret: SECRET }, 0);
  assert.equal(polled.task.id, id2);
});

test('progress updates refresh the claim heartbeat and carry notices', async () => {
  let clock = 0;
  const store = relay.createRelayStore({
    now: () => clock,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  });
  const timers = [];
  const events = [];
  connect(store);
  store.subscribe((event) => events.push(event));
  const id = store.enqueueTask({ messages: [{ text: 'q' }], meta: {} });
  await store.poll({ sessionSecret: SECRET }, 0);
  clock += 60000;
  store.update({ sessionSecret: SECRET, id, text: '部分', isDone: false, notice: '请到网页手动点击发送' });
  clock += 60000; // 120s since claim, but the heartbeat refreshed at 60s
  await store.poll({ sessionSecret: SECRET }, 0);
  const failed = events.find((event) => event.type === 'answer' && event.error);
  assert.equal(failed, undefined, 'heartbeat keeps the claim alive');
  const progress = events.find((event) => event.type === 'progress');
  assert.equal(progress.notice, '请到网页手动点击发送');
});

test('enqueueTask prunes completed tasks older than 30 minutes', async () => {
  const { store, tick } = makeStore();
  connect(store);
  const id = store.enqueueTask({ messages: [{ text: 'q1' }], meta: {} });
  await store.poll({ sessionSecret: SECRET }, 0);
  store.update({ sessionSecret: SECRET, id, text: 'done', isDone: true });
  assert.ok(store._tasks.has(id), 'completed task kept for late updates');
  tick(31 * 60 * 1000);
  store.enqueueTask({ messages: [{ text: 'q2' }], meta: {} });
  assert.equal(store._tasks.has(id), false, 'stale completed task pruned on enqueue');
});
