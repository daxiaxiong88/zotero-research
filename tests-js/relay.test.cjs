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

test('same-session reconnect discards abandoned polls without cancelling an active task', async () => {
  const { store } = makeStore();
  connect(store);
  const claimed = store.enqueueTask({ messages: [{ text: 'already executing' }] });
  await store.poll({ sessionSecret: SECRET }, 0);
  let oldReply;
  const old = store.poll({ sessionSecret: SECRET }).then(result => { oldReply = result; });
  connect(store);
  await Promise.resolve();
  assert.deepEqual(oldReply, {}, 'an obsolete poll is released even when the secret stays the same');
  assert.equal(store._tasks.get(claimed).complete, false, 'an already executing task is not resent or cancelled');
  const live = store.poll({ sessionSecret: SECRET });
  const queued = store.enqueueTask({ messages: [{ text: 'new message' }] });
  assert.equal((await live).task.id, queued);
  await old;
  store.destroy();
});

test('a retry replaces the abandoned waiting poll and gets the task exactly once', async () => {
  const { store } = makeStore();
  connect(store);
  let oldReply;
  const old = store.poll({ sessionSecret: SECRET }).then(result => { oldReply = result; });
  const live = store.poll({ sessionSecret: SECRET });
  await Promise.resolve();
  assert.deepEqual(oldReply, {}, 'a new poll retires the previous same-session request');
  const id = store.enqueueTask({ messages: [{ text: 'image question' }] });
  assert.equal((await live).task.id, id);
  assert.deepEqual(await store.poll({ sessionSecret: SECRET }, 0), {});
  await old;
  store.destroy();
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
  assert.deepEqual(store.update({ sessionSecret: SECRET, id, text: '部分+完整', isDone: true }), { ok: true });
  assert.equal(events.length, 2);
  assert.deepEqual(store.update({ sessionSecret: SECRET, id, text: 'x', isDone: true }), { error: 'TASK_CLOSED', complete: true });
  assert.equal(store._tasks.get(id).text, '部分+完整');
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

test('takeover releases old polls and hands a task to exactly the latest current poll', async () => {
  const { store } = makeStore();
  connect(store);
  const oldPoll = store.poll({ sessionSecret: SECRET });
  const newSecret = 'new-page-session-secret';
  connect(store, newSecret);
  const firstPoll = store.poll({ sessionSecret: newSecret });
  const secondPoll = store.poll({ sessionSecret: newSecret });
  const id = store.enqueueTask({ messages: [{ text: 'one task' }] });
  assert.deepEqual(await oldPoll, { error: 'SESSION_EXPIRED' });
  assert.deepEqual(await firstPoll, {});
  assert.equal((await secondPoll).task.id, id);
  store.disconnect({ sessionSecret: newSecret });
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

test('enqueueTask preserves image messages and rejects oversized ones', () => {
  const { store } = makeStore();
  connect(store);
  const id = store.enqueueTask({
    messages: [
      { text: '请看这张截图' },
      { type: 'image', data: 'aGVsbG8=', mediaType: 'image/png' },
    ],
    meta: {},
  });
  const messages = store._tasks.get(id).messages;
  assert.equal(messages[0].type, 'text');
  assert.equal(messages[1].type, 'image');
  assert.equal(messages[1].data, 'aGVsbG8=');
  assert.equal(messages[1].mediaType, 'image/png');
  assert.throws(() => store.enqueueTask({
    messages: [{ type: 'image', data: 'x'.repeat(6_000_001), mediaType: 'image/png' }],
    meta: {},
  }), /截图缺失或超过大小限制/);
});

function timedStore() {
  let clock = 0;
  let serial = 0;
  const timers = new Map();
  const store = relay.createRelayStore({
    now: () => clock,
    setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  function advance(ms) {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) { timers.delete(id); timer.fn(); }
    }
  }
  return { store, advance, timers };
}

test('delayed full answer replaces a timed-out prefix for the same latest claimed task', async () => {
  const { store, advance } = timedStore();
  connect(store);
  const events = [];
  store.subscribe(e => events.push(e));
  const id = store.enqueueTask({ messages: [{ text: '解释无因果遮挡' }] });
  await store.poll({ sessionSecret: SECRET }, 0);
  store.update({ sessionSecret: SECRET, id, text: '**无因果遮挡' });
  advance(91000);
  assert.equal(store._tasks.get(id).complete, true);
  const heartbeat = store.update({ sessionSecret: SECRET, id, heartbeat: true });
  assert.equal(heartbeat.recoverable, true, 'timeout is not an acknowledgement of full delivery');
  const partial = '**无因果遮挡**\n' + '已抓取正文。'.repeat(200);
  store.update({ sessionSecret: SECRET, id, text: partial });
  assert.equal(store._tasks.get(id).text, partial, 'never silently discard the captured answer');
  assert.equal(store._tasks.get(id).complete, true, 'late progress must not lock the sidebar again');
  const full = partial + '\n最终结论。';
  store.update({ sessionSecret: SECRET, id, text: full, isDone: true });
  assert.equal(store._tasks.get(id).text, full);
  assert.equal(store._tasks.get(id).error, '');
  assert.equal(events.at(-1).type, 'answer');
  assert.equal(events.at(-1).error, '');
  assert.equal((await store.poll({ sessionSecret: SECRET }, 0)).task, undefined, 'never resend the prompt');
  store.destroy();
});

for (const stop of ['cancel', 'new-task', 'new-session', 'disconnect', 'expired', 'unclaimed']) {
  test(`late recovery cannot revive a ${stop} task`, async () => {
    const { store, advance } = timedStore();
    connect(store);
    const id = store.enqueueTask({ messages: [{ text: 'Q' }] });
    if (stop !== 'unclaimed') await store.poll({ sessionSecret: SECRET }, 0);
    advance(91000);
    let secret = SECRET;
    if (stop === 'cancel') store.cancelTask(id);
    if (stop === 'new-task') store.enqueueTask({ messages: [{ text: 'next' }] });
    if (stop === 'new-session') { secret += '-new'; connect(store, secret); }
    if (stop === 'disconnect') { store.disconnect({ sessionSecret: secret }); connect(store, secret); }
    if (stop === 'expired') advance(20 * 60000);
    const result = store.update({ sessionSecret: secret, id, text: 'must not revive', isDone: true });
    assert.equal(result.error, 'TASK_CLOSED');
    assert.equal(store._tasks.get(id).text, '');
    assert.notEqual(store.update({ sessionSecret: secret, id, heartbeat: true }).recoverable, true);
    store.destroy();
  });
}

for (const claimed of [false, true]) {
  test(`no browser activity: ${claimed ? 'claimed' : 'unclaimed'} task expires autonomously and frees queue`, async () => {
    const { store, advance, timers } = timedStore();
    connect(store);
    const events = [];
    store.subscribe(e => events.push(e));
    const id = store.enqueueTask({ messages: [{ text: 'Q' }] });
    if (claimed) await store.poll({ sessionSecret: SECRET }, 0);
    advance(91000);
    assert.ok(events.some(e => e.type === 'answer' && e.id === id && e.error));
    assert.deepEqual(await store.poll({ sessionSecret: SECRET }, 0), {});
    assert.equal(store._queue.length, 0);
    assert.equal(timers.size, 0, 'no watchdog left without active work');
    store.destroy();
  });
}

test('autonomous timeout respects progress heartbeats and destroys all timers', async () => {
  const { store, advance, timers } = timedStore();
  connect(store);
  const id = store.enqueueTask({ messages: [{ text: 'Q' }] });
  await store.poll({ sessionSecret: SECRET }, 0);
  advance(60000);
  store.update({ sessionSecret: SECRET, id, text: 'partial' });
  advance(60000);
  assert.equal(store._tasks.get(id).complete, false);
  advance(31000);
  assert.equal(store._tasks.get(id).complete, true);
  assert.equal(store._tasks.get(id).text, 'partial');
  assert.equal(timers.size, 0);
  store.enqueueTask({ messages: [{ text: 'next' }] });
  store.destroy();
  assert.equal(timers.size, 0);
});

test('transport heartbeat keeps slow uploads and reasoning alive without overwriting the partial answer', async () => {
  const { store, advance } = timedStore();
  connect(store);
  const events = [];
  store.subscribe(event => events.push(event));
  const id = store.enqueueTask({ messages: [{ text: 'Q' }] });
  await store.poll({ sessionSecret: SECRET }, 0);
  store.update({ sessionSecret: SECRET, id, text: '已收到的回答', notice: '正在处理图片' });
  const before = events.length;
  advance(60000);
  store.update({ sessionSecret: SECRET, id, heartbeat: true });
  assert.equal(store._tasks.get(id).text, '已收到的回答');
  assert.equal(events.length, before, 'a heartbeat is not a new/empty answer');
  advance(60000);
  assert.equal(store._tasks.get(id).complete, false);
  store.destroy();
});

test('cancelled navigation tasks cannot later be delivered to the browser', async () => {
  const { store, timers } = timedStore();
  connect(store);
  const id = store.enqueueTask({ messages: [{ text: 'old paper' }] });
  store.cancelTask(id);
  store.cancelTask(id);
  assert.equal(timers.size, 0);
  assert.equal(store._queue.length, 0);
  assert.deepEqual(await store.poll({ sessionSecret: SECRET }, 0), {});
});

test('selected provider must match the connected page, including late connections', async () => {
  const { store } = makeStore();
  connect(store); // Gemini
  assert.throws(() => store.enqueueTask({ messages: [{ text: 'Q' }], meta: { provider: 'chatgpt' } }), /ChatGPT|chatgpt/);
  store.disconnect({ sessionSecret: SECRET });
  const id = store.enqueueTask({ messages: [{ text: 'Q' }], meta: { provider: 'chatgpt' } });
  connect(store);
  assert.deepEqual(await store.poll({ sessionSecret: SECRET }, 0), {});
  assert.match(store._tasks.get(id).error, /打开网页/);
  store.connect({ sessionSecret: SECRET, ai: 'AIStudio' });
  const studio = store.enqueueTask({ messages: [{ text: 'Q' }], meta: { provider: 'aistudio' } });
  assert.equal((await store.poll({ sessionSecret: SECRET }, 0)).task.id, studio);
});
