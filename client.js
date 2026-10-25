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
.dsh-followup-box {
  position: fixed;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  pointer-events: none;
}
@keyframes dsh-followup-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.dsh-followup-item {
  display: inline-flex;
  align-items: flex-start;
  gap: 6px;
  max-width: 100%;
  padding: 4px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #DADDE5);
  font-size: 12px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
  pointer-events: auto;
  animation: dsh-followup-in 200ms ease-out both;
  transition: background 120ms ease;
}
.dsh-followup-item:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(237, 241, 248, 0.1));
}
@media (prefers-reduced-motion: reduce) { .dsh-followup-item, .dsh-followup-more { animation: none; } }
.dsh-followup-item .dsh-followup-arrow {
  flex: none;
  display: inline-flex;
  align-items: center;
  margin-top: 4px;
  color: var(--dsw-alias-label-tertiary, rgba(232, 238, 250, 0.55));
}
.dsh-followup-item .dsh-followup-arrow svg {
  display: block;
}
.dsh-followup-item:hover .dsh-followup-arrow {
  color: var(--dsw-alias-label-primary, #DADDE5);
}
.dsh-followup-text {
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.dsh-followup-more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, rgba(232, 238, 250, 0.55));
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
  pointer-events: auto;
  animation: dsh-followup-in 200ms ease-out both;
  transition: background 120ms ease, color 120ms ease;
}
.dsh-followup-more:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(237, 241, 248, 0.1));
  color: var(--dsw-alias-label-secondary, rgba(232, 238, 250, 0.72));
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

    /** 输入框上方的建议 chip 条；只在「草稿为空 + 有新建议」时渲染。 */
    function FollowupChips({ useInput, inputActions, sessionId }) {
      const draft = useInput((state) => state.draft)
      const [items, setItems] = React.useState(null)
      const shownSeq = React.useRef(0)
      const boxRef = React.useRef(null)

      // 会话切换（inputActions 换实例）时收起，避免把上一个会话的建议带过去。
      React.useEffect(() => { setItems(null) }, [inputActions])

      // 0.2.4：会话打开/切换时拉一次持久化建议——重启后打开对话仍然显示
      // 最近一轮的建议（Trae 逻辑：随会话持久化，无时间过期，下一轮替换）。
      const fetchLatest = React.useCallback(async () => {
        if (!inputActions || !sessionId) return
        const data = await fetchJson(`/latest?sessionId=${encodeURIComponent(sessionId)}`)
        if (!data || !Array.isArray(data.suggestions) || data.suggestions.length === 0) return
        if (data.seq === shownSeq.current) return
        shownSeq.current = data.seq
        setItems(data.suggestions)
      }, [inputActions, sessionId])
      React.useEffect(() => { void fetchLatest() }, [inputActions])

      // 用户一改草稿就收起：填入草稿本身也会触发这条，无需单独清理。
      React.useEffect(() => {
        if (typeof draft === 'string' && draft.length > 0) setItems(null)
      }, [draft])

      const load = React.useCallback(async () => {
        if (!inputActions || !sessionId) return
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
      }, [inputActions, sessionId])

      const loadRef = React.useRef(load)
      loadRef.current = load
      useTurnEnd(() => {
        window.setTimeout(() => { void loadRef.current() }, FETCH_DELAY_MS)
      })

      const refresh = async () => {
        if (!sessionId) return
        const data = await fetchJson('/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        if (!data || !Array.isArray(data.suggestions) || data.suggestions.length === 0) return
        shownSeq.current = data.seq
        setItems(data.suggestions)
      }

      /**
       * Trae 同款双区：点正文/箭头直接发送（先落草稿再 submit，让 Lexical
       * 先吃下文本）；点气泡图标只填进草稿编辑。绝不静默绕过编辑——
       * 直接发送也会先在输入框里闪现整句，用户看得到发的是什么。
       */
      const sendSuggestion = (text) => {
        if (!inputActions) return
        inputActions.setDraft(text)
        window.setTimeout(() => {
          try { inputActions.submit() } catch { /* fail-silent */ }
        }, 250)
      }

      // 贴在输入框卡片正上方：卡片顶边往上 10px，随卡片宽度与位置走。
      const place = () => {
        const box = boxRef.current
        const root = composerRoot()
        if (!box || !root) return
        const rect = root.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return
        box.style.left = `${rect.left}px`
        box.style.width = `${rect.width}px`
        box.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 4)}px`
      }

      React.useEffect(() => {
        if (!items) return undefined
        place()
        window.addEventListener('resize', place)
        const root = composerRoot()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null
        if (root && observer) observer.observe(root)
        return () => {
          window.removeEventListener('resize', place)
          observer?.disconnect()
        }
      }, [items])

      if (!inputActions || !items) return null
      // Trae 同款：纵向文本链接行，整行点击直接发送；「换一批」同款淡色行收尾。
      return h('div', { ref: boxRef, className: 'dsh-followup-box' },
        items.map((text, index) => h('button', {
          type: 'button',
          key: index,
          className: 'dsh-followup-item',
          title: text,
          onClick: () => sendSuggestion(text),
        },
        // codicon 同款右箭头（16 viewBox 描边箭头，替代图标字体）
        h('span', { className: 'dsh-followup-arrow' },
          h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true },
            h('path', { d: 'M2.5 8h10M9 4.5L12.5 8 9 11.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))),
        h('span', { className: 'dsh-followup-text' }, text))),
        h('button', {
          type: 'button',
          className: 'dsh-followup-more',
          title: '换一批跟进建议',
          'aria-label': '换一批跟进建议',
          onClick: () => { void refresh() },
        }, '↻ 换一批'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle()
        console.info('[dsh-followup] client 0.2.5 active')
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-followup',
          order: 60,
        }, FollowupChips))
      },
    }
  },
})
