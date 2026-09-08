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

test('renderMarkdown typesets inline and display math while keeping currency intact', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;

  const container = doc.createElement('div');
  container.appendChild(md.renderMarkdown(doc,
    '夹角为 $30^\\circ$，系数 $\\alpha_i$ 生效；预算在 $5 和 $10 之间。'));
  assert.equal(container.querySelectorAll('.zrp-math-rendered math').length, 2);
  assert.match(container.textContent, /\$5 和 \$10/);
  assert.ok(container.querySelector('.zrp-math-inline'));

  const display = doc.createElement('div');
  display.appendChild(md.renderMarkdown(doc, '推导：\n$$E = mc^2$$\n完毕'));
  const block = display.querySelector('.zrp-math-block');
  assert.ok(block, 'display math rendered as block');
  assert.ok(block.querySelector('math'));
});

test('malformed math falls back to safe literal text', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const container = doc.createElement('div');
  container.appendChild(md.renderMarkdown(doc,
    '错误公式 $\\frac{1}{$ 不可转换 <img src=x onerror=alert(1)>'));
  const raw = container.querySelector('.zrp-math-raw');
  assert.ok(raw, 'raw fallback span rendered');
  assert.match(raw.textContent, /\\frac\{1\}\{/);
  assert.equal(container.querySelector('img'), null);
});

test('renders the long research formulas emitted by web AI as structured math', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const container = doc.createElement('div');
  container.appendChild(md.renderMarkdown(doc,
    '- 负样本：$\\mathcal{N}_t := \\{n_t^1, \\dots, n_t^K\\} \\subset \\{q_1, \\dots, q_L\\}$\n'
    + '- 对比损失：$\\mathcal{L}(a_t,q_t,\\mathcal{N}_t) = -\\log \\frac{\\exp[\\operatorname{sim}(a_t,q_t)/\\kappa]}{\\exp[\\operatorname{sim}(a_t,q_t)/\\kappa] + \\sum_{n \\in \\mathcal{N}_t} \\exp[\\operatorname{sim}(a_t,n)/\\kappa]}$'));

  assert.equal(container.querySelectorAll('.zrp-math-rendered math').length, 2);
  assert.ok(container.querySelector('mfrac'), 'the InfoNCE fraction is typeset');
  assert.ok(container.querySelector('msub'), 'subscripts are represented structurally');
  assert.equal(container.querySelector('.zrp-math-raw'), null);
});

test('renders Gemini-style parenthesis and bracket math delimiters', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const container = doc.createElement('div');
  container.appendChild(md.renderMarkdown(doc,
    '行内 \\(K=100\\) 与含括号的 \\(f(x)=K\\) 保持在句中。\n'
    + '网页偶尔把块公式放在行中：$$\\frac{a}{b}$$ 后面继续说明。\n'
    + '\\[\n\\mathcal{L}=-\\log p(y \\mid x)\n\\]'));

  assert.equal(container.querySelectorAll('.zrp-math-rendered math').length, 4);
  assert.ok(container.querySelector('.zrp-math-inline math'));
  assert.equal(container.querySelectorAll('.zrp-math-block math').length, 2);
  assert.equal(container.textContent.includes('$$'), false);
});
