<p align="center">
  <img src="assets/stop-stamp.svg" alt="Stop That Shit（别再造史了）AI Agent 任务边界 Guard 的红色 STOP 印章" width="240">
</p>

<h1 align="center">Stop That Shit（别再造史了）</h1>

<p align="center">
  <a href="https://github.com/lennney/stop-that-shit/stargazers"><img src="https://img.shields.io/github/stars/lennney/stop-that-shit?style=flat-square&color=111111&label=stars" alt="GitHub stars"></a>
  <a href="https://github.com/lennney/stop-that-shit/releases"><img src="https://img.shields.io/github/v/release/lennney/stop-that-shit?include_prereleases&sort=semver&style=flat-square&color=111111&label=release" alt="最新版本"></a>
  <a href="https://github.com/lennney/stop-that-shit/actions/workflows/ci.yml"><img src="https://github.com/lennney/stop-that-shit/actions/workflows/ci.yml/badge.svg" alt="CI 状态"></a>
  <img src="https://img.shields.io/badge/works%20with-Codex-111111?style=flat-square" alt="支持 Codex">
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code-111111?style=flat-square" alt="支持 Claude Code">
  <img src="https://img.shields.io/badge/works%20with-OpenCode-111111?style=flat-square" alt="支持 OpenCode">
  <img src="https://img.shields.io/github/license/lennney/stop-that-shit?style=flat-square&color=111111" alt="MIT 许可证">
</p>

<p align="center">
  <strong>你只让 Agent 导出一个结果文件。它顺手又生成一份 SHA-256 校验和，但后面没有任何命令会读取它。Stop That Shit。</strong><br>
  Stop That Shit（别再造史了）处理 AI coding agent 自己加出来的防御性工作和任务越界，支持 Codex、Claude Code 和 OpenCode。<br>
  <a href="#快速安装">安装</a> ·
  <a href="#bad-case--good-case">Bad / Good Case</a> ·
  <a href="cases/README.md">案例库</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a> ·
  <a href="README_EN.md">English</a>
</p>

这份校验和生成了，任务却没有少做一步，后面的流程也完全一样。换个任务，多出来的可能是 guard、兼容层、全量测试或额外流程。Codex、Claude Code 和 OpenCode 都可能这么做：每一步单看都有理由，但用户没要求，当前任务也用不上。

我也试过不断往 `AGENTS.md` 里补「不要乱改」「别过度设计」「没让我做的先别做」。规则越补越长，`AGENTS.md` 自己也开始造史。Stop That Shit 把其中能明确判断的边界做成 Skill 和可执行 Guard。

你用 `review`、`change` 等模式写明授权，再按需限制文件、依赖、hash 和 subagent
预算。Stop That Shit 在受覆盖的 Hook 路径上检查这些明确边界。Agent 仍然可以读
仓库，也必须处理真正受影响的调用方。Guard 确认某个动作越界时，会返回一枚红章：

```text
STOP / INTENT
Guard 返回 permission deny。
Reason: MODE_FORBIDS_MUTATION
State: ARMED / review
Event: evt_...
```

[`0.0.3`](https://github.com/lennney/stop-that-shit/releases/tag/0.0.3) 是第三个技术预览版，包含共享 Guard、三套宿主 Adapter、成对案例和只存元数据的本地 Runtime。

| 从哪里开始 | 提供什么 | 使用成本 |
| --- | --- | --- |
| **Skill + Guard** | 同一份 Skill，加上机器可执行边界 | 默认；检查宿主 Hook 配置后启用 |
| **只装 Skill** | Stop Ladder 和任务模式引导 | 可选；没有执行拦截 |

## 从 Codex + GPT-5.6 开始，现在覆盖多种 Agent

项目从 Codex 起步：公开记录保留了 Codex CLI `0.145.0` + `gpt-5.6-sol` 的探索运行，以及 Codex CLI `0.147.0` + `gpt-5.6-luna` 的定向 pilot。现在三个 Adapter 共用同一套任务边界核心；Codex 安装方式、GPT-5.6 记录和 paired eval 见 [EVIDENCE.md](EVIDENCE.md) 与 [Codex 对照测试](evals/codex-paired/README.md)。

## 快速安装

需要 Node.js 18+。完整安装说明见 [INSTALL.md](INSTALL.md)。

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

重启 Codex。在新的 CLI TUI 中输入 `/hooks`，检查命令后信任 `UserPromptSubmit` 和 `PreToolUse`。也可以把 [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md) 交给 Codex，让它完成非交互步骤。

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

常见的样子包括：没有消费者的 checksum 和 guard；当前没有用户决策，却把内部风险写成一排界面免责声明；该做工程判断时改成评分表和反复审计；为没人要求的将来加 feature flag、迁移框架和包装层。

## 为什么先拦 hash

Hook 在受支持的工具调用中可以较高置信度地识别 hash 动作。判断沿用 [HERO](https://github.com/wanshuiyin/HERO-Anti-OverDefense) 的判据：摘要必须替代一个更贵的操作，而且结果必须控制下一步。

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

## AI Agent Guard 现在能拦什么

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

## Skill + Hook + Adapter 如何工作

Skill 负责语义判断，Hook 在工具运行前检查明确边界，Adapter 把 Codex、Claude Code 和 OpenCode 的事件翻译成同一套决策接口。其他 harness 需要提供等价的 before-action 事件；接口见 [HOST-ADAPTER-CONTRACT.md](HOST-ADAPTER-CONTRACT.md)。

## 覆盖边界与公开证据

Stop That Shit 负责 supported Hook 路径上的任务授权，安全隔离由宿主 sandbox 负责。[EVIDENCE.md](EVIDENCE.md) 记录测试、GPT-5.6 运行、无差异结果和未覆盖路径。

维护者启用后没有再遇到“没有实际消费者却先生成 SHA-256”的动作；文档将这条个人观察与 paired eval 分开记录。本地 Runtime 只存元数据，并区分 checked action、context response、permission deny 和 `hostEffect: unobserved`。

## 可选：只装 Skill

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

## 本地验证

```powershell
npm test
npm run eval
npm run eval:paired -- --dry-run
npm run release:check
```

paired 命令默认只打印 72 个 cell 的计划，不会调用模型。真实运行必须使用只启用本插件的独立 Codex home。使用 `--run` 前，请先阅读[真实 Codex 对照测试说明](evals/codex-paired/README.md)。

## 一起让 Agent 少造一点史

如果“别再造史了”说中你的经历，可以 [Star 这个仓库](https://github.com/lennney/stop-that-shit)，或把它发给那个不断往 `AGENTS.md` 里补规则的人。项目靠成对案例推进：

```text
报告 -> 反例 -> 复现 -> 执行约束
```

- Codex 做了请求不需要的工作？[提交 Bad Case](https://github.com/lennney/stop-that-shit/issues/new?template=bad-case.yml)。
- 某条规则会拦住真正必要的工作？[提交 Good Case](https://github.com/lennney/stop-that-shit/issues/new?template=good-case.yml)。
- 有公开可复现的例子？把一组案例做成 fixture，然后提交 PR。

一组有效案例只改一个关键事实，其余条件不变。Bad Case 标出该停的位置，Good Case 保住必要工作；只有可复现、高置信度的部分才进入 Guard。

提交前先看[案例库](cases/README.md)和[贡献指南](CONTRIBUTING.md)。请删掉私有代码、密钥、账号数据、完整对话和可识别身份的路径。一条小而清楚的脱敏 issue 就有价值。

## License

[MIT](LICENSE)
