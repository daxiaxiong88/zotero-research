/* Native highlight transactions. No database access and no model-generated geometry. */
(function (root) {
  'use strict';

  const KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
  const SORT = /^\d{5}\|\d{6}\|\d{5}$/;
  const LIFETIME = 10 * 60 * 1000;
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function validatePosition(value, page) {
    if (!value || value.pageIndex !== page - 1) throw new Error('选区页码不一致。');
    const check = (rects) => Array.isArray(rects) && rects.length > 0 && rects.length <= 1000
      && rects.every((r) => Array.isArray(r) && r.length === 4
        && r.every((n) => Number.isFinite(n) && Math.abs(n) < 1e7)
        && r[0] < r[2] && r[1] < r[3]);
    if (!check(value.rects) || (value.nextPageRects && !check(value.nextPageRects))) {
      throw new Error('没有可安全使用的 PDF 高亮坐标，请在阅读器中重新选文。');
    }
    return {
      pageIndex: value.pageIndex,
      rects: clone(value.rects),
      ...(value.nextPageRects ? { nextPageRects: clone(value.nextPageRects) } : {}),
    };
  }

  function validateSort(sortIndex, page) {
    if (typeof sortIndex !== 'string' || !SORT.test(sortIndex)
      || Number(sortIndex.slice(0, 5)) !== page - 1) {
      throw new Error('PDF 选区排序信息无效，请在阅读器中重新选文。');
    }
    return sortIndex;
  }

  function validateAttachment(attachment, key) {
    if (!attachment || attachment.key !== key || !KEY.test(key)
      || !attachment.isPDF || !attachment.isPersonal || !attachment.editable
      || !attachment.id || !attachment.libraryID || !attachment.stamp) {
      throw new Error('只支持个人文献库中可编辑、已保存的本地 PDF 附件。');
    }
    return attachment;
  }

  function identity(attachment) {
    return JSON.stringify([
      attachment.key, attachment.id, attachment.libraryID,
      attachment.parentKey || null, attachment.stamp,
    ]);
  }

  function createHighlightController(adapter) {
    const pending = new Map();
    const selections = new Map();
    let alive = true;
    const now = adapter.now || Date.now;
    const ensureAlive = () => { if (!alive) throw new Error('科研助手已关闭，请重新连接。'); };
    const clean = () => {
      for (const [key, record] of pending) if (record.expires <= now()) pending.delete(key);
      for (const [key, record] of selections) if (record.expires <= now()) selections.delete(key);
    };

    return {
      async captureSelection(attachmentKey, annotation) {
        ensureAlive();
        clean();
        const source = clone(annotation);
        const page = source?.position?.pageIndex + 1;
        if (!Number.isInteger(page) || page < 1 || page > 100000
          || typeof source.text !== 'string' || !source.text.trim() || source.text.length > 12000) {
          throw new Error('请在 PDF 阅读器中选择不超过 12000 字的原文。');
        }
        const attachment = validateAttachment(await adapter.attachment(attachmentKey), attachmentKey);
        const position = validatePosition(source.position, page);
        const sortIndex = validateSort(source.sortIndex, page);
        const selection = {
          attachment_key: attachmentKey, text: source.text, page,
          position, page_label: String(source.pageLabel || page), sort_index: sortIndex,
        };
        ensureAlive();
        if (selections.size >= 16) selections.delete(selections.keys().next().value);
        selections.set(attachmentKey, {
          selection: clone(selection), identity: identity(attachment),
          server: adapter.serverID(), expires: now() + LIFETIME,
        });
        return clone(selection);
      },

      async prepare({ attachment_key: key, page, quote }) {
        ensureAlive();
        clean();
        if (!KEY.test(key) || !Number.isInteger(page) || page < 1 || page > 100000
          || typeof quote !== 'string' || !quote.trim() || quote.length > 12000) {
          throw new Error('请选择有效的附件、物理页码和原文。');
        }
        if (pending.size >= 64) throw new Error('待确认预览过多，请稍后重试。');
        const server = adapter.serverID();
        if (!server) throw new Error('当前文献库尚未连接。');
        const attachment = validateAttachment(await adapter.attachment(key), key);
        const selected = selections.get(key);
        let position, sortIndex, pageLabel, source;
        if (selected && selected.server === server && selected.identity === identity(attachment)
          && selected.selection.page === page && selected.selection.text === quote) {
          position = clone(selected.selection.position);
          sortIndex = selected.selection.sort_index;
          pageLabel = selected.selection.page_label;
          source = 'reader';
        } else {
          const located = await adapter.locate({ attachment_key: key, page, quote });
          if (located.status !== 'exact' || located.page !== page || located.text !== quote) {
            throw new Error('原文不能唯一定位。请在 PDF 中手动选中原文，再预览高亮。');
          }
          position = validatePosition({ pageIndex: page - 1, rects: located.rects }, page);
          sortIndex = validateSort(located.sort_index, page);
          pageLabel = String(located.page_label || page);
          source = 'matched_quote';
        }
        const data = {
          key: adapter.annotationKey(), type: 'highlight', authorName: '',
          text: quote, comment: '', color: '#ffd400', pageLabel,
          sortIndex, position, isExternal: false, tags: [],
        };
        if (!KEY.test(data.key)) throw new Error('注释标识生成失败。');
        const expires = now() + LIFETIME;
        const token = adapter.token();
        const digest = await adapter.digest(JSON.stringify({ server, identity: identity(attachment), data, expires }));
        const preview = {
          token, digest, text: quote, page, color: data.color,
          attachment_key: key, page_label: pageLabel, source,
          expires_at: new Date(expires).toISOString(),
        };
        ensureAlive();
        pending.set(token, {
          preview: clone(preview), data, server, identity: identity(attachment), expires,
        });
        return clone(preview);
      },

      async commit(preview, confirmedByUser = false) {
        ensureAlive();
        if (confirmedByUser !== true) throw new Error('请先核对预览并明确确认写入。');
        clean();
        const record = pending.get(preview?.token);
        if (!record) throw new Error('预览已过期或已使用，请先检查 Zotero 中是否已保存。');
        for (const field of Object.keys(record.preview)) {
          if (preview[field] !== record.preview[field]) throw new Error('预览内容已变化，请重新预览。');
        }
        // Consume before the first await: double-clicks and ambiguous saves never replay.
        pending.delete(preview.token);
        if (adapter.serverID() !== record.server) throw new Error('文献库已切换，请重新预览。');
        const attachment = validateAttachment(
          await adapter.attachment(preview.attachment_key), preview.attachment_key,
        );
        if (identity(attachment) !== record.identity || adapter.serverID() !== record.server) {
          throw new Error('PDF 文件或文献库已变化，请重新预览。');
        }
        ensureAlive();
        if (record.expires <= now()) throw new Error('预览已过期，请重新预览。');
        let saved;
        try {
          saved = await adapter.save(attachment, clone(record.data));
        } catch (_) {
          throw new Error('高亮写入结果不确定，请先检查 Zotero，不要重复提交。');
        }
        return { status: 'created', annotation_key: saved.key, attachment_key: attachment.key, page: preview.page };
      },

      destroy() { alive = false; pending.clear(); selections.clear(); },
    };
  }

  const api = { createHighlightController };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZoteroResearchNative = api;
})(globalThis);
