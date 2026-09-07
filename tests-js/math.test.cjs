const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const md = require(path.join(__dirname, '..', 'addon', 'content', 'markdown.js'));

test('latexToUnicode converts common chat math', () => {
  const cases = [
    ['30^\\circ', '30°'],
    ['\\alpha_i + \\beta^2', 'αᵢ + β²'],
    ['\\frac{a}{b}', 'a/b'],
    ['\\frac{a+b}{c+d}', '(a+b)/(c+d)'],
    ['E = mc^2', 'E = mc²'],
    ['x \\leq 10', 'x ≤ 10'],
    ['\\sqrt{x^2+y^2}', '√(x²+y²)'],
    ['\\mathbb{R}^{n \\times m}', 'ℝ^(n × m)'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(md.latexToUnicode(input), expected, input);
  }
});

test('latexToUnicode returns null for out-of-scope structures', () => {
  assert.equal(md.latexToUnicode('\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}'), null);
  assert.equal(md.latexToUnicode(''), null);
});

test('renderMarkdown converts inline math and keeps currency intact', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;

  const container = doc.createElement('div');
  container.appendChild(md.renderMarkdown(doc,
    '夹角为 $30^\\circ$，系数 $\\alpha_i$ 生效；预算在 $5 和 $10 之间。'));
  assert.match(container.textContent, /30°/);
  assert.match(container.textContent, /αᵢ/);
  assert.match(container.textContent, /\$5 和 \$10/);
  assert.ok(container.querySelector('.zrp-math-inline'));

  const display = doc.createElement('div');
  display.appendChild(md.renderMarkdown(doc, '推导：\n$$E = mc^2$$\n完毕'));
  const block = display.querySelector('.zrp-math-block');
  assert.ok(block, 'display math rendered as block');
  assert.equal(block.textContent, 'E = mc²');
});

test('unconvertible math falls back to a styled raw span', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const container = doc.createElement('div');
  container.appendChild(md.renderMarkdown(doc,
    '矩阵 $\\begin{bmatrix}1&2\\end{bmatrix}$ 不可转换'));
  const raw = container.querySelector('.zrp-math-raw');
  assert.ok(raw, 'raw fallback span rendered');
  assert.match(raw.textContent, /\\begin\{bmatrix\}/);
});
