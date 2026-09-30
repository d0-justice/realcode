# Pebrel 的 Codex `--no-daemon` 补丁：下次更新指南

本目录保存针对 **Pebrel 2.0.0** 的 [`codex-no-daemon.patch`](codex-no-daemon.patch)。目标是让 **Pebrel 自动发出的** Codex CLI 命令都带上 `--no-daemon`，避免当前环境中共享 daemon 引起的 Terminal 闪窗。2026-09-30 用户确认修正后的 `Pebrel-v2.0.0-no-daemon-v2` 包可用。更新上游源码后必须重新验证，不能把这次反馈当作新版本的验收结果。

## 新会话先看这里

1. 阅读源码根目录的 `AGENTS.md`、`nebula_app/AGENTS.md`、`packaging/AGENTS.md` 和本文。构建、打包还需遵守 `docs/release-notes/AGENTS.md`；如果源码里有 `.agents/memory.md`，阅读其发布章节。
2. 在**独立工作副本**中放入新的上游源码和整个 `patch/` 目录。保留一份未修改的上游基线，供补丁冲突时比较。不要把副本放在其他 Git 仓库的子目录中；如果使用源码压缩包，可在独立副本根目录执行 `git init`，确保 Git 根目录就是 Pebrel 源码根目录。
3. 从源码根目录执行下方“应用补丁”命令，逐项确认 8 个文件被检查和应用。随后运行测试、构建新的便携包，并在 Windows 上做现场验证。

## 补丁改了什么

| Pebrel 自动发起的场景 | 原命令 | 补丁后的命令 | 入口 |
| --- | --- | --- | --- |
| 新建会话，包括 Runtime API `agent.start` | `codex` | `codex --no-daemon` | `AgentKind::start_command` |
| 冷恢复、会话列表按 ID 恢复 | `codex resume <id>` | `codex --no-daemon resume <id>` | `AgentKind::resume_command` |
| 分叉已有会话 | `codex fork <id>` | `codex --no-daemon fork <id>` | `AgentKind::fork_command` |
| 恢复 ID 丢失后打开选择器 | `codex resume` | `codex --no-daemon resume` | `TerminalView::choose_codex_recovery_session` |

前三个入口在 `nebula_app/src/ai_agents.rs`，第四个在 `nebula_app/src/gpui_shell/terminal/view/startup_command.rs`。补丁还更新 `ai_sessions`、`session`、`ai_hook`、Runtime API 和 GPUI 启动测试，共涉及 8 个文件。`--no-daemon` 是全局选项，放在 `resume`、`fork` 前面；本机 Codex CLI 0.159.2 的 `--help` 已验证这种写法。Codex 自己输出的 `Run codex resume without an ID` 错误文案不改，因为那不是 Pebrel 发出的命令。

补丁不改用户在终端手动输入的 `codex`，也不改 Codex 全局配置、PowerShell profile 或 hooks。如果新版本增加了其他自动启动 Codex 的入口，需要将其纳入同一检查。

## 应用补丁：必须确认没有跳过

在新的 Pebrel **工作副本源码根目录**执行；以下命令中的路径换成该副本的实际路径：

```powershell
Set-Location 'D:\git\rust\pebrel-NEW'
git rev-parse --show-toplevel
git apply --stat patch/codex-no-daemon.patch
git apply --verbose --check patch/codex-no-daemon.patch
git apply --verbose patch/codex-no-daemon.patch
```

`git rev-parse --show-toplevel` 必须指向当前 Pebrel 副本，`--stat` 必须列出 **8 个文件**，`--check` 必须逐文件显示 `Checking patch ...`，实际应用必须逐文件显示 `Applied patch ... cleanly`。若 `--stat` 显示 `0 files changed` 或出现 `Skipped patch`，**立即停止**：补丁没有生效，即使命令退出码为 0。先修正工作目录或 Git 根目录，再重新检查。不要用 `--unsafe-paths`、`--3way` 或强制选项掩盖上下文不匹配。

这条检查来自一次真实失误：首个 `Pebrel-v2.0.0-no-daemon` 包在外层 `easy-graph` 仓库的 `.tmp` 子目录执行 `git apply`，所有文件被跳过，但命令返回成功；那个包的二进制**没有包含补丁**。已确认可用的是后来的 `Pebrel-v2.0.0-no-daemon-v2` 包。

## 上游改动导致补丁冲突时

