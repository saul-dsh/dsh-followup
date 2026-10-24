/**
 * dsh-followup 的 web 客户端部分。
 *
 * 只做两件事：
 *  1. 感知「生成中 → 空闲」：观察输入区按钮的 aria-label（生成时发送键
 *     会变成停止键），从忙翻到闲即视为一轮回复落定，拉取服务端建议。
 *  2. 把建议渲染成 Trae 式 chip，浮在输入框卡片上方，双区交互：
 *     点正文/箭头 = 直接发送（setDraft 后延迟 submit，先在输入框里
 *     闪现整句）；点气泡图标 = 只填进草稿编辑。用户一改草稿 chip 即隐藏。
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

    const CSS = `
.dsh-followup-box {
  position: fixed;
  z-index: 40;
  display: flex;
  justify-content: flex-start;
  pointer-events: none;
}
.dsh-followup-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  pointer-events: auto;
  animation: dsh-followup-in 200ms ease-out both;
}
@keyframes dsh-followup-in {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) { .dsh-followup-row { animation: none; } }
.dsh-followup-chip {
  display: inline-flex;
  align-items: stretch;
  max-width: 100%;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06));
  overflow: hidden;
  transition: background 120ms ease, border-color 120ms ease;
}
.dsh-followup-chip:hover {
  background: var(--dsw-alias-interactive-bg-active, rgba(255, 255, 255, 0.12));
  border-color: rgba(255, 255, 255, 0.18);
}
.dsh-followup-send {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 7px 8px 7px 12px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-primary, rgba(232, 238, 250, 0.88));
  font-size: 13px;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
}
.dsh-followup-send:active { transform: scale(0.985); }
.dsh-followup-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
}
.dsh-followup-arrow {
  flex: none;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, rgba(232, 238, 250, 0.60));
}
.dsh-followup-add {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 7px 9px;
  border: none;
  border-left: 1px solid rgba(255, 255, 255, 0.10);
  background: transparent;
  color: var(--dsw-alias-label-secondary, rgba(232, 238, 250, 0.60));
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.dsh-followup-add:hover {
  color: var(--dsw-alias-label-primary, rgba(232, 238, 250, 0.88));
  background: rgba(255, 255, 255, 0.06);
}
.dsh-followup-tool {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary, rgba(232, 238, 250, 0.55));
  font-size: 12px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.dsh-followup-tool:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
  color: var(--dsw-alias-label-primary, rgba(232, 238, 250, 0.85));
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
    function FollowupChips({ useInput, inputActions }) {
      const draft = useInput((state) => state.draft)
      const [items, setItems] = React.useState(null)
      const shownSeq = React.useRef(0)
      const boxRef = React.useRef(null)

      // 会话切换（inputActions 换实例）时收起，避免把上一个会话的建议带过去。
      React.useEffect(() => { setItems(null) }, [inputActions])

      // 用户一改草稿就收起：填入草稿本身也会触发这条，无需单独清理。
      React.useEffect(() => {
        if (typeof draft === 'string' && draft.length > 0) setItems(null)
      }, [draft])

      const load = React.useCallback(async () => {
        if (!inputActions) return
        const data = await fetchJson('/latest')
        if (!data || !Array.isArray(data.suggestions) || data.suggestions.length === 0) return
        if (data.seq === shownSeq.current) return
        shownSeq.current = data.seq
        setItems(data.suggestions)
      }, [inputActions])

      const loadRef = React.useRef(load)
      loadRef.current = load
      useTurnEnd(() => {
        window.setTimeout(() => { void loadRef.current() }, FETCH_DELAY_MS)
      })

      const refresh = async () => {
        const data = await fetchJson('/refresh', { method: 'POST' })
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
        box.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 10)}px`
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
      return h('div', { ref: boxRef, className: 'dsh-followup-box' },
        h('div', { className: 'dsh-followup-row' },
          items.map((text, index) => h('span', { key: index, className: 'dsh-followup-chip' },
            h('button', {
              type: 'button',
              className: 'dsh-followup-send',
              title: '发送',
              onClick: () => sendSuggestion(text),
            },
              h('span', { className: 'dsh-followup-text' }, text),
              h('span', { className: 'dsh-followup-arrow' }, '→'),
            ),
            h('button', {
              type: 'button',
              className: 'dsh-followup-add',
              title: '添加到对话',
              'aria-label': '添加到对话',
              onClick: () => inputActions.setDraft(text),
            }, '💬'),
          )),
          h('button', {
            type: 'button',
            className: 'dsh-followup-tool',
            title: '换一批',
            'aria-label': '换一批跟进建议',
            onClick: () => { void refresh() },
          }, '↻'),
          h('button', {
            type: 'button',
            className: 'dsh-followup-tool',
            title: '关闭',
            'aria-label': '关闭跟进建议',
            onClick: () => setItems(null),
          }, '✕'),
        ))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle()
        console.info('[dsh-followup] client 0.1.2 active')
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-followup',
          order: 60,
        }, FollowupChips))
      },
    }
  },
})
