const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function preferences() {
  const fields = new Map();
  const changes = [];
  const events = [];
  const configURI = 'jar:file:///synthetic-addon.xpi!/config.json';
  const context = vm.createContext({
    URL,
    document: { getElementById: (id) => {
      if (!fields.has(id)) fields.set(id, { value: '', textContent: '' });
      return fields.get(id);
    } },
    Zotero: {
      Prefs: {
        get: (name) => name.endsWith('localModelBaseURL') ? 'http://127.0.0.1:11434/v1' : '',
        set: (name, value) => changes.push([name, value]),
      },
      Plugins: { resolveURI: async (id, resource) => {
        assert.equal(id, 'zotero-research@local.invalid');
        assert.equal(resource, 'config.json');
        return configURI;
      } },
      File: {
        getContentsAsync: async () => ({ responseText: '{}' }), // Zotero 10 returns an XHR for a URI.
        getResourceAsync: async (uri) => {
          assert.equal(uri, configURI);
          return JSON.stringify({ workingDirectory: 'D:\\Synthetic Research' });
        },
      },
    },
    Services: { obs: { notifyObservers: (...args) => events.push(args) } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../addon/content/preferences.js'), 'utf8'), context);
  return { api: context.ZoteroResearchPreferences, fields, changes, events };
}

test('settings load the backend directory from a packaged Zotero 10 jar resource', async () => {
  const h = preferences();
  await h.api.init();
  assert.equal(h.fields.get('zra-backend-path').textContent, '后端目录：D:\\Synthetic Research');
  assert.equal(h.fields.get('zra-local-url').value, 'http://127.0.0.1:11434/v1');
  assert.deepEqual(h.changes, []);
});

test('settings reject external or credential-bearing model URLs without persisting any fields', async () => {
  const h = preferences();
  await h.api.init();
  for (const address of ['https://cloud.example/v1', 'http://user:secret@127.0.0.1/v1', 'http://127.0.0.1/v1?token=secret']) {
    h.fields.get('zra-local-url').value = address;
    h.api.save();
    assert.match(h.fields.get('zra-settings-status').textContent, /回环/);
    assert.deepEqual(h.changes, []);
  }
});

test('settings save only local model names and paths and reconnect via the lifecycle observer', async () => {
  const h = preferences();
  await h.api.init();
  h.fields.get('zra-local-model').value = ' synthetic-local-model ';
  h.api.save();
  assert.equal(h.changes.length, 4);
  assert.ok(h.changes.some(([name, value]) => name === 'researchAssistant.localModelName' && value === 'synthetic-local-model'));
  assert.ok(h.changes.every(([name]) => !/key|token|secret/i.test(name)));
  h.api.reconnect();
  assert.deepEqual(h.events, [[null, 'zotero-research:reconnect']]);
});
