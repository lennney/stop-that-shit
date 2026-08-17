<p align="center">
  <img src="assets/stop-stamp.svg" alt="红色 STOP 审查印章" width="240">
</p>

<h1 align="center">Stop That Shit</h1>

<p align="center">
  <img src="https://img.shields.io/github/stars/lennney/stop-that-shit?style=flat-square&color=111111&label=stars" alt="GitHub stars">
  <img src="https://img.shields.io/github/v/release/lennney/stop-that-shit?include_prereleases&sort=semver&style=flat-square&color=111111&label=release" alt="最新版本">
  <a href="https://github.com/lennney/stop-that-shit/actions/workflows/ci.yml"><img src="https://github.com/lennney/stop-that-shit/actions/workflows/ci.yml/badge.svg" alt="CI 状态"></a>
  <img src="https://img.shields.io/badge/works%20with-Codex-111111?style=flat-square" alt="支持 Codex">
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code-111111?style=flat-square" alt="支持 Claude Code">
  <img src="https://img.shields.io/github/license/lennney/stop-that-shit?style=flat-square&color=111111" alt="MIT 许可证">
</p>

<p align="center">
  <strong>你只要一个文件，Codex 却拆成六个模块，叫来三个 Agent，又给所有东西算了一遍 SHA-256。Stop That Shit。</strong><br>
  Stop That Shit 通过本地 Adapter 支持 Codex、Claude Code 和 OpenCode。<br>
  <a href="#安装">安装</a> ·
  <a href="#bad-case--good-case">Bad / Good Case</a> ·
  <a href="cases/README.md">案例库</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a> ·
  <a href="README_EN.md">English</a>
</p>

让 Codex 写个小文件，结果可能多出一棵模块树、几个 subagent、一项新依赖，还有一份没人会用的 SHA-256 checksum。

每一步都能说出一个挺严谨的理由。回头一看，要的东西还没做完，token 已经花了一截。花在正事上没意见，花在 Codex 自己加出来的活上，就很心疼。

我也试过在 `AGENTS.md` 里不断补规则：「不要乱改」「别过度设计」「没让我做的先别做」。每被气到一次就补一条，写着写着，`AGENTS.md` 自己也开始造史了。Stop That Shit 把其中少量、能明确判断的边界做成 Skill 和可执行的 Guard。

Stop That Shit 为 Codex、Claude Code 和 OpenCode 划定任务边界。三者共用核心
Guard，宿主差异只放在薄 Adapter 和 Hook 配置中。Agent 仍然可以读仓库，也必须
处理真正受影响的调用方。Guard 确认某个动作越界时，会返回一枚红章：

```text
STOP / INTENT
Guard 返回 permission deny。
Reason: MODE_FORBIDS_MUTATION
State: ARMED / review
Event: evt_...
```

