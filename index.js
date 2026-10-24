/**
 * dsh-followup — 每轮对话结束后的智能跟进推荐（DeepSeek Harness / dsh）
 *
 * Trae「智能跟进推荐」的同款交互：助手回复落定后，用一次轻量模型调用
 * 生成 2-3 条短跟进建议，缓存在内存里；web 端在输入框上方浮出可点击
 * 的 chip，点击把建议填进草稿（不自动发送）。
 *
 * 工作原理（服务端半）：
 *   只读运行时事件拼出「最近一轮」的对话尾部，不修改任何消息：
 *   - agent/pre-step：用户消息进入步骤 → 记下用户文本，清空助手累积，
 *     并取消还没完成的上一份生成（用户已经开始说下一句了）
 *   - agent/assistant-stream：累积助手文本增量（start 帧重置，重试不串味）
 *   - agent/status → idle：回合落定（没有驱动器在跑）。延迟缓冲片刻再
 *     生成，缓冲期内 agent 回到 running（工具链下一步）就自动作废，
 *     避免在多步回合的中间步骤上浪费调用
 *
 * 已核对的 dsh API（deepseek-ai/deepseek-harness，对照 dsh-reference）：
 *   - ctx.on('agent/status', ({ agent, status }) => ...)   // idle ⇄ running
 *   - ctx.on('agent/pre-step', async ({ agent, messages }, next) => PreStepDecision)
 *   - ctx.on('agent/assistant-stream', ({ agent, frame }) => ...)
 *     frame = { type: 'start' | 'chunk' | 'end', chunk?: StreamChunk, ... }
 *     文本块 chunk = { type: 'text-delta', text }
 *   - ctx.llm.stream({ provider, model, messages, maxTokens, signal })
 *     → AsyncIterable<{ type: 'text-delta', text } | { type: 'finish', reason }>
 *   - agent.options.provider / agent.options.model：会话当前的路由
 *   - ctx.get('agentDefaultModel')?.currentSelection?.() → { provider, model }
 *   - webServer.register({ kind: 'prefix', path, handler }, label)
 */

import Schema from '@deepseek-ai/schemastery'

export const name = 'followup'

export const inject = ['llm']

export const Config = Schema.object({
  /** 总开关：关闭后不监听任何事件，也不注册 web 端点。 */
  enabled: Schema.boolean().default(true).description('是否启用智能跟进推荐'),
  /** 留空则跟随会话当前模型（agent.options）。 */
  provider: Schema.string().description('生成建议使用的 provider（留空跟随会话）'),
  /** 建议配一个快模型：这条调用在每轮回复结束后立刻发生。 */
  model: Schema.string().description('生成建议使用的模型（留空跟随会话，建议快模型）'),
  /** 单次生成超时；超时即放弃本轮建议。 */
  timeoutMs: Schema.number().default(12000).description('生成超时（毫秒）'),
  /** 回合落定后等多久再生成：缓冲多步回合的中间 idle。 */
  idleDelayMs: Schema.number().default(1200).description('回合结束后的缓冲时间（毫秒）'),
  /** 生成几条建议（最多 3）。 */
  maxSuggestions: Schema.number().default(3).description('最多生成几条建议（2-3）'),
  /** 上下文裁剪：超出截断，控制这条调用的 token 开销。 */
  userChars: Schema.number().default(400).description('用户消息最多带多少字符'),
  assistantChars: Schema.number().default(1200).description('助手回复最多带多少字符'),
  /** 助手回复短于此不生成：「好的」「完成」这类没有可跟进的实质内容。 */
  minAssistantChars: Schema.number().default(30).description('助手回复最小长度（字符）'),
})

/* ------------------------------------------------------------------ */
/* 提示词与解析                                                         */
/* ------------------------------------------------------------------ */

function clampTail(text, limit) {
  const clean = typeof text === 'string' ? text.trim() : ''
  if (clean.length <= limit) return clean
  return `…${clean.slice(-limit)}`
}

