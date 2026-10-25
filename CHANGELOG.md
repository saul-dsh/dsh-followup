# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.4] - 2026-10-25

修复「重启后打开对话建议消失」（真机日志实证：07:41 生成成功 seq=1，
07:43 重启后内存态清零）：

- **建议持久化**：生成成功时按 sessionId 写入
  `~/.dsh/followup-suggestions.json`（最多 24 会话，boot 时读回并恢复
  seq 计数）；`GET /latest?sessionId=` 优先返回该会话 10 分钟内新鲜的
  持久化建议，过期回落全局。
- **客户端打开会话即拉取**：dock 组件挂载/切换会话时 fetch /latest，
  新鲜（10 分钟内）即显示——重启后打开对话建议仍在。
- 事件通道 llm 访问加 try/catch 降级（真机 07:41 实证根作用域
  `cannot get property "llm" without inject`；cache/日志路径不受影响，
  不再刷 error 日志）。

## [0.2.3] - 2026-10-25

### 新增：llm/stream 实时捕获主通道（借鉴 dsh-cost-meter）

调研 [Han-1413141/dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)
（v1.9.39）后移植其核心数据模式：`ctx.on('llm/stream', listener, { global: true })`
是 llm 服务的官方瀑布事件，每次 `ctx.llm.stream()` 都会经过，监听器能同时拿到
请求（`options.messages`、`options.sessionId`）与回复流（逐 chunk 透传观察）。

- 服务端新增 llm/stream 链尾旁路捕获：逐 chunk 透传不改流协议，累积
  `text-delta` 得到助手回复，按 `sessionId` 存入内存轮次缓存（24 会话 /
  10 分钟 TTL；同一轮的多步工具链与续流按相同 userText 追加累积）。
- AsyncLocalStorage 深度标记排除两类重复捕获：包装路由插件嵌套发起的
  上游调用（pull 下游时打标记，cost-meter 同款），以及本插件自己发起的
  建议生成调用（发起时打标记）。
- `POST /generate` 改双通道：优先吃实时缓存（零文件 IO、无 zstd 解析
  时延），未命中回落 0.2.0 的日志驱动；debug 日志以 `generate(cache)` /
  `generate(log)` 区分来源。
- 捕获通路首帧与每次入缓存均上报 `~/.dsh/followup-debug.log`
  （`llm/stream first fire: capture channel is ALIVE`）——新架构进程分裂
  下该事件是否到达插件进程从未实证，一次真实对话即可判定。
- 旧 agent/* 事件监听保留（旧版本 dsh 回落），注释标明定位。

## [0.2.2] - 2026-10-25

对齐三处与 Trae 源码的偏差：截断 2 行 → 3 行（Trae 输入区变体
`-webkit-line-clamp:3`）；箭头从文字 "→" 改为 codicon 同款 16-viewBox
描边 SVG；与输入框间距 10px → 4px（Trae `margin:3px 0 0 4px`）。

## [0.2.1] - 2026-10-25

### UI：建议行改为 Trae 源码同款

逆向 `D:\Trae CN\resources\app\out\vs\workbench\workbench.desktop.main.css`
的 `.interactive-session-followups` 规则与 `theme-icube/themes/dark_blue.json`
色板：

- 纵向堆叠文本链接行（flex-direction:column、gap 6px、左对齐）取代
  横排胶囊 chip；每行 = 右箭头 + 12px 链接色文字（Trae 暗色
  `#DADDE5`，映射到 `--dsw-alias-label-primary`），padding 4/8px、
  4px 小圆角、无边框无底色，hover 淡底（Trae `rgba(237,241,248,.1)`
  映射 `--dsw-alias-interactive-bg-hover`），长文本两行截断。
- 整行点击直接发送（Trae reply 行为）；去掉 💬 填入按钮和 ✕ 关闭
  按钮（改草稿即隐藏）。「换一批」改为同款淡色行收尾。

## [0.2.0] - 2026-10-24

### 重构：日志驱动生成（修复新架构下建议从不出现）

dsh 桌面端更新后 webServer 进程收不到任何 `agent/*` 事件（0.1.2
诊断日志实证整轮对话零事件、旧事件链完全失效）。0.2.0 放弃事件监听
作为主通道，改为：

- 客户端回合落定后 `POST /generate {sessionId}`；服务端**直读持久会话
  日志**（`~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`，
  多帧 zstd 按魔数分帧解压、坏帧跳过），提取最后一个真实用户消息
  （source.kind==='user' 单文本块）与其后最后的助手文本，再走
  `ctx.llm.stream` 生成建议（llm 服务在插件进程可用，实测 503 的只有
  agents/compaction）。
- 模型路由链：插件 config → agentDefaultModel 服务 → 解析 profile
  用户补丁层的 `agent-default-model` 配置兜底。
- `/refresh` 同样改为带 sessionId 的日志驱动重生成；旧的无上下文
  兜底分支移除。
- 旧事件监听保留（运行时回到单进程架构时自动恢复工作，日志可见）。
- 真机补丁①：嵌套 webServer 作用域必须声明 llm（cordis 属性访问按
  作用域校验 inject，静态 inject 不传导），runGeneration 改为显式收
  llm 句柄。真机补丁②：maxTokens 220→600（flash 的推理消耗会吃光
  220 导致输出为空）；并记录模型原始输出到诊断日志。

## [0.1.2] - 2026-10-24

### 诊断

- 加文件级排障日志 `~/.dsh/followup-debug.log`（此前只有 console，桌面端不可见）：
  boot 配置快照、pre-step 用户文本抓取（buf# + 长度 + 前 40 字符）、
  assistant-stream 帧型首见/结束长度、idle 判定（跳过原因含实际长度）、
  生成路由/结果/失败全文。每个 buffer 带编号——pre-step 与 idle 的
  buf# 对不上即坐实 WeakMap 按 agent 分裂。
- 背景：真机 `/latest` 恒为 `seq:0`（一次生成都没发生过），事件契约
  对照 dsh-reference 无变化（dispatch 自动注入 agent），需运行时留痕定位。

## [0.1.1] - 2026-10-24

### 变更

- **chip 改为 Trae 同款双区交互**：点正文/箭头（悬浮提示「发送」）直接把建议作为新消息发出——先 setDraft 让输入框闪现整句，再延迟 250ms `inputActions.submit()`；点气泡图标（悬浮提示「添加到对话」）只填进草稿编辑。两个动作都会让 chip 立即收起。

## [0.1.0] - 2026-10-24

### 新增

- **智能跟进推荐**：每轮对话落定后（`agent/status → idle`，缓冲 1.2 秒），用会话当前模型（或插件配置的快模型）生成 2-3 条短跟进建议，Trae 式 chip 浮在输入框上方。
- 点击 chip 填入草稿（`inputActions.setDraft`），**不自动发送**；↻ 换一批（同上下文重生成）、✕ 关闭。
- 回合感知：`agent/pre-step` 记用户消息、`agent/assistant-stream` 累积助手文本、`agent/status` 缓冲多步工具回合的中间 idle。
- seq 去重：客户端每次「忙 → 闲」拉取 `/api/dsh-followup/latest`，seq 相同静默忽略，会话切换自动收起。
- 上下文裁剪（用户 400 字符 + 助手 1200 字符、输出 220 token、严格 JSON 解析、失败静默），单次调用成本可忽略。
