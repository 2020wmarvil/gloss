// Real input through CDP, with a drawn cursor (screen captures don't include the OS cursor).
import { sleep } from './app.mjs'

const CURSOR = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="24" viewBox="0 0 22 24"><path d="M3 2 L3 19 L7.6 15 L10.6 21.6 L13.6 20.2 L10.7 13.8 L17 13.5 Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>`

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

export class Human {
  constructor(target) {
    this.t = target
    this.x = 700
    this.y = 500
  }

  async showCursor() {
    await this.t.eval(`(() => {
      if (document.getElementById('marketing-cursor')) return
      const c = document.createElement('div')
      c.id = 'marketing-cursor'
      c.innerHTML = ${JSON.stringify(CURSOR)}
      c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));will-change:transform'
      document.documentElement.appendChild(c)
      window.__moveCursor = (x0, y0, x1, y1, ms) => {
        const eased = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
        const start = performance.now()
        const step = (now) => {
          const k = Math.min(1, (now - start) / ms)
          const e = eased(k)
          c.style.transform = 'translate(' + (x0 + (x1 - x0) * e) + 'px,' + (y0 + (y1 - y0) * e) + 'px)'
          if (k < 1) requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }
    })()`)
    await this.place(this.x, this.y)
  }

  async place(x, y) {
    this.x = x
    this.y = y
    await this.t.eval(`document.getElementById('marketing-cursor') && (document.getElementById('marketing-cursor').style.transform = 'translate(${x}px,${y}px)')`)
  }

  async move(x, y, { duration = 450, buttons = 0, button = 'none' } = {}) {
    const [fromX, fromY] = [this.x, this.y]
    await this.t.eval(`window.__moveCursor?.(${fromX}, ${fromY}, ${x}, ${y}, ${duration})`)
    // The page draws the cursor; the app only needs enough mouse events to hover and drag.
    const start = Date.now()
    for (let k = 0; k < 1; ) {
      k = Math.min(1, (Date.now() - start) / Math.max(duration, 1))
      const e = ease(k)
      this.x = fromX + (x - fromX) * e
      this.y = fromY + (y - fromY) * e
      await this.t.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: this.x, y: this.y, buttons, button })
      if (k < 1) await sleep(25)
    }
  }

  async press(button = 'left') {
    await this.t.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: this.x, y: this.y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 })
  }

  async release(button = 'left') {
    await this.t.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: this.x, y: this.y, button, buttons: 0, clickCount: 1 })
  }

  async clickAt(x, y, opts = {}) {
    await this.move(x, y, opts)
    await sleep(120)
    await this.press(opts.button)
    await sleep(50)
    await this.release(opts.button)
  }

  async rect(selector) {
    const r = await this.t.waitFor(`(() => { const e = ${selector}; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return r.width ? { x: r.x, y: r.y, w: r.width, h: r.height } : null })()`, { label: selector })
    return r
  }

  async click(selector, opts) {
    const r = await this.rect(selector)
    await this.clickAt(r.x + r.w / 2, r.y + r.h / 2, opts)
  }

  /** The first line's rectangle of `needle`, inside the last element matching `root`. */
  async textRect(needle, root = '.agent') {
    return await this.t.waitFor(`(() => {
      const roots = [...document.querySelectorAll(${JSON.stringify(root)})].reverse()
      for (const el of roots) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let n; (n = walker.nextNode()); ) {
          const at = n.data.indexOf(${JSON.stringify(needle)})
          if (at < 0) continue
          const range = document.createRange()
          range.setStart(n, at)
          range.setEnd(n, at + ${needle.length})
          n.parentElement.scrollIntoView({ block: 'center' })
          const rects = [...range.getClientRects()]
          const r = rects[0]
          return { x: r.x, y: r.y, w: r.width, h: r.height, lines: rects.length }
        }
      }
      return null
    })()`, { label: `text "${needle}"` })
  }

  /** Drags across text as a person would, then right-clicks it. */
  async selectText(needle, root) {
    const r = await this.textRect(needle, root)
    const y = r.y + r.h / 2
    await this.move(r.x + 1, y, { duration: 600 })
    await sleep(150)
    await this.press()
    await this.move(r.x + r.w - 1, y, { duration: Math.min(900, 250 + r.w * 2), buttons: 1, button: 'left' })
    await this.release()
    await sleep(350)
    return { x: r.x + r.w / 2, y }
  }

  async type(text, { delay = 28 } = {}) {
    for (const ch of text) {
      await this.t.send('Input.insertText', { text: ch })
      await sleep(delay + Math.random() * delay * 0.8)
    }
  }

  async key(key, { code = key, vk, modifiers = 0, text } = {}) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
    await this.t.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) })
    await this.t.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  enter(modifiers = 0) {
    return this.key('Enter', { vk: 13, text: '\r', modifiers })
  }
}
