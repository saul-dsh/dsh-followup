# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-24

### 新增

- **智能跟进推荐**：每轮对话落定后（`agent/status → idle`，缓冲 1.2 秒），用会话当前模型（或插件配置的快模型）生成 2-3 条短跟进建议，Trae 式 chip 浮在输入框上方。
- 点击 chip 填入草稿（`inputActions.setDraft`），**不自动发送**；↻ 换一批（同上下文重生成）、✕ 关闭。
- 回合感知：`agent/pre-step` 记用户消息、`agent/assistant-stream` 累积助手文本、`agent/status` 缓冲多步工具回合的中间 idle。
- seq 去重：客户端每次「忙 → 闲」拉取 `/api/dsh-followup/latest`，seq 相同静默忽略，会话切换自动收起。
- 上下文裁剪（用户 400 字符 + 助手 1200 字符、输出 220 token、严格 JSON 解析、失败静默），单次调用成本可忽略。
