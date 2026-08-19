# Changelog

## Unreleased

No unreleased changes yet.

## 0.1.0 — 2026-08-20 (First Multi-platform Release / 首个多平台版本)

> **同一个任务边界核心，现在有四套宿主适配：Codex、Claude Code、
> OpenCode 和 Hermes Agent CLI。** 0.1.0 是 Stop That Shit 的首个多平台
> 正式版本。
>
> **One task-boundary core now has four host adapters: Codex, Claude Code,
> OpenCode, and Hermes Agent CLI.** Version 0.1.0 is the first multi-platform
> release of Stop That Shit.

### 重点内容：你现在可以 / Highlights

- 从同一个 GitHub tag 获取四种宿主的安装入口，同时继续共用同一份
  Stop Ladder、合同状态、决策策略和只存元数据的 Runtime。
  / Install four host entrypoints from one GitHub tag while sharing the same
  Stop Ladder, contract state, decision policy, and metadata-only Runtime.
- 在 Codex 与 Claude Code 中使用原生 Plugin + Hook，在 OpenCode 中使用
  GitHub 安装的插件入口，在 Hermes Agent CLI 中使用原生 Plugin 回调。
  / Use native Plugin and Hook surfaces in Codex and Claude Code, a
  GitHub-installed plugin entrypoint in OpenCode, and native Plugin callbacks
  in Hermes Agent CLI.
- 保留每个宿主自己的安装、信任与重启流程；统一的是版本和核心，不是假装
  四个平台拥有完全相同的生命周期。
  / Keep each host's own installation, trust, and restart lifecycle; the shared
  contract is the version and core, not an artificial claim that every host
  behaves identically.

### 概览 / Overview

0.1.0 把 0.0.3 的 Codex 基础和三项后续适配收进同一个版本。Claude Code
Adapter 把 `SessionStart`、`UserPromptSubmit`、`PreToolUse` 和
`SubagentStart` 归一化为现有控制协议；OpenCode Adapter 使用文档化事件与
SDK，并提供 GitHub 安装入口；Hermes Agent CLI Adapter 通过
`pre_llm_call` 与 `pre_tool_call` 接入同一个 Guard。

Version 0.1.0 combines the Codex foundation from 0.0.3 with three later host
adapters in one release. Claude Code normalizes its lifecycle hooks into the
existing control protocol; OpenCode uses documented events and SDK calls with a
GitHub install entrypoint; Hermes Agent CLI connects `pre_llm_call` and
`pre_tool_call` to the same Guard.

The canonical distribution for this release is the GitHub tag and source
archive. npm publication remains disabled. Hermes Gateway users only need to
restart the corresponding process after plugin lifecycle changes; this release
does not claim coverage of every Hermes surface.

### 新增 / New

