# Issue #5 — Exact floating-point output

[Case catalogue](../README.md) · [中文](#中文) · [Issue #5](https://github.com/lennney/stop-that-shit/issues/5)

**Status: archived public report. Original materials unavailable. Not reproduced.
No STS effectiveness result.**

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

## Reproduction status

On 2026-09-21, the maintainer confirmed that the original materials could not be
recovered and chose to close the issue. This remains a historical report, with
no pending request to complete its reproduction.

A future observed case needs its own sanitized request, starting code, actual
diff, acceptance contract, and nearest counterexample. A newly constructed
example must be labeled synthetic; it cannot establish that this event was
reproduced. Closing the issue adds no Guard rule, executable case ID, or success
count.

## 中文

**状态：已归档的公开报告，原始材料无法找回，尚未复现，没有 STS 效果结论。** [原始评论](https://www.reddit.com/r/codex/comments/1vk7p9q/comment/p2rimpw/)于 2026-09-21 核对。

报告者说，替换一个功能时，agent 增加了兼容工作，并对浮点加法的输入排序以固定结果；报告者认为应用不需要这层精度。评论另提到其他任务中的跨编译器一致性，不能把两者当成同一次任务。

目前缺少原始请求、起始代码、实际 diff、验收精度及该次运行的环境。能确认的是报告内容，不能据此独立判定所有兼容与数值检查都多余。

**待判断的动作：** 为功能替换增加精确一致性机制。决定性事实是当前结果的验收约定。

- **Bad 候选：** 原约定允许明确的误差范围，且没有受支持消费者要求精确复现。完成原功能并保留实际精度要求，暂缓额外机制。
- **Good 候选：** 当前消费者要求在规定输入和执行条件下复现聚合结果。应实现并验证该要求。这个反例由 STS 提出，尚未做成可执行用例，也不是另一个已观察事件。

排序不等于数值更准确，也不能单独证明序列化字节一致或跨编译器一致。先定义消费者真正需要的结果，再选择实现；已有兼容承诺也必须查清后才能移除。

**处理结论：** 2026-09-21，维护者确认原始材料已无法找回，决定关闭 Issue，保留为历史报告，不再等待补齐。将来的真实案例应带有自己的原任务、起点、实际 diff、验收约定和最近反例；新构造的教学场景注明为 synthetic，不能冒充本事件复现。关闭 Issue 不增加 Guard 规则、可执行用例编号或成功计数。
