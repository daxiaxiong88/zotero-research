# Gemini 被遮挡时回传停顿：诊断记录

## 已知事实

2026-09-11 用户提供的报告确认运行脚本 1.0.20 / `relay-latency-1`，无需再用“没更新脚本”解释故障。

- 本轮图片投递确认成功，发送已确认。
- 07:08:44.343 UTC 记录正文进度，下一条记录出现在 07:10:17.631 UTC，中间约 93 秒。
- 最终回传 2033 字、耗时 159 毫秒、`recovered: true`，任务最终为 `delivered`。
- 同一运行实例上一轮也存在约 86 秒的回调间隔。
- 用户表示 Chrome 窗口未最小化，但被 Zotero 遮住；点击 Chrome 后能看到网页继续输出，随后侧栏补齐。
- 截图显示节能模式只在电量不高于 20% 时启用；检查时电池为 100%、充电状态。该读取不能反推故障时的电源状态，但不能仅凭开关开启就归因节能模式。

这些证据倾向于后台执行/回调受阻，不是图片未上传或最终文本传输本身很慢。**日志未记录实际 `freeze/resume` 事件，不能据此认定具体冻结策略已被证实。**

## 原测试的边界

常规 Playwright 启动默认包含后台限流相关禁用参数，并通过 `Emulation.setFocusEmulationEnabled` 模拟聚焦。手动覆盖 `document.hidden` 或停掉页面计时器不能复现浏览器整个执行环境暂停。

因此，之前受控夹具中 155 毫秒显示的结果只验证正文选择与中继链路，不代表真实窗口被遮挡时的表现。

新增 `tests-browser/page-freeze.spec.cjs` 使用独立空白配置、无后台禁用参数的真实 Chrome，通过 `connectOverCDP(..., { noDefaults: true })` 禁用测试聚焦覆盖。所有页面请求均拦截，不连接用户已登录浏览器。

验证内容：真实 `freeze` 事件发生后，已就绪的回调及 8 秒独立超时均不能在 9 秒的冻结期内驱动重试；真实 `resume` 后，同一任务能继续回传，不重复发送用户问题。测试明确断言生命周期事件，不将未实际冻结的运行误判为通过。

```powershell
$env:ZRA_TEST_CHROME_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npx playwright test tests-browser/page-freeze.spec.cjs --browser=chromium --workers=1
```

该测试证明机制和恢复边界，不证明用户故障一定由 Chrome 的 `freeze` 策略触发。本次没有为此提高轮询频率、延长超时或发布声称已解决故障的新脚本。

## 实际对照与处理

用户已完成对照：让 Gemini 和 Zotero 并排、网页正文保持可见，从侧栏发送新问题，期间不点击 Gemini，**能持续回传，不再卡住**。这支持窗口完全遮挡时的后台限制是本例关键触发条件，仍不等同于已经观察到实际 `freeze` 事件。

新增 `scripts/start_chrome_relay.cmd` 与配套 PowerShell 脚本，仅为 Chrome 添加 `--disable-backgrounding-occluded-windows`。不添加全局定时器限流开关、不禁用安全机制、不改用户配置目录，不清除登录/会话。

使用：保存未发送内容，通过 Chrome 菜单“退出”正常退出全部窗口，再双击 `.cmd` 启动。Chrome 已运行时启动参数不会可靠应用，所以脚本检查到任何 Chrome 进程时拒绝启动并提示正常退出，绝不自动结束进程。

它会打开 Gemini 入口；如未停留在原聊天，从 Gemini 历史记录回到原对话并按需连接 Zotero。然后再次完全遮挡 Chrome 验证。恢复默认行为只需正常退出此次 Chrome，再用原来的 Chrome 图标启动。其他 Chrome 窗口也属于同一浏览器进程，因此本次启动中同样受该遮挡开关影响，可能增加后台 CPU/耗电。

可只读检查，不启动浏览器：

```powershell
./scripts/start_chrome_relay.ps1 -CheckOnly
```

