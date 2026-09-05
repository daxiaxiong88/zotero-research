/* Safe Markdown rendering for the Zotero sidebar.
 * Builds DOM nodes only — model text is never assigned to innerHTML, so
 * hostile markup from a web AI can only ever appear as literal text. */
(function (root) {
  'use strict';

  var XHTML_NS = 'http://www.w3.org/1999/xhtml';

  /** Split <think>…</think> (tolerating an unclosed block while streaming). */
  function splitThinking(value) {
    var source = String(value || '');
    var think = '';
    var answer = source;
    var open = source.indexOf('<think>');
    if (open >= 0) {
      var close = source.indexOf('</think>', open);
      if (close >= 0) {
        think = source.slice(open + 7, close).trim();
        answer = (source.slice(0, open) + source.slice(close + 8)).trim();
      } else {
        think = source.slice(open + 7).trim();
        answer = source.slice(0, open).trim();
      }
    }
    return { think: think, answer: answer };
  }

  function create(doc, tag, className, text) {
    var element = doc.createElementNS(XHTML_NS, tag);
    if (className) element.setAttribute('class', className);
    if (text !== undefined && text !== null) element.textContent = text;
    return element;
  }

  // One combined inline pattern; group order matters (see renderInline).
  var INLINE = new RegExp(
    '(' + /\*\*([^*]+)\*\*/.source + ')'
    + '|(' + /(^|[^*])\*([^*\n]+)\*(?!\*)/.source + ')'
    + '|(' + /`([^`\n]+)`/.source + ')'
    + '|(' + /~~([^~]+)~~/.source + ')'
    + '|(' + /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/.source + ')',
    'g',
  );

  function appendText(node, value) {
    node.appendChild(node.ownerDocument.createTextNode(value));
  }

  /** Inline pass: bold/italic/code/strike/links, all built as DOM nodes. */
  function renderInline(doc, parent, source) {
    var text = String(source || '');
    var cursor = 0;
    var match;
    INLINE.lastIndex = 0;
    while ((match = INLINE.exec(text)) !== null) {
      if (match.index > cursor) appendText(parent, text.slice(cursor, match.index));
      if (match[1] !== undefined) {
        parent.appendChild(create(doc, 'strong', '', match[2]));
      } else if (match[3] !== undefined) {
        if (match[4]) appendText(parent, match[4]);
        parent.appendChild(create(doc, 'em', '', match[5]));
      } else if (match[6] !== undefined) {
        parent.appendChild(create(doc, 'code', 'zrp-md-code', match[7]));
      } else if (match[8] !== undefined) {
        parent.appendChild(create(doc, 'del', '', match[9]));
      } else if (match[10] !== undefined) {
        // Links: http/https only, label shown as plain text.
        var anchor = create(doc, 'a', 'zrp-md-link', match[11] || match[12]);
        anchor.setAttribute('href', match[12]);
        parent.appendChild(anchor);
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) appendText(parent, text.slice(cursor));
  }

  function isTableDivider(line) {
    return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.indexOf('-') >= 0;
  }

  function splitTableRow(line) {
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
      .map(function trim(cell) { return cell.trim(); });
  }

  /** Block pass: fenced code, headings, lists, quotes, tables, rules, paragraphs. */
  function renderMarkdown(doc, source) {
    var fragment = doc.createDocumentFragment();
    var lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
    var index = 0;

    while (index < lines.length) {
      var line = lines[index];

      // Fenced code block.
      var fence = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
      if (fence) {
        var marker = fence[1].slice(0, 3);
        var codeLines = [];
        index += 1;
        while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
          codeLines.push(lines[index]);
          index += 1;
        }
        index += 1; // closing fence
        var block = create(doc, 'pre', 'zrp-md-pre');
        block.appendChild(create(doc, 'code', 'zrp-md-codeblock', codeLines.join('\n')));
        fragment.appendChild(block);
        continue;
      }

      if (!line.trim()) { index += 1; continue; }

      // Heading.
      var heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        var head = create(doc, 'h' + Math.min(heading[1].length + 1, 5), 'zrp-md-h');
        renderInline(doc, head, heading[2]);
        fragment.appendChild(head);
        index += 1;
        continue;
      }

      // Horizontal rule.
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        fragment.appendChild(create(doc, 'hr', 'zrp-md-hr'));
        index += 1;
        continue;
      }

      // Table: header row followed by a divider row.
      if (line.indexOf('|') >= 0 && index + 1 < lines.length
        && isTableDivider(lines[index + 1])) {
        var headCells = splitTableRow(line);
        index += 2;
        var bodyRows = [];
        while (index < lines.length && lines[index].indexOf('|') >= 0 && lines[index].trim()) {
          bodyRows.push(splitTableRow(lines[index]));
          index += 1;
        }
        var table = create(doc, 'table', 'zrp-md-table');
        var thead = create(doc, 'thead', '');
        var headRow = create(doc, 'tr', '');
        headCells.forEach(function addHead(cell) {
          var th = create(doc, 'th', 'zrp-md-th');
          renderInline(doc, th, cell);
          headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);
        var tbody = create(doc, 'tbody', '');
        bodyRows.forEach(function addBody(row) {
          var tr = create(doc, 'tr', '');
          headCells.forEach(function addCell(_cell, cellIndex) {
            var td = create(doc, 'td', 'zrp-md-td');
            renderInline(doc, td, row[cellIndex] || '');
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        fragment.appendChild(table);
        continue;
      }

      // Blockquote.
      if (/^\s*>/.test(line)) {
        var quote = create(doc, 'blockquote', 'zrp-md-quote');
        var quoteFirst = true;
        while (index < lines.length && /^\s*>/.test(lines[index])) {
          if (!quoteFirst) quote.appendChild(doc.createElement('br'));
          renderInline(doc, quote, lines[index].replace(/^\s*>\s?/, ''));
          quoteFirst = false;
          index += 1;
        }
        fragment.appendChild(quote);
        continue;
      }

      // Lists (top level; an indented continuation line joins the item).
      var bullet = /^\s*[-*+]\s+/.exec(line);
      var ordered = /^\s*\d+[.)]\s+/.exec(line);
      if (bullet || ordered) {
        var items = [];
        while (index < lines.length) {
          var entry = lines[index];
          if (/^\s*[-*+]\s+/.test(entry) || /^\s*\d+[.)]\s+/.test(entry)) {
            items.push(entry.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
            index += 1;
          } else if (entry.trim() && items.length && /^\s{2,}/.test(entry)) {
            items[items.length - 1] += ' ' + entry.trim();
            index += 1;
          } else {
            break;
          }
        }
        var list = create(doc, ordered ? 'ol' : 'ul', 'zrp-md-list');
        items.forEach(function addItem(item) {
          var li = create(doc, 'li', 'zrp-md-li');
          renderInline(doc, li, item);
          list.appendChild(li);
        });
        fragment.appendChild(list);
        continue;
      }

      // Paragraph: consecutive non-empty, non-structural lines.
      var paragraph = create(doc, 'p', 'zrp-md-p');
      var first = true;
      while (index < lines.length && lines[index].trim()
        && !/^\s*(```|~~~|#{1,4}\s|>|\|)/.test(lines[index])
        && !/^\s*[-*+]\s+/.test(lines[index])
        && !/^\s*\d+[.)]\s+/.test(lines[index])
        && !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[index])) {
        if (!first) paragraph.appendChild(doc.createElement('br'));
        renderInline(doc, paragraph, lines[index].trim());
        first = false;
        index += 1;
      }
      fragment.appendChild(paragraph);
    }
    return fragment;
  }

  var api = { splitThinking: splitThinking, renderMarkdown: renderMarkdown };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZoteroResearchMarkdown = api;
})(globalThis);
