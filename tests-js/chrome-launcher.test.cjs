const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const launcher = path.join(__dirname, '..', 'scripts', 'start_chrome_relay.ps1');
// Exercise the real script with only OS/process boundaries mocked. No test
// launches, closes, or modifies the user's Chrome.
function runLauncher(running, extra = '') {
  return spawnSync('powershell.exe', ['-NoProfile', '-Command', `
    function Test-Path { param($LiteralPath, $PathType) return $true }
    function Get-CimInstance { param($ClassName, $Filter) ${running ? '[pscustomobject]@{ Name = "chrome.exe" }' : ''} }
    function Start-Process { param($FilePath, $ArgumentList, $WindowStyle)
      [pscustomobject]@{ launch = $true; path = $FilePath; args = $ArgumentList; window = $WindowStyle } | ConvertTo-Json -Compress
    }
    & '${launcher.replace(/'/g, "''")}' ${extra}
    exit $LASTEXITCODE
  `], { encoding: 'utf8', timeout: 10000 });
}

test('Chrome relay launcher refuses to launch into an existing process', { skip: process.platform !== 'win32' }, () => {
  const result = runLauncher(true);
  assert.equal(result.status, 2, result.stderr);
  assert.doesNotMatch(result.stdout, /"launch"/);
});

test('Chrome relay launcher uses only the reversible occlusion switch and the normal profile', { skip: process.platform !== 'win32' }, () => {
  const result = runLauncher(false);
  assert.equal(result.status, 0, result.stderr);
  const launch = JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith('{')));
  assert.deepEqual(launch.args, ['--disable-backgrounding-occluded-windows', 'https://gemini.google.com/app']);
  assert.equal(launch.window, 'Normal');
  assert.match(launch.path, /Google\\Chrome\\Application\\chrome\.exe$/);
});

test('Chrome relay launcher check mode never starts the browser', { skip: process.platform !== 'win32' }, () => {
  const result = runLauncher(false, '-CheckOnly | ConvertTo-Json -Compress');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /"launch"/);
  assert.match(result.stdout, /CanStart/);
});
