const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { createHighlightController } = require('../addon/content/native.js');

function harness() {
  let clock = Date.parse('2026-09-03T10:00:00Z');
  let server = 'synthetic-library';
  let stamp = 'synthetic-file-v1';
  const writes = [];
  const lookups = [];
  const controller = createHighlightController({
    now: () => clock,
    token: () => randomUUID(),
    digest: async (value) => createHash('sha256').update(value).digest('hex'),
    serverID: () => server,
    attachment: async (key) => ({
      key, id: 22, libraryID: 1, parentKey: 'PARENT23', editable: true,
      isPDF: true, stamp,
    }),
    locate: async (args) => {
      lookups.push(args);
      return {
        status: 'exact', text: args.quote, page: args.page,
        rects: [[50, 600, 200, 614]], page_label: '2',
        sort_index: '00001|000123|00180',
      };
    },
    save: async (attachment, json) => {
      writes.push({ attachment, json });
      return { key: 'ANNTAG23' };
    },
    annotationKey: () => 'ANNTAG23',
  });
  return {
    controller, writes, lookups,
    advance: (ms) => { clock += ms; },
    changeServer: () => { server = 'another-library'; },
    changeFile: () => { stamp = 'synthetic-file-v2'; },
  };
}

const args = () => ({ attachment_key: 'PDFITEM2', page: 2, quote: 'Measured improvement.' });

test('highlight preparation is read-only; confirmation writes exactly once', async () => {
  const h = harness();
  const preview = await h.controller.prepare(args());
  assert.equal(h.writes.length, 0);
  assert.equal(preview.text, args().quote);
  assert.equal(preview.page, 2);
  assert.match(preview.digest, /^[a-f0-9]{64}$/);
  await assert.rejects(h.controller.commit(preview, false), /确认/);
  const [first, second] = await Promise.allSettled([
    h.controller.commit(preview, true), h.controller.commit(preview, true),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].json.position, { pageIndex: 1, rects: [[50, 600, 200, 614]] });
  assert.equal(h.writes[0].json.text, args().quote);
  assert.equal(h.writes[0].json.type, 'highlight');
  assert.equal(h.writes[0].json.isExternal, false);
});

test('native reader geometry is retained and caller-supplied geometry is ignored', async () => {
  const h = harness();
  const position = { pageIndex: 1, rects: [[20, 300, 90, 314]], nextPageRects: [[20, 700, 80, 714]] };
  await h.controller.captureSelection('PDFITEM2', {
    text: args().quote, position, sortIndex: '00001|000005|00480', pageLabel: 'ii',
  });
  position.rects[0][0] = 999;
  const preview = await h.controller.prepare({
    ...args(), selection: { position: { pageIndex: 9, rects: [[0, 0, 999, 999]] } },
  });
  await h.controller.commit(preview, true);
  assert.equal(h.lookups.length, 0);
  assert.equal(preview.page_label, 'ii');
  assert.equal(h.writes[0].json.position.rects[0][0], 20);
  assert.equal(h.writes[0].json.position.nextPageRects.length, 1);
});

test('modified preview, changed PDF, wrong library and expired preview cannot write', async () => {
  for (const mutate of [
    (h, p) => ({ ...p, text: 'Different text.' }),
    (h, p) => { h.changeFile(); return p; },
    (h, p) => { h.changeServer(); return p; },
    (h, p) => { h.advance(600001); return p; },
  ]) {
    const h = harness();
    const preview = await h.controller.prepare(args());
    await assert.rejects(h.controller.commit(mutate(h, preview), true));
    assert.equal(h.writes.length, 0);
  }
});

test('destroy drops native selections and all uncommitted previews', async () => {
  const h = harness();
  const preview = await h.controller.prepare(args());
  h.controller.destroy();
  await assert.rejects(h.controller.commit(preview, true));
  assert.equal(h.writes.length, 0);
});
