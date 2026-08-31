<p align="center">
  <img src="assets/stop-stamp.svg" alt="Stop That Shit（别再造史了）AI Agent 任务边界 Guard 的红色 STOP 印章" width="240">
</p>

<h1 align="center">Stop That Shit（别再造史了）</h1>

<p align="center">
  <a href="https://github.com/lennney/stop-that-shit/releases"><img src="https://img.shields.io/github/v/release/lennney/stop-that-shit?include_prereleases&sort=semver&style=flat-square&color=111111&label=release" alt="最新版本"></a>
  <a href="https://github.com/lennney/stop-that-shit/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/lennney/stop-that-shit/ci.yml?branch=main&style=flat-square&label=build" alt="构建状态"></a>
  <img src="https://img.shields.io/github/license/lennney/stop-that-shit?style=flat-square&color=111111" alt="MIT 许可证">
</p>

<p align="center">
  <strong>你只让 Agent 导出一个结果文件。它顺手又生成一份 SHA-256 校验和，但后面没有任何命令会读取它。Stop That Shit。</strong><br>
  Stop That Shit（别再造史了）处理 AI coding agent 自己加出来的防御性工作和任务越界。<br>
  支持 <a href="INSTALL.md#codex-skill--guard">Codex</a>、<a href="INSTALL.md#claude-code-skill--guard">Claude Code</a>、<a href="INSTALL.md#opencode-install-from-github">OpenCode</a>、<a href="INSTALL.md#hermes-agent-cli">Hermes Agent CLI</a> 和 <a href="INSTALL.md#pi-coding-agent">Pi</a>。<br>
  <a href="#快速安装">安装</a> ·
  <a href="#bad-case--good-case">Bad / Good Case</a> ·
  <a href="cases/README.md">案例库</a> ·
  <a href="#020从多做一步到多说一句">0.2.0</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a> ·
  <a href="README_EN.md">English</a>
</p>

这份校验和生成了，任务却没有少做一步，后面的流程也完全一样。换个任务，多出来的可能是 guard、兼容层、全量测试或额外流程。Codex、Claude Code、OpenCode、Hermes Agent CLI 和 Pi 都可能这么做：每一步单看都有理由，但用户没要求，当前任务也用不上。

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

## 0.2.0：从多做一步，到多说一句

0.1.x 先处理 SHIT 的动作面：没人读取的 `.sha256`、为想象中未来准备的兼容层、Review 时顺手开始改代码。

0.2.0 把同一套判断带到表达里。Agent 写提案时也会替不存在的批评者辩护：这不是完整研究，没有覆盖所有情况，也不保证适用于每个人。这些话消耗 Token，却不改变任何决定。

多做一步，是用动作自保；多说一句，是用文字自保。一个没人读取的 checksum，和一句不改变任何决定的免责声明，都没有消费者。

Stop Ladder 继续判断一个动作该不该做。新增的 **Stop That Shit Slop（别再废话）** 用 Sentence Consumer Test 判断一句防御性表达该删、该收紧，还是必须保留。

> 为什么 Agent 总在替不存在的批评者辩护？
>
> “这不是完整研究。”“没有覆盖所有情况。”“不保证适用于每个人。”
>
> 我没有问这些。
>
> 写给想象中批评者的防御性废话，就别再浪费我的 Token 了。
>
> Stop That Shit 0.2.0 新增 Stop That Shit Slop：判断一句话该删、该收紧，还是必须留下。

`0.2.0` 保留原有 Stop Ladder、Guard、五套 Adapter 和成对案例，并新增可独立使用的 Stop That Shit Slop。

| 从哪里开始 | 提供什么 | 使用成本 |
| --- | --- | --- |
| **Skill + Guard** | 同一份 Skill，加上机器可执行边界 | 默认；检查宿主 Hook 配置后启用 |
| **只装 Skill** | Stop Ladder 和任务模式引导 | 可选；没有执行拦截 |

## 从 Codex + GPT-5.6 开始，现在覆盖多种 Agent

