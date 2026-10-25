/**
 * dsh-followup 的 web 客户端部分。
 *
 * 只做两件事：
 *  1. 感知「生成中 → 空闲」：观察输入区按钮的 aria-label（生成时发送键
 *     会变成停止键），从忙翻到闲即视为一轮回复落定，POST /generate 拿建议。
 *  2. 把建议渲染成 Trae 同款的纵向文本链接行（逆向自 Trae workbench
 *     desktop.main.css 的 .interactive-session-followups：右箭头 + 12px
 *     链接色、padding 4/8、无边框、hover 淡底、gap 6px 纵向堆叠），
 *     整行点击直接发送；尾部一条淡色「换一批」。用户一改草稿即隐藏。
 *
 * 定位与空闲判定复用已验证的稳定标识：
 *  - 输入区根 = `[data-composer-dock]` 的父节点（dock 只是底部那条，
 *    编辑器和按钮都在它的兄弟节点里）。
 *  - 忙判定 = 存在可见的 aria-label 含 停止/stop 的按钮。
 *  - CSS Modules class 是 hash，一律不依赖。
 */

window.__ModuleLoader__.load({
  id: 'dsh-followup',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STYLE_ID = 'dsh-followup-style'
    const ENDPOINT = '/api/dsh-followup'
    /** 落定后稍等一拍再拉取：让服务端的缓冲窗口先走完，避免拉到旧 seq。 */
    const FETCH_DELAY_MS = 400

    /* Trae 同款跟进建议（逆向自 D:\Trae CN workbench.desktop.main.css 的
       .interactive-session-followups 规则 + dark_blue.json 主题 token）：
       纵向堆叠的文本链接行——右箭头 + 12px 链接色文字，padding 4/8，
       无边框无胶囊，hover 淡底，容器 gap 6px 左对齐贴输入框上方。 */
    const CSS = `
.dsh-followup-anchor { display: none; }
.dsh-followup-box {
  /* 挂在 conversation.chat.turnTail：回合末尾、AI 正文下方、操作图标上方。
     流式元素，跟对话一起滚动，天然占位。 */
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin: 10px 0 2px;
}
@keyframes dsh-followup-in {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: none; }
}
/* 数值取自 Trae 截图的实测：背景 #171717、卡片 #222222，
   反推白色叠加 11/232 ≈ 0.05；卡片高 36px，圆角 6px，文字 #e5e5e5。 */
.dsh-followup-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  height: 36px;
  padding: 0 6px 0 12px;
  border: none;
  border-radius: var(--dsw-radius-md, 12px);
  background: rgba(255, 255, 255, 0.05);
  color: #e5e5e5;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
  animation: dsh-followup-in 200ms ease-out both;
  transition: background 120ms ease;
}
.dsh-followup-item:hover { background: rgba(255, 255, 255, 0.09); }
@media (prefers-reduced-motion: reduce) { .dsh-followup-item { animation: none; } }
.dsh-followup-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 箭头平时无底色；卡片 hover 时提亮，图标自己 hover 时出圆角底 */
.dsh-followup-send {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--dsw-radius-sm, 8px);
  color: rgba(255, 255, 255, 0.55);
  transition: background 120ms ease, color 120ms ease;
}
.dsh-followup-item:hover .dsh-followup-send { color: rgba(255, 255, 255, 0.78); }
.dsh-followup-item .dsh-followup-send:hover {
  background: rgba(255, 255, 255, 0.10);
  color: #ffffff;
}
.dsh-followup-add {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--dsw-radius-sm, 8px);
  color: rgba(255, 255, 255, 0.62);
  transition: background 120ms ease, color 120ms ease;
}
.dsh-followup-item:hover .dsh-followup-add { color: rgba(255, 255, 255, 0.80); }
.dsh-followup-item .dsh-followup-add:hover {
  background: rgba(255, 255, 255, 0.10);
  color: #ffffff;
}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /* ---------------------------------------------------------------- */
    /* 输入区探测                                                        */
    /* ---------------------------------------------------------------- */

    /** 输入区根节点：dock 只是底部那条，编辑器和按钮都在它的父节点下。 */
    function composerRoot() {
      const dock = document.querySelector('[data-composer-dock]')
      return dock ? dock.parentElement : null
    }

    function isVisible(button) {
      return button.offsetParent !== null || button.getClientRects().length > 0
    }

    /** 生成中：输入区里存在可见的「停止」按钮。 */
    function composerBusy(root) {
      if (!root) return false
      for (const button of root.querySelectorAll('button[aria-label]')) {
        const label = button.getAttribute('aria-label') ?? ''
        if (/停止|stop|中断/i.test(label) && isVisible(button)) return true
      }
      return false
    }

    /**
     * 观察忙 → 闲的翻转，即「一轮回复落定」。
     * 误报（语音停止键消失、会话切换）由服务端 seq 去重兜底，静默无害。
     */
    function useTurnEnd(onTurnEnd) {
      const callback = React.useRef(onTurnEnd)
      callback.current = onTurnEnd
      React.useEffect(() => {
        if (typeof document === 'undefined') return () => {}
        let wasBusy = composerBusy(composerRoot())
        let scheduled = false
        const check = () => {
          scheduled = false
          const busy = composerBusy(composerRoot())
          if (wasBusy && !busy) callback.current()
          wasBusy = busy
        }
        const schedule = () => {
          if (scheduled) return
          scheduled = true
          queueMicrotask(check)
        }
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-label'],
        })
        return () => observer.disconnect()
      }, [])
    }

    /* ---------------------------------------------------------------- */
    /* 浮层组件                                                          */
    /* ---------------------------------------------------------------- */

    async function fetchJson(path, options) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      try {
        const res = await fetch(`${ENDPOINT}${path}`, { ...options, signal: controller.signal })
        if (!res.ok) return null
        return await res.json()
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    }

    /* dock 槽位的标准 props 带 inputActions，overlay 槽位没有——用隐形
       桥接组件在 dock 里捕获（compaction-control 0.1.9 同款模式），
       视觉则完全交给 overlay 槽位。 */
    let inputActionsBridge = null

    function InputActionsBridge(props) {
      React.useEffect(() => {
        inputActionsBridge = props.inputActions ?? null
        return () => { if (inputActionsBridge === props.inputActions) inputActionsBridge = null }
      }, [props.inputActions])
      return null
    }

    /** 输入卡正上方的建议行（Trae 同位：输入区顶部的专属带）。 */
    function FollowupChips({ sessionId }) {
      const [items, setItems] = React.useState(null)
      const shownSeq = React.useRef(0)
      const boxRef = React.useRef(null)
      // turnTail 每个回合都会渲染一次，只有最后一个回合该显示建议。
      const [isLatestTurn, setIsLatestTurn] = React.useState(false)

      React.useEffect(() => {
        const box = boxRef.current
        if (!box) return
        const check = () => {
          const tails = document.querySelectorAll('[data-turn-tail]')
          const last = tails[tails.length - 1]
          setIsLatestTurn(Boolean(last && last.contains(box)))
        }
        check()
        const observer = new MutationObserver(check)
        observer.observe(document.body, { childList: true, subtree: true })
        return () => observer.disconnect()
      }, [])

      // 会话切换时收起，避免把上一个会话的建议带过去。
      React.useEffect(() => { setItems(null); shownSeq.current = 0 }, [sessionId])

      // 会话打开/切换时拉一次持久化建议——重启后打开对话仍然显示最近
      // 一轮的建议（Trae 逻辑：随会话持久化，无时间过期，下一轮替换）。
      // Trae 打字时建议保持可见（不做草稿联动隐藏）。
      const fetchLatest = React.useCallback(async () => {
        if (!sessionId) return
        const data = await fetchJson(`/latest?sessionId=${encodeURIComponent(sessionId)}`)
        if (!data || !Array.isArray(data.suggestions) || data.suggestions.length === 0) return
        if (data.seq === shownSeq.current) return
        shownSeq.current = data.seq
        setItems(data.suggestions)
      }, [sessionId])
      // turnTail 每个回合一个实例，只在最后一个回合拉数据，否则 N 个回合
      // 会同时打 N 次 /latest。
      React.useEffect(() => {
        if (!isLatestTurn) return
        void fetchLatest()
      }, [sessionId, isLatestTurn, fetchLatest])

      const load = React.useCallback(async () => {
        if (!sessionId || !inputActionsBridge) return
        // 0.2.0：日志驱动生成——服务端直读会话日志取最后一轮，不再依赖
        // 到不了插件进程的 agent 事件。
        const data = await fetchJson('/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        // Trae 逻辑：建议属于本轮响应——本轮没有新建议（生成失败/为空/
        // 无可跟进内容）就清掉旧建议，而不是继续显示上一轮的。
        if (!data || !Array.isArray(data.suggestions) || data.suggestions.length === 0) {
          setItems(null)
          return
        }
        if (data.seq === shownSeq.current) return
        shownSeq.current = data.seq
        setItems(data.suggestions)
      }, [sessionId])

      const loadRef = React.useRef(load)
      loadRef.current = load
      // useTurnEnd 可能只注册一次，用 ref 读最新的「是不是最后一个回合」，
      // 否则闭包里永远是初始的 false。
      const latestRef = React.useRef(isLatestTurn)
      latestRef.current = isLatestTurn
      useTurnEnd(() => {
        if (!latestRef.current) return
        window.setTimeout(() => { void loadRef.current() }, FETCH_DELAY_MS)
      })

      /**
       * Trae 同款双区：点正文/箭头直接发送（先落草稿再 submit，让 Lexical
       * 先吃下文本）；点气泡图标只填进草稿编辑。绝不静默绕过编辑——
       * 直接发送也会先在输入框里闪现整句，用户看得到发的是什么。
       */
      /** Trae 行为：点建议直接作为下一条消息发出（先落草稿再 submit，
       *  Lexical 先吃下文本，输入框里会闪现整句）；发出即收起本行。 */
      const sendSuggestion = (text) => {
        const actions = inputActionsBridge
        if (!actions) return
        setItems(null)
        actions.setDraft(text)
        window.setTimeout(() => {
          try { actions.submit() } catch { /* fail-silent */ }
        }, 250)
      }

      /** 点气泡图标：只把建议填进草稿，编辑后再发，不直接提交。 */
      const addToDraft = (text) => {
        const actions = inputActionsBridge
        if (!actions) return
        setItems(null)
        actions.setDraft(text)
      }

      // 锚点必须常驻：turnTail 每个回合都渲染一次，靠它判断自己是第几个，
      // 只在最后一个回合挂出建议。锚点本身 display:none，不占位。
      return h(React.Fragment, null,
        h('span', { ref: boxRef, className: 'dsh-followup-anchor', 'aria-hidden': true }),
        items !== null && isLatestTurn
          ? h('div', { className: 'dsh-followup-box' },
            items.slice(0, 2).map((text, index) => h('div', {
              key: index,
              className: 'dsh-followup-item',
              title: text,
              onClick: () => sendSuggestion(text),
            },
            h('span', { className: 'dsh-followup-text' }, text),
            // 右侧「发送」：独立的浅色方块，和 Trae 一致
            h('span', { className: 'dsh-followup-send' },
              h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true },
                h('path', { d: 'M4.5 11.5L11.5 4.5M6.8 4.5h4.7v4.7', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))),
            // 「添加到对话」：只填草稿，所以要挡住冒泡，避免顺带发送
            h('span', {
              className: 'dsh-followup-add',
              title: '添加到对话',
              onClick: (event) => { event.stopPropagation(); addToDraft(text) },
            },
            h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
              h('path', {
                d: 'M8 2.5c3.1 0 5.7 2.1 5.7 4.8S11.1 12.1 8 12.1c-.8 0-1.5-.1-2.2-.4L3.4 13l.7-2.2C2.8 9.9 2.3 8.7 2.3 7.3c0-2.7 2.6-4.8 5.7-4.8z',
                fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linejoin': 'round',
              }),
              h('circle', { cx: 5.9, cy: 7.3, r: 0.75, fill: 'currentColor' }),
              h('circle', { cx: 8, cy: 7.3, r: 0.75, fill: 'currentColor' }),
              h('circle', { cx: 10.1, cy: 7.3, r: 0.75, fill: 'currentColor' }))))))
          : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle()
        console.info('[dsh-followup] client 0.3.0 active')
        // 视觉：turnTail 槽位（回合末尾、AI 正文下方、操作图标上方），
        // 流式占位，跟对话一起滚动。Trae 同款位置。
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'dsh-followup',
          order: 10,
        }, FollowupChips))
        // 隐形桥：dock 槽拿 inputActions（overlay 槽的 props 不带）。
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-followup-bridge',
          order: 60,
        }, InputActionsBridge))
      },
    }
  },
})
