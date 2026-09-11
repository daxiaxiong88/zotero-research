[CmdletBinding()]
param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$chromeCandidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe' }),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$chromeExecutable = $chromeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $chromeExecutable) {
    Write-Error '没有找到 Google Chrome。请先安装 Chrome，或使用两个窗口并排的临时方案。'
    exit 1
}

# Existing Chrome processes silently reuse their original startup switches.
# Never close them automatically: they may contain unsaved work.
$runningChrome = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'chrome.exe'")
$chromeArguments = @('--disable-backgrounding-occluded-windows', 'https://gemini.google.com/app')
if ($CheckOnly) {
    [pscustomobject]@{
        Executable = $chromeExecutable
        Arguments = $chromeArguments
        RunningChromeProcesses = $runningChrome.Count
        CanStart = $runningChrome.Count -eq 0
    }
    return
}
if ($runningChrome.Count -gt 0) {
    Write-Host 'Chrome 仍在运行。请保存未发送内容，并通过 Chrome 菜单“退出”正常退出全部窗口后，再运行本启动器。' -ForegroundColor Yellow
    Write-Host '本启动器不会结束进程、关闭标签页或删除数据。'
    exit 2
}

# Deliberately only the occlusion switch: do not disable web security,
# renderer sandboxing, all background timers, or change the profile.
# This is an interactive browser the user is explicitly starting, not a
# background helper. Normal launch keeps its usual profile/login/session.
Start-Process -FilePath $chromeExecutable -ArgumentList $chromeArguments -WindowStyle Normal
Write-Host '已启动科研联动 Chrome。请使用原有 Gemini 对话；需要时重新连接 Zotero。'
Write-Host '恢复默认行为：正常退出本次 Chrome，然后用原来的 Chrome 图标启动。'