项目从 Codex 起步：公开记录保留了 Codex CLI `0.145.0` + `gpt-5.6-sol` 的探索运行，以及 Codex CLI `0.147.0` + `gpt-5.6-luna` 的定向 pilot。现在五个 Adapter 共用同一套任务边界核心；Codex 安装方式、GPT-5.6 记录和 paired eval 见 [EVIDENCE.md](EVIDENCE.md) 与 [Codex 对照测试](evals/codex-paired/README.md)。

## 快速安装

一般宿主需要 Node.js 18+；Pi 0.84.4 自身要求 Node.js 22.19+。完整安装说明见 [INSTALL.md](INSTALL.md)。

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
codex plugin marketplace add lennney/stop-that-shit --ref 0.2.0
codex plugin add stop-that-shit@stop-that-shit
```

`--ref 0.2.0` 把安装固定到版本 tag，不跟随可变的 `main`。重启 Codex。在新的 CLI TUI 中输入 `/hooks`，检查命令后信任 `UserPromptSubmit` 和 `PreToolUse`。也可以把 [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md) 交给 Codex，让它完成非交互步骤。

### OpenCode 从 GitHub 安装

OpenCode 1.18.18 或更高版本可以全局安装这个仓库，无需 clone：

```bash
opencode plugin github:lennney/stop-that-shit -g
```

重启 OpenCode 后用 `$stop-that-shit review -- ...` 设置契约。该命令安装 Guard；内置 Skill 和可选 `/sts` 别名不会自动注册。详见 [INSTALL.md](INSTALL.md#opencode-install-from-github)。

### Hermes Agent CLI

需要 Node.js 18+。

```fish
hermes plugins install lennney/stop-that-shit/.hermes-plugin --no-enable
hermes plugins enable stop-that-shit
hermes plugins list
```

启用后，CLI 用户需要启动新的 Hermes CLI 进程或会话；Gateway 用户需要执行：

```fish
hermes gateway restart
```

这些操作不需要每次使用插件时重复。只有启用、禁用、更新、回滚或重装插件后，
才需要重启对应的 Hermes 进程。

### Pi Coding Agent

当前适配固定验证 `@earendil-works/pi-coding-agent` `0.84.4`。从包含该
Adapter 的本地 checkout 安装：

```bash
pi install /absolute/path/to/stop-that-shit
```

启动新的 Pi 进程，或修改资源后在 TUI 执行 `/reload`。然后使用：

```text
/skill:stop-that-shit review -- Review 这个 diff，只报告问题，不要修改。
```

从 `0.2.0` tag 安装即可获得 Pi Adapter 和两个 Skill。详见 [INSTALL.md](INSTALL.md#pi-coding-agent)。

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

Stop That Shit 不数代码行数，也不把 diff 越小当成越好。它只问：这一步是用户要求的，还是当前代码、数据和验收条件确实需要的？

常见的样子包括：没有消费者的 checksum 和 guard；当前没有用户决策，却把内部风险写成一排界面免责声明；该做工程判断时改成评分表和反复审计；为没人要求的将来加 feature flag、迁移框架和包装层。

## 为什么先拦 hash

Hook 在受支持的工具调用中可以较高置信度地识别 hash 动作。判断沿用 [HERO](https://github.com/wanshuiyin/HERO-Anti-OverDefense) 的判据：摘要必须替代一个更贵的操作，而且结果必须控制下一步。

```text
STOP
给每一行算 hash，算完还是逐行比较。