- **Claude Code Adapter**：增加本地 marketplace、共享 Skill、原生 Hook
  配置、Claude 工具分类、路径规范化与并发 delegation 预算。
  / Adds the local marketplace, shared Skill, native Hooks, Claude tool
  classification, path normalization, and process-safe delegation budgeting.
  ([#4](https://github.com/lennney/stop-that-shit/pull/4), @vzionv)
- **OpenCode Adapter**：增加文档化事件/SDK 接入、GitHub 安装入口、
  OpenCode 工具分类、执行拒绝记录，以及可用宿主存在时运行的安装后 smoke。
  / Adds documented event and SDK integration, GitHub installation, OpenCode
  tool classification, execution-denial records, and an installed-host smoke
  when the host is available.
  ([#6](https://github.com/lennney/stop-that-shit/pull/6), @HowcanoeWang)
- **Hermes Agent CLI Adapter**：增加原生 Plugin、独立运行时 bundle、
  Session/Task 状态对齐、原子批量 delegation 预算，以及控制操作零消耗语义。
  / Adds a native Plugin, self-contained runtime bundle, aligned Session/Task
  state, atomic batch delegation budgets, and zero-cost delegation controls.
  ([#17](https://github.com/lennney/stop-that-shit/pull/17), @KumaCool)
- **跨宿主发布元数据**：补齐中英文显示名与 Codex 服务条款字段，并保持
  四套宿主清单与同一个版本一致。
  / Completes bilingual display metadata and Codex terms metadata,
  and keeps all host manifests aligned to one version.

### 修复与验证 / Fixes and verification

- CI 在 Ubuntu 与 Windows、Node.js 18 与 22 上安装声明的开发依赖后运行
  测试、可执行案例与 release check。
  / CI verifies the declared development setup on Ubuntu and Windows with
  Node.js 18 and 22.
- HOL Plugin Scanner 与 plugin-scanner 已作为发布前检查运行；Hermes 测试
  fixture 不再产生误报。
  / HOL Plugin Scanner and plugin-scanner run as release gates, and Hermes test
  fixtures no longer trigger a false positive.
- release check 现在验证 Codex、Claude Code、Hermes 与 package 的版本一致，
  release builder 与 OpenCode package 都会排除 Python `__pycache__` 与
  `.pyc` 文件。
  / The release check now aligns Codex, Claude Code, Hermes, and package
  versions, while both release outputs exclude Python bytecode caches.
- Hermes 原生 Plugin 测试在 Windows 默认使用 `python`、其他平台使用
  `python3`，也允许通过 `PYTHON` 显式覆盖。
  / Hermes native-plugin tests use `python` on Windows, `python3` elsewhere,
  and allow an explicit `PYTHON` override.
- 增加 deliverable metadata 的 Bad/Good 成对案例；现有 Guard 仍不把返回的
  deny 推断成宿主最终没有执行动作。
  / Adds a paired deliverable-metadata case while preserving the rule that a
  returned deny is not evidence of final host effect.

### 安装与升级 / Install and upgrade

- 完整安装入口见 [INSTALL.md](INSTALL.md)，Agent 辅助安装边界见
  [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md)。
  / See [INSTALL.md](INSTALL.md) for host setup and
  [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) for agent-assisted boundaries.
- 从早期版本升级后，按宿主要求重新加载或重启；Codex Hook 定义变化时必须
  重新检查并信任 `/hooks` 中的命令。
  / Reload or restart as required by the host. If Codex Hook definitions
  changed, inspect and trust the commands again in `/hooks`.
- 本版本不发布 npm package。OpenCode 的 package metadata 仅用于 GitHub
  安装路径。
  / This release does not publish an npm package; its package metadata supports
  the OpenCode GitHub installation path.

### 致谢 / Credits

- 感谢 @lennney：创建 Codex Adapter、共享 Guard/Skill、成对评估体系，并
  完成本次多平台版本集成。
  / Created the Codex adapter, shared Guard and Skill, paired evaluation system,
  and integrated this multi-platform release.
- 感谢 @vzionv：适配 Claude Code，贡献 Plugin、Hook、工具分类与并发预算。
  / Adapted Claude Code with its Plugin, Hooks, tool classification, and
  delegation budgeting. ([#4](https://github.com/lennney/stop-that-shit/pull/4))
- 感谢 @HowcanoeWang：适配 OpenCode，贡献文档化宿主接入、GitHub 安装与
  安装后 smoke。
  / Adapted OpenCode with documented host integration, GitHub installation, and
  installed-host smoke. ([#6](https://github.com/lennney/stop-that-shit/pull/6))
- 感谢 @KumaCool：适配 Hermes Agent CLI，贡献原生 Plugin、运行时 bundle
  与 delegation 语义。
  / Adapted Hermes Agent CLI with the native Plugin, runtime bundle, and
  delegation semantics. ([#17](https://github.com/lennney/stop-that-shit/pull/17))

## 0.0.3 — 2026-08-14 (Technical Preview 3)

- Fixed CI setup so every matrix job installs the declared development
  dependencies before running verification.
- Fixed paired-eval path handling for simulated Windows fixtures and made the
  generated-schema check stable across LF and CRLF worktrees.
- Sharpened the public description around small-task overengineering and added
  repository status badges.
- Documented the maintainer's SHA-256 observation as anecdotal evidence, kept
  the live null result public, and retained `hostEffect: unobserved` in Runtime
  claims.
- No enforcement families were added in this patch preview.

## 0.0.2 — 2026-08-14 (Technical Preview 2)

- Added `OFF`, `OBSERVING`, and `ARMED` control states with distinct context and
  permission-deny response outcomes; host effect is never inferred.
- Added local metadata-only `RuntimeEvent v1` logs, append-only annotations, and
  `doctor`, `runtime`, `explain`, and `label` inspection commands.
- Migrated paired fixtures to validated `CaseBundle v1` directories and added
  isolated runtime counts, infrastructure exclusions, paired outcome summaries,
  external case directories, and offline rescore.
- Added live-eval preflight for exact installed runtime-tree parity, pinned model
  and reasoning metadata, explicit infrastructure exclusions, and a required
  `--max-cells` paid-session cap after a stale-cache diagnostic run.
- Added JSON Schema validation with a generated standalone validator; Ajv remains
  a development dependency and is not loaded by the plugin runtime.

## 0.0.1 — pre-release

- Added the four-question Stop Ladder.
- Added Codex guards for non-mutating modes, optional file locks, dependency
  approval, subagent budgets, and high-confidence hash authority.
- Reduced the default Guard to `UserPromptSubmit` and `PreToolUse`; the shared
  Skill remains usable when Hooks are disabled.
- Added a public three-arm Codex evaluation harness with synthetic Good/Bad
  fixtures. Live run artifacts remain local and ignored.
- Added a small `ControlEvent v1` seam with Codex as the only Adapter.
- Added paired Bad/Good cases and local release validation.
- Removed experimental scope discovery, new-file and compatibility guessing,
  repeat fingerprints, action ledgers, and compaction checkpoints after live
  testing showed that the product was becoming more complex than its promise.
