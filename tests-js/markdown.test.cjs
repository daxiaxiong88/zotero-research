const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const markdown = require('../addon/content/markdown.js');
const dom = new JSDOM('<!doctype html><body></body>');
const doc = dom.window.document;

function render(text) {
  const fragment = markdown.renderMarkdown(doc, text);
  const container = doc.createElement('div');
  container.appendChild(fragment);
  return container;
}

test('splitThinking separates closed and unclosed think blocks', () => {
  assert.deepEqual(markdown.splitThinking('<think>推理</think>\n答案'), {
    think: '推理',
    answer: '答案',
  });
  assert.deepEqual(markdown.splitThinking('前文 <think>还在想'), {
    think: '还在想',
    answer: '前文',
  });
  assert.deepEqual(markdown.splitThinking('没有思考标签'), {
    think: '',
    answer: '没有思考标签',
  });
});

test('renders headings, lists, bold and inline code', () => {
  const container = render('# 标题\n\n- 项目 **重点**\n- `code`\n\n普通段落');
  assert.equal(container.querySelector('h2').textContent, '标题');
  const items = container.querySelectorAll('.zrp-md-list li');
  assert.equal(items.length, 2);
  assert.equal(items[0].querySelector('strong').textContent, '重点');
  assert.equal(items[1].querySelector('code').textContent, 'code');
  assert.ok(container.querySelector('.zrp-md-p'));
});

test('renders fenced code blocks literally', () => {
  const container = render('说明\n\n```python\nx = "<img src=x>"\n```\n\n结束');
  const code = container.querySelector('.zrp-md-codeblock');
  assert.equal(code.textContent, 'x = "<img src=x>"');
  assert.equal(container.querySelectorAll('.zrp-md-p').length, 2);
});

test('renders markdown tables', () => {
  const container = render('| 方法 | Acc |\n| --- | --- |\n| A | 0.9 |\n| B | 0.8 |');
  const table = container.querySelector('.zrp-md-table');
  assert.equal(table.querySelectorAll('th').length, 2);
  assert.equal(table.querySelectorAll('td').length, 4);
  assert.equal(table.querySelectorAll('td')[0].textContent, 'A');
});

test('links render only for http(s) with plain labels', () => {
  const container = render('见 [论文](https://example.com/a?b=1) 和 [危险](javascript:alert(1))');
  const links = container.querySelectorAll('a.zrp-md-link');
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), 'https://example.com/a?b=1');
  assert.equal(links[0].textContent, '论文');
  assert.match(container.textContent, /\[危险\]/);
});

test('hostile markup stays literal text', () => {
  const container = render('<img src=x onerror=window.__xss=1> <script>alert(1)<\/script> [x](https://e.com)');
  assert.equal(container.querySelector('img'), null);
  assert.equal(container.querySelector('script'), null);
  // The single http link renders as a text-only anchor; the payloads do not.
  const links = container.querySelectorAll('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), 'https://e.com');
  assert.equal(links[0].querySelector('img'), null);
  assert.match(container.textContent, /onerror=window.__xss=1/);
});

test('paragraph prose with numbers never becomes a link', () => {
  const container = render('实验共 3 组，样本 40 个。');
  assert.equal(container.querySelectorAll('a').length, 0);
  assert.match(container.textContent, /共 3 组/);
});

test('ordered lists, quotes and rules', () => {
  const container = render('1. 第一\n2. 第二\n\n> 引用文字\n\n---\n');
  assert.equal(container.querySelectorAll('ol li').length, 2);
  assert.equal(container.querySelector('blockquote').textContent, '引用文字');
  assert.ok(container.querySelector('hr'));
});