ALLOW
用 digest 跳过一个未变化大文件的重复读取。
```

当前版本默认拒绝可识别的新 hash 操作。用户明确要求，或仓库中的代码与发布流程证明它确实必要时，就用 `hash=allow` 放行。Hook 不会根据自己没读过的代码猜测这个用途。

## 怎么用 Stop That Shit

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

Stop That Shit Skill 负责 Stop Ladder 的语义判断，Hook 在工具运行前检查明确边界，Adapter 把 Codex、Claude Code、OpenCode、Hermes Agent CLI 和 Pi 的事件翻译成同一套决策接口。其他 harness 需要提供等价的 before-action 事件；接口见 [HOST-ADAPTER-CONTRACT.md](HOST-ADAPTER-CONTRACT.md)。

STSS 使用 Sentence Consumer Test，不需要 before-action Hook，因此可以独立分发。

## 覆盖边界与公开证据

Stop That Shit 负责 supported Hook 路径上的任务授权，安全隔离由宿主 sandbox 负责。[EVIDENCE.md](EVIDENCE.md) 记录测试、GPT-5.6 运行、无差异结果和未覆盖路径。

维护者启用后没有再遇到“没有实际消费者却先生成 SHA-256”的动作；文档将这条个人观察与 paired eval 分开记录。本地 Runtime 只存元数据，并区分 checked action、context response、permission deny 和 `hostEffect: unobserved`。

STSS 的十二个固定离线响应用于规则和回归验收，六组完整案例见 [STSS examples](skills/stss/references/examples.md)。

## 两个 Skill，自己选

| Skill | 让 Agent 停在哪里 | 常用入口 |
| --- | --- | --- |
| **Stop That Shit（别再造史）** | 停止范围膨胀、意图越界、防御性工程和重复审计 | `$stop-that-shit review -- ...` |
| **Stop That Shit Slop（别再废话）** | 减少没有决策用途的免责声明、过度 hedging 和自我辩护 | `$stss rewrite -- ...` |

两个 Skill 可以一起安装，也可以单独使用。

## 一套判断：谁会消费它

Stop That Shit 用 Stop Ladder 判断动作：

1. 用户要求了吗？
2. 不做它，当前结果能完成吗？
3. 哪段代码、数据、部署状态或验收条件需要它？
4. 省掉它，当前验收会失败吗？

STSS 把同一个判断带到句子上：

1. 谁会使用这句话？
2. 它会改变什么决定？
3. 删除后，什么会变成错误或误导？

它先记录 Claim Ledger 中的事实、数字、来源、责任主体和证据强度，再选择 `DROP`、`CALIBRATE`、`RELOCATE` 或 `KEEP`。最后用 Claim Diff 检查事实和数字有没有丢、证据有没有被编造、相关性有没有被写成因果。

## 0.2.0 带来了什么

- 新增独立 Skill：`stss`。
- 原有 `$stop-that-shit` 调用和 Guard 合同保持不变；STSS 是新增的可选 Skill。
- 两种模式：`rewrite` 直接改写，`audit` 只报告问题和最小修改。
- 六组 Good/Bad CaseBundle、十二个合成 fixture 和对应的固定离线响应，覆盖免责声明、hedge、负向范围、勤勉旁白、空洞主张和因果边界。
- 完整插件可发现两个 Skill；STSS 也能单独安装。
- 新增显式版本查询：`sts doctor --check-update`。

## Stop That Shit Slop：单独安装与调用

### 单独安装

在当前仓库根目录执行：

```bash
npx skills add ./skills/stss --global
```

这条路径只安装“别再废话”，不会安装 Hook。

### 调用

不写模式时，STSS 对用户贴出的文本默认执行 `rewrite`。`audit` 只报告问题和最小修改，不重写全文。

| 宿主 | 改写 | 审核 |
| --- | --- | --- |
| Codex | `$stss rewrite -- 把这个提案写直接。` | `$stss audit -- 找出防御性废话。` |
| Claude Code 插件 | `/stop-that-shit:stss rewrite -- ...` | `/stop-that-shit:stss audit -- ...` |
| Claude Code 单独 Skill | `/stss rewrite -- ...` | `/stss audit -- ...` |
| Pi | `/skill:stss rewrite -- ...` | `/skill:stss audit -- ...` |

原来的任务边界入口不变：

```text
$stop-that-shit review -- Review 这个 diff，只报告问题，不要修改。
$stop-that-shit change -- 修复失败的配置测试。
$stop-that-shit change hash=allow -- 生成我明确要求的发布校验和。
```

## 三个案例，看它减少什么、保留什么

这些合成案例与固定离线验收使用同一组输入和边界。

### 1. DROP：删掉没人需要的辩护

```text
输入：需要说明的是，这只是有限的首轮试点，并不试图证明方法适用于所有场景。
      在 120 份工单中，引入自动分流后，24 小时完成率从 68% 升至 76%。

