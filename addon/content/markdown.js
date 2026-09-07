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

  // ---------------------------------------------------------------------------
  // LaTeX → Unicode: covers the simple math web AIs emit inline ($30^\circ$,
  // \alpha_i, \frac{a}{b}). Anything still containing commands after the pass
  // returns null and the caller renders the original in a styled raw span.
  // ---------------------------------------------------------------------------

  var LATEX_SYMBOLS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
    varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ',
    varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓',
    leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
    approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', propto: '∝', infty: '∞',
    sum: '∑', prod: '∏', int: '∫', partial: '∂', nabla: '∇',
    in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
    cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
    forall: '∀', exists: '∃', nexists: '∄', neg: '¬', land: '∧', lor: '∨',
    rightarrow: '→', to: '→', leftarrow: '←', Rightarrow: '⇒', implies: '⇒',
    iff: '⇔', leftrightarrow: '↔', mapsto: '↦',
    ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮',
    angle: '∠', perp: '⊥', parallel: '∥', therefore: '∴', because: '∵',
    prime: '′', circ: '∘', star: '⋆', ast: '∗',
    oplus: '⊕', otimes: '⊗', odot: '⊙',
    lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
    degree: '°', percent: '%',
  };

  var SCRIPT_SUPER = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶',
    '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼',
    '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ',
  };
  var SCRIPT_SUB = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆',
    '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌',
    '(': '₍', ')': '₎', 'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ',
    'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ', 'p': 'ₚ', 'r': 'ᵣ',
    's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ', 'v': 'ᵥ', 'x': 'ₓ',
  };
  var LATEX_ACCENTS = {
    hat: '̂', bar: '̄', vec: '⃗',
    tilde: '̃', dot: '̇', ddot: '̈',
  };
  var LATEX_BLACKBOARD = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ' };

  /** Convert ^{…}/^x and _{…}/_x; unmappable bodies fall back to ^(…) or _(…). */
  function scriptPass(text, marker, table) {
    var out = '';
    var index = 0;
    while (index < text.length) {
      if (text[index] !== marker) { out += text[index]; index += 1; continue; }
      var next = index + 1;
      var body = null;
      if (text[next] === '{') {
        var depth = 1;
        var cursor = next + 1;
        while (cursor < text.length && depth > 0) {
          if (text[cursor] === '{') depth += 1;
          else if (text[cursor] === '}') depth -= 1;
          cursor += 1;
        }
        if (depth === 0) { body = text.slice(next + 1, cursor - 1); index = cursor; }
      } else if (next < text.length && /[^\s]/.test(text[next])) {
        body = text[next];
        index = next + 1;
      }
      if (body === null) { out += text[index]; index += 1; continue; }
      var converted = '';
      var mappable = true;
      for (var position = 0; position < body.length; position += 1) {
        var character = body[position];
        if (table[character]) converted += table[character];
        else if (character === ' ') converted += ' ';
        else { mappable = false; break; }
      }
      if (mappable) out += converted;
      else out += marker + '(' + body + ')';
    }
    return out;
  }

  /** Convert common LaTeX to readable Unicode; null when too complex. */
  function latexToUnicode(input) {
    var text = String(input || '').trim();
    if (!text) return null;

    // Sizing and spacing commands carry no meaning in plain text.
    text = text.replace(/\\(?:left|right|big|Big|bigg|Bigg|bigl|bigr|Bigl|Bigr)\b/g, '');
    text = text.replace(/\\[,;:!]|\\(?:quad|qquad)\b/g, ' ');

    // Fractions, roots, accents, text wrappers — structural commands first.
    for (var guard = 0; guard < 12 && /\\[dt]?frac\s*\{/.test(text); guard += 1) {
      text = text.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
        function fraction(match, top, bottom) {
          return (top.length <= 2 ? top : '(' + top + ')')
            + '/' + (bottom.length <= 2 ? bottom : '(' + bottom + ')');
        });
    }
    text = text.replace(/\\sqrt\s*\{([^{}]*)\}/g, function root(match, body) {
      return '√(' + body + ')';
    });
    text = text.replace(/\\sqrt\b/g, '√');
    text = text.replace(/\\(hat|bar|vec|tilde|dot|ddot)\s*\{([^{}]*)\}/g,
      function accent(match, kind, body) {
        return body + LATEX_ACCENTS[kind];
      });
    text = text.replace(
      /\\(?:text|mathrm|mathbf|mathit|mathsf|operatorname|textbf|textit|bm)\s*\{([^{}]*)\}/g,
      '$1');
    text = text.replace(/\\mathbb\s*\{([^{}]*)\}/g, function blackboard(match, body) {
      return LATEX_BLACKBOARD[body] || body;
    });

    // ^{\circ} / ^\circ becomes a plain degree sign before script handling.
    text = text.replace(/\^\s*\{?\\circ\}?/g, '°');

    // Named symbols and operators.
    text = text.replace(/\\([A-Za-z]+)/g, function symbol(match, name) {
      return Object.prototype.hasOwnProperty.call(LATEX_SYMBOLS, name)
        ? LATEX_SYMBOLS[name]
        : match;
    });
    // Escaped literals and leftover spacing.
    text = text.replace(/\\([%&#{}_])/g, '$1');
    text = text.replace(/\\[,;:!]/g, ' ');

    // Superscripts then subscripts; unmappable bodies stay readable.
    text = scriptPass(text, '^', SCRIPT_SUPER);
    text = scriptPass(text, '_', SCRIPT_SUB);

    // Grouping braces are meaningless once the structure is flattened.
    text = text.replace(/[{}]/g, '');
    // Anything still commanding (matrices, cases, align, …) is out of scope.
    if (/\\[A-Za-z]/.test(text)) return null;
    text = text.replace(/\s{2,}/g, ' ').trim();
    return text || null;
  }

  /** Render one math segment: converted when possible, styled raw otherwise. */
  function renderMathSpan(doc, parent, latex, display) {
    var converted = latexToUnicode(latex);
    if (converted !== null) {
      parent.appendChild(create(doc, 'span',
        display ? 'zrp-math zrp-math-block' : 'zrp-math zrp-math-inline', converted));
      return;
    }
    parent.appendChild(create(doc, 'span',
      display ? 'zrp-math-raw zrp-math-block' : 'zrp-math-raw zrp-math-inline',
      (display ? '' : '$') + String(latex).trim() + (display ? '' : '$')));
  }

  /** Heuristic: a $…$ span is math when it looks like math, not currency. */
  function looksLikeMath(content) {
    if (!content || content.length > 400) return false;
    if (/^\s|\s$/.test(content)) return false;
    return /[\\^_{}]|\\/.test(content);
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

  /** Core inline pass: bold/italic/code/strike/links, all built as DOM nodes. */
  function renderInlineCore(doc, parent, source) {
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

  /** Inline pass with $…$ math segments split out before Markdown rules. */
  function renderInline(doc, parent, source) {
    var text = String(source || '');
    var math = /\$([^$\n]+)\$/g;
    var cursor = 0;
    var match;
    while ((match = math.exec(text)) !== null) {
      if (match.index > cursor) renderInlineCore(doc, parent, text.slice(cursor, match.index));
      if (looksLikeMath(match[1])) renderMathSpan(doc, parent, match[1], false);
      else appendText(parent, match[0]);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) renderInlineCore(doc, parent, text.slice(cursor));
  }

  function isTableDivider(line) {
    return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.indexOf('-') >= 0;
  }

  function splitTableRow(line) {
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
      .map(function trim(cell) { return cell.trim(); });
  }

  /** Block pass: math blocks, fenced code, headings, lists, quotes, tables, rules, paragraphs. */
  function renderMarkdown(doc, source) {
    var fragment = doc.createDocumentFragment();
    var lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
    var index = 0;

    while (index < lines.length) {
      var line = lines[index];

      // Display math block: $$…$$ on one line or across lines.
      if (/^\s*\$\$/.test(line)) {
        var single = /^\s*\$\$(.+)\$\$\s*$/.exec(line);
        if (single) {
          renderMathSpan(doc, fragment, single[1], true);
          index += 1;
          continue;
        }
        var mathLines = [];
        index += 1;
        while (index < lines.length && lines[index].indexOf('$$') < 0) {
          mathLines.push(lines[index]);
          index += 1;
        }
        index += 1; // closing $$
        renderMathSpan(doc, fragment, mathLines.join('\n'), true);
        continue;
      }

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
        && !/^\s*(```|~~~|#{1,4}\s|>|\||\$\$)/.test(lines[index])
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

  var api = {
    splitThinking: splitThinking,
    renderMarkdown: renderMarkdown,
    latexToUnicode: latexToUnicode,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZoteroResearchMarkdown = api;
})(globalThis);