如系统阻止 PowerShell 脚本执行，不要关闭全局脚本安全策略；可在保存工作并正常退出 Chrome 后，在终端手动运行等价命令（使用实际安装路径）：

```powershell
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --disable-backgrounding-occluded-windows https://gemini.google.com/app
```

启动器的已运行拒绝、参数范围、只读模式有自动测试。**尚未替用户退出 Chrome 或完成启动参数生效后的真实遮挡复测，不应宣称已在用户会话中解决。** 此 Chromium 开关属于测试用途的启动参数，后续浏览器升级可能改变支持情况；如失效可暂时保持窗口并排，不继续堆叠其他全局参数。

## 后续验证：长知识沉淀仍有残余停顿

用户进一步确认：通过启动器重启后，普通对话几乎可用，但长知识沉淀仍可能在回到 Gemini 时才继续。只读进程检查也确认主 Chrome 带遮挡参数，因此不能继续归因“启动器未使用”。

之后收到新诊断：当前实例已重载、`lastTask` 为空，但前一个 `recentRuntimes` 保存了任务 `task-16-jfz1yvh8`。08:03:43.346 至 08:06:07.471 UTC 共约 144 秒，9489 字、3351590 字符累计网络响应、10 次网络捕获、3 次心跳；最终请求 296 ms、`recovered: true`。20 条普通事件已被之后的空闲轮询覆盖，不能重建中间每次停顿。

根据响应量构造合法数据的未完成末帧，复现 `extractGeminiFrames` 的二次方重扫：14 万字符时旧代码从 1008 个候选方括号起点重扫；改为不完整外层帧等待后续数据后，只有 2 次搜索。保留上一完整帧的正文，不从引号中的数据误读协议；下批完整数据仍正确读取。

同规模基准：`node docs/diagnostics/benchmark-gemini-parser.cjs 12c2610`，3351085 字符 / 正文内 1000 个方括号，旧版 **34461 ms / 1008 次搜索**，新版 **86 ms / 2 次搜索**。这是可复现的同步阻塞缺陷，足以耽误心跳和页面回调；与用户低心跳现象一致，但没有真实响应字节，不能断言它解释全部 144 秒停顿。基准使用合成内容，不访问账号或联网。

0.8.11 候选版把原有遮挡参数的启动接入侧栏打开/未连接时首次发送。辅助 PowerShell 运行状态检查在本机被防护拦截，已撤去该设计，未绕过防护；生产插件只查常见可执行文件路径并直接用 `nsIProcess.runwAsync` 传递参数，不读取进程命令行、不调用 PowerShell，也不声称能判断已运行 Chrome 的参数是否生效。旧独立启动器仅作手动备用，插件不依赖它。

已复现并修正一个捕获边界：长 XHR 只产生进度事件时，旧捕获器滞留第一句。新回归通过 `progress` 扩展到完整长答案，`loadend` 读取末尾，重复事件不重复解析。这是防遗漏修正，尚不能证明它就是本次实际故障根因。

脚本 1.0.21 新增真实生命周期事件、心跳调度延迟及解析耗时记录；任务自己的 24 条时间线不再被空闲轮询冲掉。恢复时立即采样本轮答案，不重发问题。保留真实冻结测试验证“冻结时不能执行、恢复后补回”，不以延长 90 秒超时掩盖故障。原始窗口遮挡下的长知识沉淀复测仍未完成。

## 官方资料（参考链接）

- [Windows 窗口遮挡优化](https://blog.chromium.org/2021/12/chrome-windows-performance-improvements-native-window-occlusion.html)：完全被其他窗口覆盖时，Chrome 可按后台标签页处理，不等同于必须最小化。
- [页面生命周期](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)：冻结会暂停可冻结任务队列，页面内计时器无法解除这种暂停。
- [节能模式冻结](https://developer.chrome.com/blog/freezing-on-energy-saver)：节能模式是可能的触发条件之一，但不是本例已经证实的原因。
- [Chromium 启动开关源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/common/content_switches.cc)：`kDisableBackgroundingOccludedWindowsForTesting` 对应本启动器采用的遮挡开关。
