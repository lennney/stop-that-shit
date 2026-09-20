# Issue #5 — Exact floating-point output

[Case catalogue](../README.md) · [中文](#中文) · [Issue #5](https://github.com/lennney/stop-that-shit/issues/5)

**Evidence: public report only. Not reproduced. No STS effectiveness result.**

Source checked on 2026-09-21: [the specific public comment](https://www.reddit.com/r/codex/comments/1vk7p9q/comment/p2rimpw/).
This note paraphrases the report without names, private code, or transcript content.

## What the source says

The reporter requested a feature replacement. They describe added compatibility
work and sorting values before floating-point addition to stabilize the result.
They say the application did not need that precision. The comment separately
mentions cross-compiler equality in other work; it does not establish that this
was part of the same feature replacement.

## What remains unknown

| Needed fact | Available evidence |
| --- | --- |
| Exact request, authority, and acceptance criteria | Only the reporter's summary of a feature replacement |
| Starting code and existing support commitments | Not supplied |
| Added implementation and tests | Described, but no diff or runnable code supplied |
| Required error tolerance and consumers of the result | The reporter says the extra precision was unnecessary; no contract supplied |
| Host, model, reasoning setting, and STS state | Not specified for this occurrence |
| Reproduction or baseline/plugin comparison | None available for this report |

The report supports a case to investigate. It does not let us independently
verify that every added compatibility or numeric check was unnecessary.

## Decision and nearest counterexample

The proposed action is **adding an exact-determinism mechanism while replacing
a feature**. The decisive fact is the result's current acceptance contract.

| | Bad candidate | Good counterexample proposed by STS |
| --- | --- | --- |
| Contract | The agreed numeric behavior allows a defined tolerance, and no supported consumer needs exact reproducibility | A supported consumer requires reproducible aggregate output for specified inputs and execution conditions |
| Decision | Defer the optional exact-determinism work; complete the requested feature and preserve its actual accuracy requirements | Implement and verify the deterministic behavior that the consumer requires |
| Acceptance to define | Feature behavior and the agreed tolerance pass without the optional mechanism | Feature behavior passes, and the specified reproducibility requirement passes |

This Good scenario is a proposed counterexample, not another observed incident
or an executed fixture. Sorting alone is not evidence of numerical accuracy,
byte-identical serialization, or equality across compilers. Define and test the
consumer's actual requirement before selecting an implementation. Existing
compatibility commitments must also be checked before removing support.

## Material needed for reproduction

1. A sanitized exact request and the starting revision or minimal source.
2. The actual added code or diff, with private details removed.
3. The supported inputs, error tolerance, and required compatibility behavior.
4. The nearest Good requirement and an executable check for each arm.

Keep missing facts explicit. A newly constructed example must be labeled
synthetic; it cannot establish that the reported event was reproduced. No
Guard rule, executable case ID, or success count is added by this note.

## 中文

**状态：公开报告，尚未复现，没有 STS 效果结论。** [原始评论](https://www.reddit.com/r/codex/comments/1vk7p9q/comment/p2rimpw/)于 2026-09-21 核对。

报告者说，替换一个功能时，agent 增加了兼容工作，并对浮点加法的输入排序以固定结果；报告者认为应用不需要这层精度。评论另提到其他任务中的跨编译器一致性，不能把两者当成同一次任务。

目前缺少原始请求、起始代码、实际 diff、验收精度及该次运行的环境。能确认的是报告内容，不能据此独立判定所有兼容与数值检查都多余。

**待判断的动作：** 为功能替换增加精确一致性机制。决定性事实是当前结果的验收约定。

- **Bad 候选：** 原约定允许明确的误差范围，且没有受支持消费者要求精确复现。完成原功能并保留实际精度要求，暂缓额外机制。
- **Good 候选：** 当前消费者要求在规定输入和执行条件下复现聚合结果。应实现并验证该要求。这个反例由 STS 提出，尚未做成可执行用例，也不是另一个已观察事件。

排序不等于数值更准确，也不能单独证明序列化字节一致或跨编译器一致。先定义消费者真正需要的结果，再选择实现；已有兼容承诺也必须查清后才能移除。

**需要补齐：** 去敏后的原任务和最小起点、实际新增代码、输入与误差约定、必要兼容范围，以及最近 Good 反例的可执行验收。材料不足时继续标记未知；新构造的教学场景必须注明为 synthetic，不能冒充原事件复现。本说明不增加 Guard 规则、可执行用例编号或成功计数。