1. 保留未修改的上游基线；在另一份独立工作副本中找到上述四个命令生成入口。不要仅按旧行号套用。
2. 将四条命令及对应测试改为表中的值。搜索其他 Pebrel 自动生成的 Codex 命令；保留 CLI 输出、身份识别和用户手动命令的原意。
3. 在有未修改上游基线的 Git 工作副本中运行 `git diff --check`，再用 `git diff --output=patch/codex-no-daemon.patch -- <修改的源文件路径>` 重新生成补丁。Windows PowerShell 5.1 的 `>` 可能写出 UTF-16，因此使用 Git 的 `--output` 参数。
4. 用**另一份干净副本**重复“应用补丁”步骤，并核对生成的源码与准备构建的源码一致。补丁成功应用和代码实际改变都要检查。

若新上游已有等效修复，先核对四个可观察命令及测试，再决定是否缩减或停用本地补丁。不要因为旧补丁无法应用就直接声明新版本已解决闪窗。

## 构建与测试

在已确认打上补丁的工作副本源码根目录执行：

```powershell
rg -n -F 'codex --no-daemon' nebula_app/src/ai_agents.rs nebula_app/src/gpui_shell/terminal/view/startup_command.rs
cargo test --locked -p nebula --bin pebrel --features gpui-shell commands_are_exact_and_injection_safe
cargo test --locked -p nebula --bin pebrel --features gpui-shell resume
cargo test --locked -p nebula --bin pebrel --features gpui-shell agent_start_exposes_only_verified_launch_contracts
cargo test --locked -p nebula --bin pebrel --features gpui-shell,gpui-test-support gpui_shell::terminal::view::startup_tests::
```

源码要求 Rust 1.97.1，见 `rust-toolchain.toml`。Windows x64 包还需要 `assets/windows/conhost/conpty.dll` 与 `OpenConsole.exe`；源码压缩包可能缺少它们。用 `scripts/prepare-windows-runtime.ps1 -Destination assets/windows/conhost` 获取脚本固定版本的组件；若使用已有组件，先核对该脚本列出的 SHA-256 和架构。

对本地自定义便携包，可先构建两个二进制，再让项目打包脚本检查新鲜度与文件清单：

```powershell
$env:CARGO_TARGET_DIR = 'D:\git\rust\pebrel-build-no-daemon\target'
cargo build --locked --release -p nebula --bin pebrel -p nebula_hook --bin pebrel-hook --features nebula/gpui-shell
if ($LASTEXITCODE -ne 0) { throw 'Cargo build failed' }
& .\scripts\package-release.ps1 -Version '2.0.0' -SkipBuild -TargetDirectory $env:CARGO_TARGET_DIR -OutputDirectory 'D:\git\rust\pebrel-build-no-daemon\dist'
```

上述 `-SkipBuild` 只用于**已在上一行新鲜构建**的本地自定义包；不要加 `-AllowStale`。正式发布应按 `packaging/AGENTS.md` 运行完整打包流程。`-Version` 必须与新源码的 `pebrel.exe --version` 一致，不能填 `2.0.0-no-daemon`；包名可以在验证后另行标注。构建时使用独立 target 目录，避免覆盖正在运行的 Pebrel 程序。

打包后检查 `pebrel.exe --version`、可执行文件时间戳、SHA-256、ZIP 中 17 项清单及目标架构。不要只验证构建命令返回成功。新上游版本若改变清单数量，以其打包脚本的真实清单为准。

## Windows 现场验收

完全退出旧 Pebrel，包括托盘驻留；从新便携包目录运行新 `pebrel.exe`。分别通过 Pebrel 新建 Codex 会话、恢复已有会话、分叉会话，并在会话中发送消息。确认启动命令带 `--no-daemon` 且此前的 Terminal 闪窗没有复现。记录测试所用的 Pebrel 路径、版本、Codex CLI 版本和结果。若仍闪窗，检查是否运行了旧二进制，并将 Codex hooks 的行为作为独立原因排查。

## 已知可用基线（2026-09-30）

- 用户确认 `D:\git\rust\Pebrel-v2.0.0-no-daemon-v2\pebrel.exe` 可用；先前的 `Pebrel-v2.0.0-no-daemon` 已失效。
- v2 `pebrel.exe` SHA-256：`CD76930CF2F925DDBFCA0416AA574662719BFA048B81A60F0288DE7D1EEB2654`；补丁 SHA-256：`7C460CF1E2D506E96DFC107F80F57418721E714133A7F5010C0E8A7CB49F72C5`。
- 当时通过：命令测试 2 项、恢复相关 17 项、Runtime API 启动 1 项、GPUI `startup_tests` 23 项。上游更新后重新运行，不沿用旧结论。