[`0.0.3`](https://github.com/lennney/stop-that-shit/releases/tag/0.0.3) 是第三个技术预览版。LLM 每次运行都可能不同，Hook 也看不到宿主 agent 的全部动作。Skill 和 Guard 可以减少一部分越界行为，但都不能保证模型每次听话。

| 从哪里开始 | 提供什么 | 使用成本 |
| --- | --- | --- |
| **Skill + Guard** | 同一份 Skill，加上机器可执行边界 | 默认；检查宿主 Hook 配置后启用 |
| **只装 Skill** | Stop Ladder 和任务模式引导 | 可选；没有执行拦截 |

## 快速安装

### Claude Code

解压后，在仓库根目录执行：

```bash
claude plugin validate .
claude plugin marketplace add ./
claude plugin install stop-that-shit@stop-that-shit
```

重启 Claude Code 或执行 `/reload-plugins`，然后使用：

```text
/stop-that-shit:stop-that-shit review -- Review 这个 diff，只报告问题，不要修改。
```

### Codex

```bash
codex plugin marketplace add lennney/stop-that-shit
codex plugin add stop-that-shit@stop-that-shit
```

重启 Codex。在新的 CLI TUI 中输入 `/hooks`，检查命令后信任 `UserPromptSubmit` 和 `PreToolUse`。状态说明和无 Hook 安装方式见[安装](#安装)。也可以把 [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md) 交给 Codex，让它完成非交互步骤。

### OpenCode 从 GitHub 安装

OpenCode 1.18.18 或更高版本可以全局安装这个仓库，无需 clone：

```bash
opencode plugin github:lennney/stop-that-shit -g
```

重启 OpenCode 后用 `$stop-that-shit review -- ...` 设置契约。该命令安装 Guard；内置 Skill 和可选 `/sts` 别名不会自动注册。详见 [INSTALL.md](INSTALL.md#opencode-install-from-github)。

## Bad Case / Good Case

```text
BAD CASE
用户   Review 这个 diff，不要修改。
Codex  调用 apply_patch。
STS    STOP / INTENT：Review 不等于允许修改。

GOOD CASE
用户   只修 P1 问题。
Codex  提交一个窄补丁，运行受影响的检查。
STS    ALLOWED：完成请求确实需要这个动作。
```

Good Case 和拦截同样重要。已经发布的数据可能需要迁移；发布流程可能真的消费校验和；共享合同变化后可能必须跑跨组件测试。只要用户明确要求，或仓库中的代码、数据和发布流程能证明它确实必要，这些工作就该保留。

## SHIT 是哪四种

一个有边界的任务，常从这四个方向跑掉：

| | 问题 | 常见样子 |
| --- | --- | --- |
| **S** | Scope creep，范围膨胀 | 修一个点，顺手重构半个项目。 |
| **H** | Hashing 与 hypothetical hardening | 加了摘要、防御或免责声明，却没有当前用途。 |
| **I** | Intent violation，意图越界 | 让它 Review 或回答问题，它直接动手改。 |
| **T** | Task thrashing，任务打转 | 已经查过、测过、审过，它又从头来一遍。 |

插件不数代码行数，也不把 diff 越小当成越好。它只问：这一步是用户要求的，还是当前代码、数据和验收条件确实需要的？

这些东西单看一项，往往都能讲出道理：

- 写下一堆 checksum，却没有任何命令会读；
- 为受支持路径不可能产生的输入加守卫；
- 当前没有相应操作或用户决策，却把内部风险边界铺成界面上的免责声明；
- 该做工程判断时，改成评分表或反复审计；
- 为没人要求的将来加 feature flag、迁移框架和包装层；
- 新加一层守卫，只为了保护上一层守卫。

每一步都像在增加“严谨性”。最后，一个简单功能被防御代码、免责声明和流程层层埋住。

## 为什么默认阻止 hash

在 Hook 覆盖的工具调用中，它可以较高置信度地识别 hash 动作。判断标准很具体：摘要有没有省掉真实工作，结果会不会改变下一步？

我们沿用 [HERO](https://github.com/wanshuiyin/HERO-Anti-OverDefense) 写下的判据：摘要必须替代一个更贵的操作，而且结果必须控制下一步做什么。

```text
STOP
给每一行算 hash，算完还是逐行比较。

ALLOW
用 digest 跳过一个未变化大文件的重复读取。
```

`0.0.3` 默认拒绝可识别的新 hash 操作。用户明确要求，或仓库中的代码与发布流程证明它确实必要时，就用 `hash=allow` 放行。Hook 不会根据自己没读过的代码猜测这个用途。

## 怎么用

Claude Code 插件直接用 namespaced Skill：

```text
/stop-that-shit:stop-that-shit change -- 修复失败的配置测试。
/stop-that-shit:stop-that-shit review -- Review 这个 diff，只报告问题，不要修改。
```

Codex 或普通 prompt 里的宿主无关指令仍然使用：

```text
$stop-that-shit change -- 修复失败的配置测试。
$stop-that-shit review -- Review 这个 diff，只报告问题，不要修改。
```

边界已经很清楚时，再加限制：

```text
$stop-that-shit lock change files=src/config.cjs|test/config.test.cjs -- 修复这个行为。
$stop-that-shit change deps=allow -- 添加我要求的解析器依赖。
$stop-that-shit change hash=allow -- 生成我要求的发布校验和。
$stop-that-shit change agents=1 -- 使用一个独立测试 subagent。
```

不知道全部受影响文件时，不要硬写 `files=`。让 agent 沿真实调用链检查，把完成任务必需的 caller、fixture 和测试一起改完。

安装后默认是 `OBSERVING / unconfirmed`：Guard 会检查并记录 covered action，但不会猜测任务授权，也不会返回 permission deny。显式使用 `review`、`answer`、`monitor` 或 `change` 后才进入 `ARMED`；`watch` 始终只观察。

下面这些只读命令不会修改当前任务合同：

```text
$stop-that-shit status
$stop-that-shit runtime
$stop-that-shit explain evt_...
$stop-that-shit label evt_... correct|incorrect|inconclusive
```

`permission_deny_returned`（OpenCode 中为 `execution_denial_returned`）只表示 Guard 返回了拒绝响应，不证明宿主最终没有执行动作。Stop That Shit 始终把 host effect 标为 `unobserved`。

## Guard 现在能拦什么

| covered path 上的动作 | 默认处理 | 怎么放行 |
| --- | --- | --- |
| 在 `review`、`answer` 或 `monitor` 中写文件 | 停止 | 切换到 `change` |
| 添加依赖 | 询问 | `deps=allow` |
| 启动 subagent | 超出预算时停止 | `agents=N` |
| 添加可识别的 hash 操作 | 停止 | `hash=allow` |
| 写入文件锁之外的路径 | 停止 | 扩大 `files=` |

Hook 必须收到受支持的事件和足够的输入才能判断。它不会看到 `cache`、`retry`、`migration` 或新文件这些词，就猜它们一定多余。Skill 用四个问题处理这种语义判断：

1. 用户要求了吗？
2. 不做它，当前结果能完成吗？
3. 哪段可达的代码、数据或部署状态证明它有必要？
4. 省掉它，当前验收会失败吗？

证据撑不住时，agent 应该报告或暂缓，不要顺手实现。

## 工作方式

Skill 负责语义判断。Hook 在受支持的工具运行前检查明确事实。Codex、Claude Code 和 OpenCode Adapter 把宿主事件翻译成同一套核心决策接口。

三个宿主都已实现 Adapter。各 Adapter 暴露自己需要的宿主事件，比如工具运行前的硬阻断，以及携带活动合同的生命周期事件。OpenCode 插件只使用官方文档中的事件（`message.part.updated` 与 session 事件、`tool.execute.before` / `tool.execute.after`）和 SDK 调用，并通过 `client.session.prompt({ noReply: true })` 注入契约上下文。其他 harness 需要提供等价的 before-action 事件，才能复用同一套核心。接口说明见 [HOST-ADAPTER-CONTRACT.md](HOST-ADAPTER-CONTRACT.md)。

## 局限和证据

部分特殊工具路径可能绕过普通 Hook。插件不负责判断代码质量，不修复 Codex runtime bug，也不是安全沙箱。

测试只能证明规则在 covered event 上按设计运行，不能证明模型行为会普遍改善。[EVIDENCE.md](EVIDENCE.md) 记录了测试、真实运行、无差异结果和排除项。

就我自己的使用情况看，启用 Stop That Shit 后，我还没有再遇到那种没有实际消费者却先生成 SHA-256 的动作。这是个人观察，不是受控 benchmark。本地 Runtime 会记录只含元数据的 Hook 检查，区分 checked action、context response 和 permission deny；它仍然会把宿主效果记为 `unobserved`。

## 安装

### Claude Code：Skill + Guard

需要 Node.js 18+。从本地 checkout 根目录安装：

```bash
claude plugin validate .
claude plugin marketplace add ./
claude plugin install stop-that-shit@stop-that-shit
```

重启或执行 `/reload-plugins`。Claude 会加载共享 `skills/`、`hooks/hooks.json`
以及 Claude Adapter。Guard 覆盖 `Write`、`Edit`、`NotebookEdit`、`EnterWorktree`、
shell/`Monitor` mutation、dependency/hash intent、可选 file lock，以及受支持路径上的
`Agent` budget。Claude `Workflow` 在 Guard 武装时会保守拒绝，因为它内部的 subagent
fan-out 无法被 `agents=N` 确定性约束。

### Codex：Skill + Guard

```bash
codex plugin marketplace add lennney/stop-that-shit
codex plugin add stop-that-shit@stop-that-shit
```

重启 Codex。在新的 CLI TUI 中输入 `/hooks`，检查命令后信任 `UserPromptSubmit` 和 `PreToolUse`。如果 Codex Desktop 把 `/hooks` 当成普通消息发送，就在 CLI TUI 里完成这次审查，再重启 Desktop。

### 可选安装：只装 Skill

如果不想启用命令 Hook，只安装 advisory Skill。Claude Code：

```bash
mkdir -p ~/.claude/skills/stop-that-shit
cp skills/stop-that-shit/SKILL.md ~/.claude/skills/stop-that-shit/SKILL.md
```

Codex 仍可使用远程 Skill Installer：

```text
$skill-installer Install stop-that-shit from https://github.com/lennney/stop-that-shit/tree/0.0.3/skills/stop-that-shit
```

新开任务后，独立 Claude Code Skill 用 `/stop-that-shit`，作为 plugin 安装时用 namespaced `/stop-that-shit:stop-that-shit`；Codex 用 `$stop-that-shit`。Skill-only 路径不需要 Hook 信任，但不能机器拦截越界动作，也不会改变宿主原有的 sandbox 和 approval 设置。

完整的 Skill 与 Guard 安装说明见 [INSTALL.md](INSTALL.md)。然后运行本地检查：

```powershell
npm test
npm run eval
npm run eval:paired -- --dry-run
npm run release:check
```

paired 命令默认只打印 72 个 cell 的计划，不会调用模型。真实运行必须使用只启用本插件的独立 Codex home。使用 `--run` 前，请先阅读[真实 Codex 对照测试说明](evals/codex-paired/README.md)。

## 一起划清边界

这个项目靠成对案例推进：

```text
报告 -> 反例 -> 复现 -> 执行约束
```

只完成第一步也有价值。不需要会写 Hook，也不需要先做完整 benchmark。

- Codex 做了请求不需要的工作？[提交 Bad Case](https://github.com/lennney/stop-that-shit/issues/new?template=bad-case.yml)。
- 某条规则会拦住真正必要的工作？[提交 Good Case](https://github.com/lennney/stop-that-shit/issues/new?template=good-case.yml)。
- 有公开可复现的例子？把一组案例做成 fixture，然后提交 PR。

最好让一组案例只改变一个关键事实，其余条件保持一致。Bad Case 告诉我们 Codex 应该在哪里停；Good Case 防止规则变成另一种粗暴限制。只有可复现、高置信度的部分才进入 Guard，其余案例仍然可以改进 Skill 和案例库。

提交前先看[案例库](cases/README.md)和[贡献指南](CONTRIBUTING.md)。请删掉私有代码、密钥、账号数据、完整对话和可识别身份的路径。一条小而清楚的脱敏 issue 就有价值。

## License

[MIT](LICENSE)
