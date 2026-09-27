# Stagehand v4 原版扩展验证

验证日期：2026-09-24。此目录是独立实验，不接入 RealCode 生产链路。

## 结论

原版扩展能直接操作跨域浮窗 iframe，结构化快照和操作不依赖截图。
但本次测试暴露了嵌套跨域框架和遮挡点击问题，不能据此直接替换 RealCode 浏览器自动化。
默认 SDK 仍使用 CDP 连接扩展运行时，不是安装扩展后自动连接远端 RealCode 的成品方案。

## 环境与复现

- Windows；Node 24.13.0；Chrome 153.0.8010.53，无头模式、独立配置目录。
- npm `@browserbasehq/stagehand` **4.1.0**，随包 Stagehand Runtime 扩展 **1.0.2**。
- `--site-per-process`，父页 `127.0.0.1` → iframe `localhost` → 内层 iframe `127.0.0.1`。
- CDP `Target.getTargets` 确认两个 iframe target；父页面直接访问子页面 DOM 会抛出跨域异常。
- 普通页面动作全部通过 Stagehand API 执行；额外 CDP 连接只读取浏览器版本、参数与 target。
- 未调用模型，未截图，未访问真实用户账户；结果不能代表 AI 决策速度或任意外部网站成功率。

在本目录执行：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
node verify.mjs --without-extension-debugging
```

可用 `CHROME_PATH` 指定 Chrome 可执行文件。测试会保留独立配置目录和快照到
`realcode/workspace/.realcode/stagehand-v4/`，结束后关闭本次启动的浏览器。
存在未通过的能力断言时返回退出码 1，不能将此实验当作已通过的 CI 门禁。

## 最终结果

两组各 16 项，均为 **13 项通过、3 项失败**，包含启动、环境核对与关闭测试。
以下耗时来自标准组单次测试，仅供复现对照，不是性能基准。

| 验证项 | 结果 | 说明 |
| --- | --- | --- |
| 原版扩展启动 | 通过 | 初始化约 1.19 秒 |
| 跨域隔离及跨进程框架 | 通过 | 保持浏览器安全隔离，真实存在 iframe target |
| 单层 iframe 结构化快照 | 通过 | 返回搜索框、按钮和链接，约 33 ms |
| 完整嵌套快照 | **失败** | 显式等待控件和内层页面就绪后，仍遗漏内层按钮 |
| 动态 DOM 下填写、提交、结果确认 | 通过 | 约 242 ms；每 75 ms 更新无关区域；输入事件 `isTrusted=true` |
| 输入节点替换后复用 locator | 通过 | 约 82 ms，重新定位成功 |
| 两层跨域 iframe 内点击 | **失败** | `Unable to obtain a content frame for selector: #nested` |
| closed Shadow DOM 内点击 | 通过 | 约 31 ms，页面收到事件 |
| 遮挡点击保护 | **失败** | 搜索框上方存在遮挡层，click 返回成功，但事件落在遮挡层 |
| 浏览器侧批量填写和提交 | 通过 | 约 199 ms，含结果事件确认；无需逐步模型调用 |
| console 事件订阅 | 通过 | 收到 `Runtime.consoleAPICalled`，约 22 ms |
| 普通链接在 iframe 内导航 | 通过 | 约 96 ms，父页面及标签数不变 |
| `target=_blank` 链接 | 行为核对通过 | **仍打开新标签页**，不符合 RealCode 的浮窗内导航目标，需要额外策略 |
| 运行时及浏览器关闭 | 通过 | 只关闭测试拥有的浏览器 |

原始结果见 [standard.validation.json](./standard.validation.json) 与
[no-extension-debugging.validation.json](./no-extension-debugging.validation.json)。

初轮未等待内层页面完成时，单层快照也曾遗漏内容，伴随
`Accessibility.getFullAXTree: Frame with the given frameId is not found`。
增加就绪条件后的最终两组中，单层快照通过；不能将初轮现象解释为稳定复现的独立缺陷。

## 接入方式与限制

对发布包源码的核对：

1. SDK 使用 CDP `Extensions.loadUnpacked` 加载运行时，连接其 service worker。
2. 命令通过 `__stagehandReceiveFromHost` 输入；返回值经 `__stagehandSendToHost` binding 回传。
3. 扩展声明 `debugger`、`offscreen`、`scripting`、`tabs` 权限与所有站点访问权限。
4. `page.on` 的公开事件枚举目前只有 `console`，不能据此宣称已提供完整的 DOM、导航、任务状态增量订阅。
5. locator 的 `click` 选项没有 Playwright 的 `timeout`；等待、命中检查与业务结果确认需要独立设计。

官方默认启动参数包含 `--enable-unsafe-extension-debugging`。
**本机 Chrome 153 无头模式移除该参数后，扩展仍成功加载并运行**，且通过 CDP 核实参数确实不存在。
因此不能把这个参数说成所有环境下的必需条件。两组都保留 CDP 调试端口与独立配置目录，
没有验证接管普通启动的日常 Chrome，也没有验证仅安装扩展就能直连远端服务。

对于 RealCode，建议先做运行时适配实验：保留现有扩展到服务端的连接方式，评估如何调用或移植
Stagehand 的浏览器侧能力。适配尚未实现，不能将其当作已经可用的部署方案。
正式集成前至少需要解决：

- 两层跨域框架的 target/session 与定位映射。
- 点击前的遮挡命中检查，以及点击后的业务结果确认。
- 浮窗、父页面与新标签页的目标绑定和导航规则。
- 页面状态变更的增量事件、断线恢复、取消和超时。

参考：[官方浏览器配置](https://docs.stagehand.dev/v4/configuration/browser)、
[官方源码](https://github.com/browserbase/stagehand)、
[Playwright 迁移说明](https://docs.stagehand.dev/v4/migrations/playwright)。
