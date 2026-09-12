# Stop That Shit（别再造史了）

中文文档已迁移到仓库默认 README：

- [阅读中文 README](./README.md)
- [安装说明](./INSTALL.md)
- [English README](./README_EN.md)
- [官方产品页](https://take-a-deep-breath0.com/zh/stop-that-shit)
- [LINUX DO 社区](https://linux.do)

## 子智能体限制

使用以下指令设置当前活动并发 subagent 数量：

```text
$stop-that-shit change agents=N -- 执行任务
```

`agents=N` 表示当前同时活动的 subagent 上限。未设置时为
`Number.MAX_SAFE_INTEGER`，`0` 表示禁止 delegation；batch 超出限制时整批拒绝，
不排队、不部分执行。已确认的整次调用完成或已关联子代理的实际终结可释放名额；
停止请求、停止尝试和会话结束通知不能单独证明工作已结束。
适配器不会按事件到达顺序猜测 reservation 的归属。旧 schema 中的有效
`agentBudget`（包括 `0`）会被保留，不会在迁移时静默放宽。

Pi 的串行 `chain` 只占一个并发名额；并行 `tasks` 按任务数占用。
设置有限并发上限时，Guard 会拒绝 Claude `SendMessage` 和 OpenCode `task_id`
恢复调用：宿主未提供运行轮次，旧的完成通知可能误释放新一轮的名额。请改用新的
`Agent` 或 `task` 调用。未设置上限时，这些恢复操作仍可使用；`watch` 只提示、不拦截。

在 watch/off 下放行的无界委派，或无限额下放行的无运行轮次恢复调用，会按调用
记录为并发不可确认。切回有限额 Guard 后，新委派需等待对应调用的可靠完成证据；
宿主无法提供证据时需新建会话。有界调用的未知结果只保留它原有的预留名额。
Claude auto 权限拒绝可撤销预留，普通失败、取消请求和会话结束通知不等于子工作已停止。
Claude 后台调用仅收到 `SubagentStop` 时不会自动回收名额。旧版本会话无法证明历史
工作已结束；升级后要可靠使用有限并发上限，需要新会话，并同时更新适配器与运行时。
具体宿主支持见 [适配器契约](HOST-ADAPTER-CONTRACT.md)。
