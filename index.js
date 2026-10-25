/**
 * dsh-followup — 每轮对话结束后的智能跟进推荐（DeepSeek Harness / dsh）
 *
 * Trae「智能跟进推荐」的同款交互：助手回复落定后，用一次轻量模型调用
 * 生成 2-3 条短跟进建议，缓存在内存里；web 端在输入框上方浮出可点击
 * 的 chip，点击把建议填进草稿（不自动发送）。
 *
 * 工作原理（服务端半）：
 *   主通道（0.2.3 起，借鉴 dsh-cost-meter 的链尾监听模式）：
 *   - ctx.on('llm/stream', listener, { global: true })：llm 服务的瀑布事件，
 *     每次 ctx.llm.stream() 都会经过。监听器拿到下游流后包一层旁路观察
 *     （逐 chunk 透传，不改流协议），累积 text-delta 得到助手回复；
 *     options.sessionId（GenerateOptions.sessionId，dsh-reference types.ts）
 *     关联会话，options.messages 里最后一个真实用户消息作为本轮输入。
 *     { global: true } 让监听器收到隔离 llm 作用域（记忆插件等）的流。
 *     AsyncLocalStorage 深度标记排除两类重复捕获：包装路由插件在自己
 *     stream() 体内再发起的上游调用（pull 下游时打标记），以及本插件
 *     自己发起的建议生成调用（发起时打标记）。
 *   回落通道：
 *   - 客户端回合落定后 POST /generate {sessionId}；服务端优先用 llm/stream
 *     实时捕获的缓存（10 分钟内），未命中才解压 session.v4.jsonl.zstd 直读
 *     （日志驱动，0.2.0 引入，对新架构进程分裂免疫）
 *   旧架构事件监听（agent/pre-step / assistant-stream / status）保留：
 *   收不到事件的宿主上它们是死代码，旧版本 dsh 上仍可用。
 *
 * 已核对的 dsh API（deepseek-ai/deepseek-harness，对照 dsh-reference）：
 *   - ctx.on('llm/stream', (options, next) => AsyncIterable, { global: true })
 *     监听器契约：必须调用 next() 推进瀑布并返回（包装的）流；嵌套/排除
 *     时原样返回 next() 的下游
 *   - GenerateOptions.sessionId?: Branded<'SessionId'>（packages/llm/llm/src/types.ts）
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
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'followup'

const DIAG_LOG = join(homedir(), '.dsh', 'followup-debug.log')
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')
const PROFILES_ROOT = join(homedir(), '.dsh', 'profiles')
const SUGGEST_FILE = join(homedir(), '.dsh', 'followup-suggestions.json')

/** 每环节一行落盘：事件是否到、文本抓没抓到、生成成没成，一次复现即可定位断点。 */
const report = async (line) => {
  try {
    await mkdir(dirname(DIAG_LOG), { recursive: true })
    await appendFile(DIAG_LOG, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 会话日志直读（新架构进程分裂后 agent/* 事件到不了插件进程，           */
/* 0.2.0 起改为日志驱动：解压 session.v4.jsonl.zstd 取最后一轮文本）    */
/* ------------------------------------------------------------------ */

/** 多帧 zstd（追加写每帧独立）：按魔数切段逐帧解压，坏帧跳过。 */
async function decompressLog(file) {
  const zlib = await import('node:zlib')
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('node zlib 无 zstd 支持（需 Node ≥23.8）')
  }
  const buf = await readFile(file)
  const MAGIC = 0x28
  const idxs = [0]
  for (let i = 4; i <= buf.length - 4; i += 1) {
    if (buf[i] === MAGIC && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) idxs.push(i)
  }
  let out = ''
  for (let k = 0; k < idxs.length; k += 1) {
    try {
      out += zlib.zstdDecompressSync(buf.subarray(idxs[k], idxs[k + 1] ?? buf.length)).toString('utf8')
    } catch { /* 截断/坏帧跳过 */ }
  }
  return out
}

/** 找会话日志文件：目录名可能是裸 uuid 或 session-<uuid>。 */
async function findSessionFile(sessionId) {
  const bare = String(sessionId).replace(/^session-/, '')
  let workspaces = []
  try { workspaces = await readdir(SESSIONS_ROOT, { withFileTypes: true }) } catch { return null }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    for (const name of [sessionId, `session-${bare}`, bare]) {
      const file = join(SESSIONS_ROOT, ws.name, name, 'session.v4.jsonl.zstd')
      try { await readFile(file); return file } catch { /* 尝试下一个 */ }
    }
  }
  return null
}

/** 从持久日志提取最后一轮：最后一个真实用户消息 + 其后最后的助手文本。 */
async function lastTurnFromLog(sessionId) {
  const file = await findSessionFile(sessionId)
  if (!file) return null
  const text = await decompressLog(file)
  const events = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try { events.push(JSON.parse(line)) } catch { /* 半行跳过 */ }
  }
  const isRealUser = (e) => e?.type === 'user/message'
    && e.data?.source?.kind === 'user'
    && Array.isArray(e.data.content) && e.data.content.length === 1
    && e.data.content[0]?.type === 'text' && typeof e.data.content[0].text === 'string'
  const isAssistant = (e) => e?.type === 'assistant/message'
  let assistantText = null
  let userText = null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (assistantText === null && isAssistant(e)) {
      const blocks = e.data?.message?.content
      if (Array.isArray(blocks)) {
        const joined = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text).join('')
        if (joined.trim().length > 0) assistantText = joined
      }
      continue
    }
    if (assistantText !== null && isRealUser(e)) {
      userText = e.data.content[0].text
      break
    }
  }
  if (userText === null || assistantText === null) return null
  return { userText: userText.trim(), assistantText: assistantText.trim() }
}

