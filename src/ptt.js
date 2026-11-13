'use strict'
/*
 * Bas-Konuş (push-to-talk) için sistem genelinde tuş dinleme.
 * Oyun ya da başka bir uygulama öndeyken de çalışsın diye uiohook-napi kullanılır; yalnızca
 * Bas-Konuş açıkken başlatılır, kapatılınca durdurulur. Modül yüklenemezse (desteklenmeyen
 * sistem, macOS'ta Erişilebilirlik izni yok) arayüz, tuşu yalnızca YANKI penceresi öndeyken dinler.
 */

// Tarayıcı tuş kodu (KeyboardEvent.code) → libuiohook tuş kodu (VC_*)
const CODES = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0A, Digit0: 0x0B,
  Minus: 0x0C, Equal: 0x0D, Backspace: 0x0E, Tab: 0x0F,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1A, BracketRight: 0x1B, Enter: 0x1C, ControlLeft: 0x1D,
  KeyA: 0x1E, KeyS: 0x1F, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2A, Backslash: 0x2B, IntlBackslash: 0x56,
  KeyZ: 0x2C, KeyX: 0x2D, KeyC: 0x2E, KeyV: 0x2F, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3A,
  F1: 0x3B, F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, F11: 0x57, F12: 0x58,
  NumLock: 0x45, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4A, Numpad4: 0x4B, Numpad5: 0x4C, Numpad6: 0x4D, NumpadAdd: 0x4E,
  Numpad1: 0x4F, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
  NumpadEnter: 0x0E1C, ControlRight: 0x0E1D, NumpadDivide: 0x0E35, PrintScreen: 0x0E37, AltRight: 0x0E38, Pause: 0x0E45,
  Home: 0x0E47, PageUp: 0x0E49, End: 0x0E4F, PageDown: 0x0E51, Insert: 0x0E52, Delete: 0x0E53,
  ArrowUp: 0xE048, ArrowLeft: 0xE04B, ArrowRight: 0xE04D, ArrowDown: 0xE050,
  MetaLeft: 0x0E5B, MetaRight: 0x0E5C, ContextMenu: 0x0E5D
}
// Tarayıcı fare düğmesi (MouseEvent.button) → uiohook düğmesi
const MOUSE = { 1: 3, 3: 4, 4: 5 }

class PushToTalk {
  constructor (send, systemPreferences) {
    this.send = send
    this.sysPrefs = systemPreferences
    this.hook = null
    this.down = false
    this.handlers = null
  }

  configure ({ on, key } = {}) {
    this.stop()
    if (!on || !key) return { ok: true, global: false }
    const want = key.t === 'mouse' ? { mouse: MOUSE[key.b] } : { code: CODES[key.code] }
    if (!want.mouse && !want.code) return { ok: false, global: false, reason: 'key' }
    if (process.platform === 'darwin' && this.sysPrefs && !this.sysPrefs.isTrustedAccessibilityClient(true)) {
      return { ok: false, global: false, reason: 'mac-access' }
    }
    let uIOhook
    try { ({ uIOhook } = require('uiohook-napi')) } catch { return { ok: false, global: false, reason: 'unavailable' } }
    const set = (v) => { if (v !== this.down) { this.down = v; this.send({ type: 'ptt', down: v }) } }
    this.handlers = want.mouse
      ? { mousedown: (e) => { if (e.button === want.mouse) set(true) }, mouseup: (e) => { if (e.button === want.mouse) set(false) } }
      : { keydown: (e) => { if (e.keycode === want.code) set(true) }, keyup: (e) => { if (e.keycode === want.code) set(false) } }
    try {
      for (const [ev, fn] of Object.entries(this.handlers)) uIOhook.on(ev, fn)
      uIOhook.start()
      this.hook = uIOhook
      return { ok: true, global: true }
    } catch (e) {
      for (const [ev, fn] of Object.entries(this.handlers)) uIOhook.off(ev, fn)
      this.handlers = null
      return { ok: false, global: false, reason: 'unavailable' }
    }
  }

  stop () {
    if (this.down) { this.down = false; this.send({ type: 'ptt', down: false }) }
    if (!this.hook) return
    for (const [ev, fn] of Object.entries(this.handlers || {})) this.hook.off(ev, fn)
    this.handlers = null
    try { this.hook.stop() } catch {}
    this.hook = null
  }
}

module.exports = { PushToTalk, CODES, MOUSE }
