/* TEST ONLY: exercised exclusively inside the guarded synthetic profile. No UI automation,
 * real model or external service is used.
 * Load the packaged production code in a separate Gecko sandbox; do not register another UI.
 */
async function runSyntheticNativeChecks(paper, pdf) {
  const id = 'zotero-research@local.invalid';
  const stage = (nativeStep) => writeFixtureReport({ nativeStep });
  const check = (value, message) => { if (!value) throw new Error('Synthetic check: ' + message); };
  const rejected = async (promise, message) => {
    let failed = false;
    try { await promise; } catch (_) { failed = true; }
    check(failed, message);
  };
  const scope = new Components.utils.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), {
    sandboxName: 'zotero-research-synthetic-native-checks',
    wantGlobalProperties: ['ChromeUtils', 'TextEncoder', 'XMLHttpRequest'],
  });
  Object.assign(scope, { Zotero, Services, IOUtils, PathUtils, setTimeout, clearTimeout });
  let bridge;
  let controller;
  try {
    await stage('load packaged production code');
    for (const resource of ['bootstrap.js', 'content/native.js', 'content/bridge-client.js']) {
      const uri = await Zotero.Plugins.resolveURI(id, resource);
      Services.scriptloader.loadSubScript(uri, scope, 'UTF-8');
    }
    check(scope.zraHash('synthetic').length === 64, 'Gecko SHA-256 adapter');
    const config = JSON.parse(await Zotero.File.getResourceAsync(await Zotero.Plugins.resolveURI(id, 'config.json')));
    const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
    const serverID = () => Zotero.Server.LocalAPI.getServerID();
    bridge = scope.ZoteroResearchBridge.createBridgeClient({
      serverID, request: scope.zraRequest, setTimeout, clearTimeout,
      launch: async () => {
        const child = await Subprocess.call({
          command: config.bridgeExecutable, arguments: [], workdir: config.workingDirectory,
          environment: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, environmentAppend: true,
          stderr: 'pipe',
        });
        (async () => { try { while (await child.stderr.readString()) {} } catch (_) {} })();
        return {
          read: () => child.stdout.readString(),
          stop: async () => {
            await child.stdin.close();
            let timer;
            await Promise.race([child.wait(), new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
            clearTimeout(timer);
            if (child.exitCode === null) await child.kill(0);
          },
        };
      },
    });
    await stage('local bridge health');
    const health = await bridge.rpc('health');
    check(health.zotero.version === Zotero.version && health.zotero.server_id === serverID(), 'bridge identity');
    check(!health.models.local && !health.models.external, 'no inherited real model configuration');
    await stage('synthetic item context and evidence');
    const context = await bridge.rpc('item_context', { item_key: paper.key });
    check(context.item.key === paper.key && context.attachments.some((item) => item.key === pdf.key), 'synthetic item context');
    const evidence = await bridge.rpc('evidence', { attachment_key: pdf.key, query: 'simulated treatment endpoint' });
    check(evidence.evidence.some((entry) => entry.page === 1 && entry.text.includes('twelve percent')), 'page-linked evidence');
    const analysisModes = [];
    const quote = 'The simulated treatment improved the endpoint by twelve percent.';
    for (const mode of ['reading', 'question', 'review', 'explain', 'translate']) {
      await stage('no-model analysis: ' + mode);
      const result = await bridge.rpc('analyze', {
        item_key: paper.key, attachment_key: pdf.key, mode,
        question: 'What does this synthetic scenario test?',
        ...(['translate', 'explain'].includes(mode) ? { selected_text: quote, selection_page: 1 } : {}),
      });
      check(result.mode === 'evidence_only' && result.evidence.length > 0, mode + ' explicit no-model result');
      analysisModes.push(mode);
    }
    await stage('exact locator and native highlight preview');
    const location = await bridge.rpc('locate', { attachment_key: pdf.key, page: 1, quote });
    check(location.status === 'exact' && location.rects.length > 0, 'exact PDF locator');
    controller = scope.ZoteroResearchNative.createHighlightController({
      serverID, digest: async (text) => scope.zraHash(text),
      token: () => Services.uuid.generateUUID().toString(),
      annotationKey: () => Zotero.DataObjectUtilities.generateKey(),
      locate: (args) => bridge.rpc('locate', args),
      attachment: async (key) => {
        check(key === pdf.key, 'only the generated PDF is writable');
        const file = await pdf.getFilePathAsync();
        const stat = await IOUtils.stat(file);
        return {
          key: pdf.key, id: pdf.id, libraryID: pdf.libraryID, parentKey: paper.key,
          editable: Zotero.Libraries.get(pdf.libraryID).editable === true,
          isPDF: true,
          stamp: scope.zraHash(JSON.stringify([file, stat.size, stat.lastModified])),
        };
      },
      save: async (info, data) => {
        check(info.key === pdf.key, 'native annotation target still synthetic');
        const queue = new Zotero.Notifier.Queue();
        let saved;
        try { saved = await Zotero.Annotations.saveFromJSON(pdf, data, { notifierQueue: queue }); }
        finally { await Zotero.Notifier.commit(queue); }
        const reader = Zotero.Reader.getByTabID(Zotero.getMainWindow().Zotero_Tabs.selectedID);
        check(reader && reader.itemID === pdf.id, 'synthetic reader is current');
        await reader.setAnnotations([saved]);
        return saved;
      },
    });
    const before = pdf.getAnnotations().length;
    const highlight = await controller.prepare({ attachment_key: pdf.key, page: 1, quote });
    check(pdf.getAnnotations().length === before, 'highlight preview is read-only');
    await rejected(controller.commit(highlight, false), 'highlight confirmation enforced');
    // This test-generated annotation is the sole deliberate change after fixture creation.
    await stage('native synthetic highlight save and replay guard');
    const created = await controller.commit(highlight, true);
    const annotation = Zotero.Items.getByLibraryAndKey(pdf.libraryID, created.annotation_key);
    check(annotation.annotationText === quote && annotation.parentID === pdf.id, 'native annotation persisted');
    const position = JSON.parse(annotation.annotationPosition);
    check(position.pageIndex === 0 && JSON.stringify(position.rects) === JSON.stringify(location.rects), 'native PDF coordinates preserved');
    await rejected(controller.commit(highlight, true), 'highlight replay denied');
    check(pdf.getAnnotations().length === before + 1, 'exactly one synthetic annotation');
    return {
      status: 'passed', bridge: 'Gecko Subprocess + production XHR',
      analysisModes, modelExecution: 'not configured; evidence-only checked',
      evidence: 'physical page 1',
      highlight: 'one native annotation; exact PDF coordinates; replay rejected',
      annotationKey: annotation.key,
    };
  } finally {
    controller?.destroy();
    await bridge?.close();
    // Some Zotero builds wrap the sandbox for loadSubScript; cleanup must not mask
    // the actual integration failure. This synthetic process exits after testing.
    try { Components.utils.nukeSandbox(scope); } catch (_) {}
  }
}