输出：首轮 120 份工单试点中，引入自动分流后，24 小时完成率从 68% 升至 76%。
```

样本、指标和观察结果都在；没人提出的“所有场景”主张被删掉了。

### 2. CALIBRATE：把四层犹豫收成一个真实条件

```text
输入：我们也许大概有可能在六到八周内完成迁移，具体取决于访问审批。
输出：预计六到八周完成迁移，前提是获得访问审批。
```

时间范围和依赖仍然可见，只减少重复 hedging。

### 3. KEEP：审批会用到这句话

```text
输入：内部试点覆盖 120 份工单，完成率从 68% 升至 76%。审批经理要求明确：
      该内部试点不代表一般部署。

输出：内部 120 份工单试点中，引入自动分流后，24 小时完成率从 68% 升至 76%。
      该内部试点不代表一般部署。
```

这条限制会影响审批判断，所以保留。

六组完整案例见 [STSS examples](skills/stss/references/examples.md)，机器可验收版本见 [`evals/stss`](evals/stss)。

## 可选：只装 Skill

如果不想启用命令 Hook，只安装 Stop That Shit advisory Skill。Claude Code：

```bash
mkdir -p ~/.claude/skills/stop-that-shit
cp skills/stop-that-shit/SKILL.md ~/.claude/skills/stop-that-shit/SKILL.md
```

Codex 仍可使用远程 Skill Installer：

```text
$skill-installer Install stop-that-shit from https://github.com/lennney/stop-that-shit/tree/0.2.0/skills/stop-that-shit
```

新开任务后，独立 Claude Code Skill 用 `/stop-that-shit`，作为 plugin 安装时用 namespaced `/stop-that-shit:stop-that-shit`；Codex 用 `$stop-that-shit`。Skill-only 路径不需要 Hook 信任，但不能机器拦截越界动作，也不会改变宿主原有的 sandbox 和 approval 设置。

STSS 的独立安装和调用见上方 [Stop That Shit Slop](#stop-that-shit-slop单独安装与调用) 章节。

## 本地验证

```powershell
npm test
npm run eval
npm run eval:paired -- --dry-run
npm run release:check
```

paired 命令默认只打印 144 个 cell 的计划，不会调用模型。真实运行必须使用只启用本插件的独立 Codex home。使用 `--run` 前，请先阅读[真实 Codex 对照测试说明](evals/codex-paired/README.md)。

## 手动检查更新

安装了 package executable 后运行：

```bash
sts doctor --check-update
```

源码 checkout 中的等价命令：

```bash
npm run sts -- doctor --check-update
```

只有这个显式命令会查询 GitHub Release，并返回 `installed`、`latest` 和 `releaseUrl`。它不执行升级，也不会在启动或任务过程中弹出提醒。单独安装的 STSS 继续由宿主或 Skill Installer 更新。

## 一起让 Agent 少造一点史

如果“别再造史了”说中你的经历，可以 [Star 这个仓库](https://github.com/lennney/stop-that-shit)，或把它发给那个不断往 `AGENTS.md` 里补规则的人。项目靠成对案例推进：

```text
报告 -> 反例 -> 复现 -> 执行约束
```

- Codex 做了请求不需要的工作？[提交 Bad Case](https://github.com/lennney/stop-that-shit/issues/new?template=bad-case.yml)。
- 某条规则会拦住真正必要的工作？[提交 Good Case](https://github.com/lennney/stop-that-shit/issues/new?template=good-case.yml)。
- 有公开可复现的例子？把一组案例做成 fixture，然后提交 PR。

一组有效案例只改一个关键事实，其余条件不变。Bad Case 标出该停的位置，Good Case 保住必要工作；只有可复现、高置信度的部分才进入 Guard。STSS 的文字案例也沿用同一原则：公开 fixture 必须是合成或脱敏内容，并说明哪一个用户决策会因此改变。

提交前先看[案例库](cases/README.md)和[贡献指南](CONTRIBUTING.md)。请删掉私有代码、密钥、账号数据、完整对话和可识别身份的路径。一条小而清楚的脱敏 issue 就有价值。

## License

[MIT](LICENSE)
