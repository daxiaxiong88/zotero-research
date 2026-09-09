/* TEST ONLY. Refuses to run outside the explicitly marked, newly generated data directory. */
var fixtureConfig;
var fixtureStarted = false;
var fixtureObserver = null;
var fixtureConsoleObserver = null;
var fixtureErrors = [];
var fixtureLastReport = {};
var fixtureReportQueue = Promise.resolve();

async function writeFixtureReport(extra = {}) {
  fixtureLastReport = { ...fixtureLastReport, ...extra };
  const payload = JSON.stringify({
    fixture: 'synthetic-only', zotero: Zotero.version, ...fixtureLastReport,
    pluginErrors: fixtureErrors,
  }, null, 2);
  fixtureReportQueue = fixtureReportQueue.catch(() => {}).then(
    () => IOUtils.writeUTF8(fixtureConfig.reportPath, payload),
  );
  await fixtureReportQueue;
}

async function prepareFixture() {
  if (fixtureStarted) return;
  const win = Zotero.getMainWindow();
  if (!win) return;
  fixtureStarted = true;
  try {
    const scope = Services.env.get('ZRM_SMOKE_ROOT');
    const actual = PathUtils.normalize(Zotero.DataDirectory.dir);
    if (!scope || actual !== PathUtils.normalize(PathUtils.join(scope, 'data'))
      || actual !== PathUtils.normalize(fixtureConfig.dataDirectory)) {
      throw new Error('Refusing fixture creation: isolated data-directory marker mismatch');
    }
    if (fixtureConfig.profileDirectory) {
      const profileFile = Services.dirsvc.get('ProfD', Ci.nsIFile);
      const profile = PathUtils.normalize(profileFile.path);
      if (profile !== PathUtils.normalize(fixtureConfig.profileDirectory)) {
        throw new Error('Refusing fixture creation: isolated profile-directory marker mismatch');
      }
    }
    await Zotero.uiReadyPromise;
    const library = Zotero.Libraries.get(Zotero.Libraries.userLibraryID);
    await writeFixtureReport({
      status: 'fixture_loading_items',
      itemDataLoadedBeforeFixture: library.getDataLoaded('item'),
      itemDataLoadingBeforeFixture: !!library.getDataLoadedPromise('item'),
    });
    await library.waitForDataLoad('item');
    const paper = new Zotero.Item('journalArticle');
    paper.libraryID = Zotero.Libraries.userLibraryID;
    paper.setField('title', 'Zotero Research Synthetic Test — not a real paper');
    paper.setField('date', '2026');
    await paper.saveTx();
    const pdf = await Zotero.Attachments.importFromFile({
      file: fixtureConfig.pdfPath, parentItemID: paper.id,
      title: 'Synthetic two-page PDF', contentType: 'application/pdf',
    });
    const summary = async () => {
      const annotations = pdf.getAnnotations().filter((item) => !item.deleted);
      await writeFixtureReport({
        dataDirectory: actual,
        pluginIDs: await Zotero.Plugins.getAllPluginIDs(),
        serverID: Zotero.Server.LocalAPI.getServerID(),
        itemKey: paper.key, attachmentKey: pdf.key,
        noteCount: paper.getNotes().length,
        annotations: annotations.map((item) => ({
          key: item.key, type: item.annotationType, text: item.annotationText,
          position: JSON.parse(item.annotationPosition),
        })),
      });
    };
    fixtureObserver = Zotero.Notifier.registerObserver({
      notify: () => summary().catch(() => {}),
    }, ['item'], 'zotero-research-synthetic-fixture');
    await writeFixtureReport({
      status: 'fixture_opening', itemKey: paper.key, attachmentKey: pdf.key,
      serverID: Zotero.Server.LocalAPI.getServerID(),
      itemDataLoadedAfterFixture: library.getDataLoaded('item'),
    });
    await Zotero.Reader.open(pdf.id);
    if (fixtureConfig.nativeChecks) {
      await writeFixtureReport({ status: 'fixture_checking_native' });
      Services.scriptloader.loadSubScript(
        await Zotero.Plugins.resolveURI('zotero-research-smoke@local.invalid', 'native-checks.js'),
        globalThis, 'UTF-8',
      );
      const nativeChecks = await runSyntheticNativeChecks(paper, pdf);
      await writeFixtureReport({ nativeChecks });
    }
    await summary();
    await writeFixtureReport({ status: 'fixture_ready' });
  } catch (error) {
    await writeFixtureReport({ status: 'fixture_failed', message: String(error.message || error) });
  }
}

async function startup(data) {
  const scope = Services.env.get('ZRM_SMOKE_ROOT');
  if (!scope || PathUtils.normalize(Zotero.DataDirectory.dir)
    !== PathUtils.normalize(PathUtils.join(scope, 'data'))) return;
  fixtureConfig = { reportPath: PathUtils.join(scope, 'fixture-report.json') };
  try {
    await writeFixtureReport({ status: 'fixture_loading' });
    fixtureConfig = JSON.parse(await Zotero.File.getResourceAsync(data.rootURI + 'fixture.json'));
    fixtureConsoleObserver = {
      observe(message) {
        const text = String(message.message || '');
        if (text.includes('zotero-research') && fixtureErrors.length < 30) {
          fixtureErrors.push(text.slice(0, 4000));
          writeFixtureReport().catch(() => {});
        }
      },
    };
    Services.console.registerListener(fixtureConsoleObserver);
    for (const message of Services.console.getMessageArray?.() || []) {
      fixtureConsoleObserver.observe(message);
    }
    Zotero.uiReadyPromise.then(() => prepareFixture()).catch(() => {});
  } catch (error) {
    await writeFixtureReport({ status: 'fixture_failed', message: String(error.message || error) });
  }
}
function onMainWindowLoad() { Zotero.uiReadyPromise.then(() => prepareFixture()).catch(() => {}); }
function shutdown() {
  if (fixtureObserver) Zotero.Notifier.unregisterObserver(fixtureObserver);
  if (fixtureConsoleObserver) Services.console.unregisterListener(fixtureConsoleObserver);
}
function onMainWindowUnload() {}
function install() {}
function uninstall() {}
