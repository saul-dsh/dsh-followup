# 贡献指南

感谢你愿意改进这个插件。

## 提 Issue 之前

先看 README 的「故障排查」一节。仍然需要提 issue 时，请带上：

- 操作系统与版本
- dsh 版本（`dsh --version`）
- 普通对话是否正常（模型能否正常回复）
- 复现步骤：做了什么、期望什么、实际什么
- 服务端日志里 `[dsh-followup]` 开头的条目

视觉问题请附截图或录屏。

## 提 PR 之前

1. 先开 issue 讨论，避免方向不对白写一版。
2. 一个 PR 只做一件事。
3. 跑一遍自检：

```sh
node --check index.js
node --check client.js
```

4. 改了行为就更新 README。
5. 提交信息用 `feat:` / `fix:` / `docs:` / `refactor:` / `chore:` 前缀。

## 代码约定

- **建议生成必须 fail-silent**。模型超时、路由缺失、JSON 解析失败，一律静默放弃本轮，绝不打扰对话，也绝不阻塞发送。
- **只读不写对话**。插件只消费运行时事件拼对话尾部，不修改任何消息、不拦截发送。
- **不新增依赖**。服务端只用注入的 `llm` 服务与 node 内置模块；客户端只用 `react`。
- **点击 chip 只填草稿**。永远不自动发送——用户必须保有最后一道编辑的机会。

## 客户端改动特别注意

- 浮层注册在 `conversation.input.dock` 槽位，用 `position: fixed` 贴在输入框卡片上方；dsh 改输入栏结构时这里最容易失效。
- 输入区根节点取 `dock.parentElement`（`[data-composer-dock]` 只是底部 dock 条，不是整个输入区）。
- 生成中的判定靠按钮 aria-label（停止/stop），dsh 改文案时需要同步。

## 本地联调

```sh
dsh plugin --profile web add /absolute/path/to/dsh-followup
dsh plugin --profile desktop add /absolute/path/to/dsh-followup
```

改完 `index.js` / `client.js` 需要重启 dsh 才生效。

## License

提交 PR 即表示你同意以 [MIT](LICENSE) 协议授权你的贡献。