function buildPrompt(userText, assistantText, count, config) {
  return [
    `You generate follow-up suggestions for an AI chat session (DeepSeek Harness). Based on the exchange below, propose ${count} short follow-up prompts the user would most plausibly send next.`,
    '',
    'Rules:',
    '- Continue the conversation: refine, extend, verify or apply the assistant\'s last answer. Never generic filler like "还有吗" / "继续" / "tell me more".',
    '- One imperative sentence each: 8~24 Chinese characters or 6~16 English words. No trailing period, no quotes, no numbering, no emoji.',
    '- They must be sendable as-is: self-contained requests, not fragments.',
    '- Write in the same language as the exchange.',
    '- Output STRICT JSON only: an array of strings, nothing else. Example: ["第一条建议","第二条建议"]',
    '',
    '[User]',
    clampTail(userText, config.userChars),
    '',
    '[Assistant]',
    clampTail(assistantText, config.assistantChars),
  ].join('\n')
}

/** 从模型输出里抠 JSON 数组；抠不出就返回空数组，宁缺毋滥。 */
function parseSuggestions(text, count) {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().replace(/^[-*•\d.)、\s]+/, '').slice(0, 60))
    .filter((item) => item.length >= 2)
    .slice(0, count)
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                             */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  if (!config.enabled) return

  /** 每个 agent 的对话尾部累积：userText 来自 pre-step，assistantText 来自流帧。 */
  const buffers = new WeakMap()
  const bufferOf = (agent) => {
    let buf = buffers.get(agent)
    if (buf === undefined) {
      buf = { userText: '', assistantText: '', controller: null }
      buffers.set(agent, buf)
    }
    return buf
  }

  /** 供 web 端拉取的最近一份建议；seq 递增，客户端凭它去重。 */
  let latest = { seq: 0, suggestions: [] }
  /** 最近一次生成的上下文，供「换一批」重生成。 */
  let lastContext = null
  let seqCounter = 0
  let pendingTimer = 0

  const say = (level, message) => {
    try {
      console[level === 'error' ? 'error' : 'info'](`[dsh-followup] ${message}`)
    } catch { /* ignore */ }
  }

  function singleTextOf(message) {
    if (!message || message.role !== 'user') return null
    // dsh 内部还有 goal / session-reference / notice 等来源的 user 消息，
    // 不是用户在对话框里输入的内容，不进上下文。
    if (message.source?.kind !== 'user') return null
    if (!Array.isArray(message.content) || message.content.length !== 1) return null
    const block = message.content[0]
    return block && block.type === 'text' && typeof block.text === 'string' ? block.text : null
  }

  function defaultRoute() {
    const defaults = ctx.get('agentDefaultModel')
    const selection = defaults?.currentSelection?.()
    return selection?.provider && selection?.model
      ? { provider: selection.provider, model: selection.model }
      : null
  }

  function configRoute() {
    return config.provider && config.model ? { provider: config.provider, model: config.model } : null
  }

  function resolveRoute(agent) {
    const provider = agent?.options?.provider
    const model = agent?.options?.model
    return configRoute()
      ?? (provider && model ? { provider, model } : null)
      ?? defaultRoute()
  }

  function cancelPending(buf, reason) {
    if (buf.controller) {
      try { buf.controller.abort(new Error(reason)) } catch { /* ignore */ }
      buf.controller = null
    }
  }

  /* -- 事件监听：拼出对话尾部 --------------------------------------- */

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const buf = bufferOf(agent)
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = singleTextOf(messages[i])
      if (text !== null) { buf.userText = text; break }
    }
    buf.assistantText = ''
    // 用户已经开始说下一句：上一份没生成的建议直接作废。
    cancelPending(buf, 'superseded by next user message')
    return next()
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const buf = bufferOf(agent)
    if (frame?.type === 'start') { buf.assistantText = ''; return }
    const chunk = frame?.type === 'chunk' ? frame.chunk : null
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      buf.assistantText += chunk.text
      // 超长回复只保留尾部，控制内存。
      if (buf.assistantText.length > 20000) buf.assistantText = buf.assistantText.slice(-10000)
    }
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const buf = bufferOf(agent)
    if (status !== 'idle') {
      // 回合重新运转（工具链下一步）：撤销缓冲中的生成计划。
      cancelPending(buf, 'agent running again')
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = 0 }
      return
    }
    const userText = (buf.userText ?? '').trim()
    const assistantText = (buf.assistantText ?? '').trim()
    if (!userText || assistantText.length < config.minAssistantChars) return
    // 缓冲片刻：多步回合的步骤之间也会闪现 idle，期间回到 running 就作废。
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => {
      pendingTimer = 0
      void generateFor(agent, buf, userText, assistantText)
    }, Math.max(200, config.idleDelayMs))
  })

  /* -- 生成 --------------------------------------------------------- */

  async function runGeneration(route, userText, assistantText, signal) {
    const count = Math.min(3, Math.max(2, Math.round(config.maxSuggestions)))
    const iterator = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(userText, assistantText, count, config) }] }],
      maxTokens: 220,
      signal,
    })[Symbol.asyncIterator]()
    let text = ''
    try {
      for (;;) {
        const { done, value } = await iterator.next()
        if (done) break
        if (value?.type === 'text-delta' && typeof value.text === 'string') text += value.text
        else if (value?.type === 'finish' && value.reason && (value.reason.kind === 'error' || value.reason.kind === 'aborted')) {
          throw new Error(`followup llm ${value.reason.kind}`)
        }
      }
    } catch (err) {
      // 中断底层流，失败后不在后台继续烧 token。
      try {
        const closing = iterator.return?.()
        if (closing && typeof closing.catch === 'function') closing.catch(() => {})
      } catch { /* ignore */ }
      throw err
    }
    return parseSuggestions(text, count)
  }

  async function generateFor(agent, buf, userText, assistantText) {
    const route = resolveRoute(agent)
    if (!route) { say('info', 'no model route available, skip'); return }
    const controller = new AbortController()
    buf.controller = controller
    const timer = setTimeout(() => controller.abort(new Error('followup timeout')), config.timeoutMs)
    try {
      const suggestions = await runGeneration(route, userText, assistantText, controller.signal)
      if (suggestions.length) {
        lastContext = { route, userText, assistantText }
        latest = { seq: ++seqCounter, suggestions }
        say('info', `turn ${latest.seq}: ${suggestions.length} suggestions`)
      }
    } catch (err) {
      if (!/aborted|superseded|timeout/i.test(String(err?.message ?? err))) {
        say('error', `generate failed: ${err?.message ?? err}`)
      }
    } finally {
      clearTimeout(timer)
      if (buf.controller === controller) buf.controller = null
    }
  }

  /* -- web 端点 ------------------------------------------------------ */

  // 可选注入：CLI / TUI 等没有 webServer 的宿主照常加载，只是没有 chips。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/api/dsh-followup',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(body))
        }
        const path = (req.url ?? '').split('?')[0].replace(/^\/api\/dsh-followup/, '')

        // 客户端在每次「生成中 → 空闲」后拉取；seq 相同就静默忽略。
        if (path === '/latest' && req.method === 'GET') {
          send(200, latest)
          return
        }

        // 换一批：用最近一轮的上下文重新生成一次。
        if (path === '/refresh' && req.method === 'POST') {
          if (!lastContext) { send(409, { error: 'no-context' }); return }
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(new Error('followup timeout')), config.timeoutMs)
          try {
            const suggestions = await runGeneration(lastContext.route, lastContext.userText, lastContext.assistantText, controller.signal)
            if (!suggestions.length) { send(502, { error: 'generate-failed' }); return }
            latest = { seq: ++seqCounter, suggestions }
            send(200, latest)
          } catch {
            send(502, { error: 'generate-failed' })
          } finally {
            clearTimeout(timer)
          }
          return
        }

        send(404, { error: 'not-found' })
      },
    }), 'dsh-followup: /api/dsh-followup/*')
  })
}

export default { name, Config, apply }