/** 从 profile 用户补丁层读 agent-default-model 的 provider/model（兜底路由）。 */
async function patchDefaultRoute() {
  let profiles = []
  try { profiles = await readdir(PROFILES_ROOT, { withFileTypes: true }) } catch { return null }
  for (const p of profiles) {
    if (!p.isDirectory()) continue
    try {
      const raw = await readFile(join(PROFILES_ROOT, p.name, 'cordis.patch.yml'), 'utf8')
      const m = raw.match(/id:\s*agent-default-model[\s\S]{0,300}?provider:\s*(\S+)[\s\S]{0,120}?model:\s*(\S+)/)
      if (m) return { provider: m[1].replace(/^['"]|['"]$/g, ''), model: m[2].replace(/^['"]|['"]$/g, '') }
    } catch { /* 下一个 profile */ }
  }
  return null
}

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
  maxSuggestions: Schema.number().default(2).description('最多生成几条建议（1-2）'),
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

  void report(`server boot v0.2.3 enabled=true minAssistantChars=${config.minAssistantChars} idleDelayMs=${config.idleDelayMs} route=${config.provider || ''}/${config.model || ''}(follow-session)`)

  /** 每个 agent 的对话尾部累积：userText 来自 pre-step，assistantText 来自流帧。 */
  const buffers = new WeakMap()
  const seenFrameTypes = new Set()
  let bufCounter = 0
  const agentConstructorName = (agent) => (agent === undefined || agent === null
    ? 'none'
    : `${agent.constructor?.name ?? typeof agent}`)
  const bufferOf = (agent) => {
    let buf = buffers.get(agent)
    if (buf === undefined) {
      buf = { id: ++bufCounter, userText: '', assistantText: '', controller: null }
      buffers.set(agent, buf)
      void report(`buffer new #${buf.id} for agent=${agentConstructorName(agent)}`)
    }
    return buf
  }

  /** 供 web 端拉取的最近一份建议；seq 递增，客户端凭它去重。 */
  let latest = { seq: 0, suggestions: [], at: 0 }
  /** 最近一次生成的上下文，供「换一批」重生成。 */
  let lastContext = null
  let seqCounter = 0
  let pendingTimer = 0

  /* -- 建议持久化（0.2.4）：重启后打开会话还能拿到最近一轮的建议 ----- */
  /** sessionId → { seq, suggestions, at }，boot 时读回，成功生成时写入。 */
  let persisted = {}
  try {
    persisted = JSON.parse(readFileSync(SUGGEST_FILE, 'utf8'))
    if (!persisted || typeof persisted !== 'object') persisted = {}
    for (const entry of Object.values(persisted)) {
      if (Number.isInteger(entry?.seq) && entry.seq > seqCounter) seqCounter = entry.seq
    }
    say('info', `restored ${Object.keys(persisted).length} persisted suggestion set(s)`)
  } catch { /* 首次或损坏：空表开始 */ }

  function persistSuggestions(sessionId, seq, suggestions) {
    if (!sessionId || !Array.isArray(suggestions) || suggestions.length === 0) return
    persisted[sessionId] = { seq, suggestions, at: Date.now() }
    const keys = Object.keys(persisted)
    if (keys.length > 24) {
      let oldest = null
      let oldestAt = Infinity
      for (const key of keys) {
        if (persisted[key].at < oldestAt) { oldestAt = persisted[key].at; oldest = key }
      }
      if (oldest !== null) delete persisted[oldest]
    }
    void writeFile(SUGGEST_FILE, `${JSON.stringify(persisted)}\n`, 'utf8')
      .catch(() => { /* 持久化失败不影响主流程 */ })
  }

  /** Trae 逻辑：建议属于「每轮响应」——本轮没有新建议就清掉该会话的旧建议。 */
  function clearSuggestions(sessionId) {
    if (!sessionId || !(sessionId in persisted)) return
    delete persisted[sessionId]
    void writeFile(SUGGEST_FILE, `${JSON.stringify(persisted)}\n`, 'utf8')
      .catch(() => { /* ignore */ })
  }

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

  /** llm/stream 捕获用：请求 messages 里最后一个真实用户文本。 */
  function singleTextOfLastUser(messages) {
    if (!Array.isArray(messages)) return null
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = singleTextOf(messages[i])
      if (text !== null) return text
    }
    return null
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

  /* -- 事件监听：拼出对话尾部（旧架构回落通道） ---------------------- */
  /* 新架构进程分裂下这些 agent/* 事件到不了插件进程（0.1.x 实证零事件），
     保留是为了旧版本 dsh 仍然可用；新架构走上面的 llm/stream 捕获 + 日志回落。 */

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const buf = bufferOf(agent)
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = singleTextOf(messages[i])
      if (text !== null) { buf.userText = text; break }
    }
    buf.assistantText = ''
    // 用户已经开始说下一句：上一份没生成的建议直接作废。
    cancelPending(buf, 'superseded by next user message')
    void report(`pre-step buf#${buf.id} agent=${agentConstructorName(agent)} msgs=${messages.length} userLen=${(buf.userText ?? '').length} userHead=${JSON.stringify((buf.userText ?? '').slice(0, 40))}`)
    return next()
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const buf = bufferOf(agent)
    if (frame?.type && !seenFrameTypes.has(frame.type)) {
      seenFrameTypes.add(frame.type)
      void report(`stream frame-type first-seen: ${frame.type} agent=${agentConstructorName(agent)}`)
    }
    if (frame?.type === 'start') { buf.assistantText = ''; return }
    const chunk = frame?.type === 'chunk' ? frame.chunk : null
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      buf.assistantText += chunk.text
      // 超长回复只保留尾部，控制内存。
      if (buf.assistantText.length > 20000) buf.assistantText = buf.assistantText.slice(-10000)
      return
    }
    if (frame?.type === 'end') {
      void report(`stream end buf#${buf.id} agent=${agentConstructorName(agent)} assistantLen=${(buf.assistantText ?? '').length}`)
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
    if (!userText || assistantText.length < config.minAssistantChars) {
      void report(`idle skip buf#${buf.id} agent=${agentConstructorName(agent)} userLen=${userText.length} assistantLen=${assistantText.length} (need user>0 & assistant>=${config.minAssistantChars})`)
      return
    }
    // 缓冲片刻：多步回合的步骤之间也会闪现 idle，期间回到 running 就作废。
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => {
      pendingTimer = 0
      void generateFor(agent, buf, userText, assistantText)
    }, Math.max(200, config.idleDelayMs))
  })

  /* -- 主通道：llm/stream 瀑布旁路捕获（0.2.3，借鉴 dsh-cost-meter） -- */

  /** 深度标记：存在即「本插件已知会、不需要再捕获」的 llm 流。 */
  const llmDepth = new AsyncLocalStorage()

  /** 实时捕获的最近一轮：sessionId → { userText, assistantText, at }。 */
  const turnCache = new Map()
  const TURN_CACHE_MAX = 24
  const TURN_CACHE_TTL_MS = 10 * 60_000

  function cachedTurnOf(sessionId) {
    const hit = turnCache.get(sessionId)
    if (!hit) return null
    if (Date.now() - hit.at > TURN_CACHE_TTL_MS) { turnCache.delete(sessionId); return null }
    return hit
  }

  function rememberTurn(sessionId, userText, assistantText) {
    if (!sessionId || !userText || !assistantText || assistantText.trim().length === 0) return
    const prev = turnCache.get(sessionId)
    // 同一轮的多步工具链 / 重试续流 userText 相同：助手文本追加累积，
    // 让「最终答案」落在缓存尾部（生成时 clampTail 取尾部正好命中）。
    const merged = prev && prev.userText === userText
      ? `${prev.assistantText}\n\n${assistantText}`
      : assistantText
    turnCache.set(sessionId, { userText, assistantText: merged.slice(-20000), at: Date.now() })
    if (turnCache.size > TURN_CACHE_MAX) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [key, value] of turnCache) {
        if (value.at < oldestAt) { oldestAt = value.at; oldestKey = key }
      }
      if (oldestKey !== null) turnCache.delete(oldestKey)
    }
  }

  // llm/stream 捕获是否活着是 0.2.3 的关键真机问题（新架构进程分裂下
  // 事件归属未实证），首帧与每次入缓存都留痕，一次对话即可从日志判定。
  let llmStreamArmed = false

  ctx.on('llm/stream', (options, next) => {
    // 自己发起的建议生成调用 / 下游包装路由的嵌套调用：原样透传。
    if (llmDepth.getStore() !== undefined) return next()
    const downstream = next()
    if (!llmStreamArmed) {
      llmStreamArmed = true
      void report('llm/stream first fire: capture channel is ALIVE in this process')
    }
    const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : ''
    const userText = (singleTextOfLastUser(options?.messages) ?? '').trim()
    let assistantText = ''
    let downstreamIter = null
    let completed = false
    return (async function* followupObserve() {
      try {
        downstreamIter = downstream[Symbol.asyncIterator]()
        for (;;) {
          // 深度标记内拉取：包装路由适配器在消费上下文里再发起的
          // ctx.llm.stream() 继承标记，内层监听器判定为已处理、透传。
          const result = await llmDepth.run(1, () => downstreamIter.next())
          if (result.done) break
          const chunk = result.value
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
            assistantText += chunk.text
            if (assistantText.length > 20000) assistantText = assistantText.slice(-10000)
          }
          yield chunk
        }
        completed = true
      } finally {
        // 消费方提前中断（用户改下一句、错误终止）也要收尾；流失败时
        // assistantText 不完整，通常过不了 minAssistantChars，无害。
        if (!completed) {
          try { await downstreamIter?.return?.() } catch { /* ignore */ }
        }
        try {
          rememberTurn(sessionId, userText, assistantText)
          void report(`llm/stream captured session=${sessionId ? sessionId.slice(0, 50) : '(none)'} userLen=${userText.length} assistantLen=${assistantText.length} ${!completed ? '(interrupted)' : ''}`)
        } catch { /* 缓存失败绝不影响主对话流 */ }
      }
    })()
  }, { global: true })

  /* -- 生成 --------------------------------------------------------- */

  async function runGeneration(llm, route, userText, assistantText, signal) {
    const count = Math.min(2, Math.max(1, Math.round(config.maxSuggestions)))
    // 深度标记内发起：本次生成调用经过 llm/stream 瀑布时，监听器读到
    // 标记即透传——建议生成的 prompt 不会被误缓存为对话轮。
    // reasoningEffort low + maxTokens 2000：真机 04:50 实测 profile 默认
    // high 推理把 600 上限全部烧光（raw len=0 → 无建议渲染）。
    const iterator = llmDepth.run(1, () => llm.stream({
      provider: route.provider,
      model: route.model,
      reasoningEffort: 'low',
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(userText, assistantText, count, config) }] }],
      maxTokens: 2000,
      signal,
    })[Symbol.asyncIterator]())
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
    void report(`raw output len=${text.length}: ${JSON.stringify(text.slice(0, 300))}`)
    return parseSuggestions(text, count)
  }

  async function generateFor(agent, buf, userText, assistantText) {
    const route = resolveRoute(agent)
    if (!route) {
      say('info', 'no model route available, skip')
      void report('generate skip: no model route (config unset, agent.options empty, agentDefaultModel missing)')
      return
    }
    const controller = new AbortController()
    buf.controller = controller
    const timer = setTimeout(() => controller.abort(new Error('followup timeout')), config.timeoutMs)
    // 根作用域没声明 llm inject 时属性访问直接抛（真机 07:41 实证）；
    // 捕住降级——cache/日志路径不受影响。
    let eventLlm = null
    try { eventLlm = ctx.llm } catch { eventLlm = null }
    if (eventLlm === null) {
      void report('event-path skip: llm not injectable in this scope (cache path covers it)')
      return
    }
    try {
      void report(`generate start route=${route.provider}/${route.model} userLen=${userText.length} assistantLen=${assistantText.length}`)
      const suggestions = await runGeneration(eventLlm, route, userText, assistantText, controller.signal)
      if (suggestions.length) {
        lastContext = { route, userText, assistantText }
        latest = { seq: ++seqCounter, suggestions, at: Date.now() }
        let eventSessionId = ''
        try { eventSessionId = agent?.session?.id ?? '' } catch { eventSessionId = '' }
        persistSuggestions(eventSessionId, latest.seq, suggestions)
        say('info', `turn ${latest.seq}: ${suggestions.length} suggestions`)
        void report(`generate ok seq=${latest.seq} count=${suggestions.length} ${JSON.stringify(suggestions)}`)
      } else {
        void report('generate empty: model returned no parseable suggestions')
      }
    } catch (err) {
      if (!/aborted|superseded|timeout/i.test(String(err?.message ?? err))) {
        say('error', `generate failed: ${err?.message ?? err}`)
        void report(`generate failed: ${String(err?.message ?? err).slice(0, 300)}`)
      } else {
        void report(`generate aborted: ${String(err?.message ?? err).slice(0, 120)}`)
      }
    } finally {
      clearTimeout(timer)
      if (buf.controller === controller) buf.controller = null
    }
  }

  /* -- web 端点 ------------------------------------------------------ */

  // 可选注入：CLI / TUI 等没有 webServer 的宿主照常加载，只是没有 chips。
  // llm 必须在此作用域声明——cordis 的属性访问按作用域校验 inject，
  // 根作用域的静态 inject 不传导进嵌套作用域（真机实测报
  // cannot get property "llm" without inject）。
  ctx.inject(['webServer', 'llm'], (webCtx) => {
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
        // Trae 逻辑：建议随会话持久化、无时间过期，只被下一轮替换或清除。
        if (path === '/latest' && req.method === 'GET') {
          const qs = new URL(req.url ?? '', 'http://local').searchParams
          const wantSession = qs.get('sessionId') ?? ''
          const entry = wantSession ? persisted[wantSession] : undefined
          if (entry && Array.isArray(entry.suggestions) && entry.suggestions.length > 0) {
            send(200, entry)
            return
          }
          send(200, latest)
          return
        }

        /**
         * 生成建议（0.2.3 双通道）：优先用 llm/stream 实时捕获的对话轮
         * （零文件 IO、无解析时延），未命中才回落日志驱动（0.2.0 引入，
         * 解压 session.v4.jsonl.zstd 直读）。
         */
        if ((path === '/generate' || path === '/refresh') && req.method === 'POST') {
          let body = ''
          for await (const chunk of req) body += chunk
          let sessionId = ''
          try { sessionId = JSON.parse(body).sessionId ?? '' } catch { sessionId = '' }
          if (!sessionId) { send(400, { error: 'missing sessionId' }); return }
          const cached = cachedTurnOf(sessionId)
          const turn = cached
            ? { userText: cached.userText, assistantText: cached.assistantText }
            : await lastTurnFromLog(sessionId)
          if (!turn) {
            void report(`generate(${cached ? 'cache' : 'log'}) ${path}: no usable turn in session ${String(sessionId).slice(0, 50)}`)
            // Trae 逻辑：建议属于每轮响应——本轮拿不到可跟进内容即清掉旧建议
            clearSuggestions(String(sessionId))
            send(409, { error: 'no-turn' })
            return
          }
          const route = configRoute() ?? defaultRoute() ?? await patchDefaultRoute()
          if (!route) {
            void report(`generate(${cached ? 'cache' : 'log'}): no route (config/agentDefaultModel/patch all missing)`)
            send(503, { error: 'no-route' })
            return
          }
          const source = cached ? 'cache' : 'log'
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(new Error('followup timeout')), config.timeoutMs)
          try {
            void report(`generate(${source}) start route=${route.provider}/${route.model} userLen=${turn.userText.length} assistantLen=${turn.assistantText.length}`)
            const suggestions = await runGeneration(webCtx.llm, route, turn.userText, turn.assistantText, controller.signal)
            if (!suggestions.length) {
              void report(`generate(${source}) empty`)
              // 同上：本轮生成失败/为空，旧建议不再属于最新一轮
              clearSuggestions(String(sessionId))
              send(502, { error: 'generate-failed' })
              return
            }
            lastContext = { route, ...turn }
            latest = { seq: ++seqCounter, suggestions, at: Date.now() }
            persistSuggestions(String(sessionId), latest.seq, suggestions)
            void report(`generate(${source}) ok seq=${latest.seq} ${JSON.stringify(suggestions)}`)
            send(200, latest)
          } catch (err) {
            void report(`generate(${source}) failed: ${String(err?.message ?? err).slice(0, 200)}`)
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
