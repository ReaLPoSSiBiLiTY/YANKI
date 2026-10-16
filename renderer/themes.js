'use strict'
/*
 * Temalar. Arka plan görselleri YANKI için kodla üretilmiş özgün çalışmalardır (telifsiz).
 * Her tema bir vurgu rengi, ikinci vurgu ve koyu bir taban renginden oluşur; tüm arayüz
 * tonları bu üçünden hesaplanır. Kullanıcı kendi resmini yükleyebilir; resimden otomatik
 * palet önerileri çıkarılır.
 */

const THEMES = [
  { id: 'yanki', name: 'YANKI', image: null, accent: '#ff4f8b', accent2: '#18c8ff', bg: '#0b0a14' },
  { id: 'neon', name: 'Neon Ufuk', image: 'neon', accent: '#ff3da5', accent2: '#ffb347', bg: '#12051f' },
  { id: 'space', name: 'Derin Uzay', image: 'space', accent: '#9b6bff', accent2: '#22d3ee', bg: '#070814' },
  { id: 'forest', name: 'Piksel Orman', image: 'forest', accent: '#f5c46b', accent2: '#7bd88f', bg: '#0c1418' },
  { id: 'dungeon', name: 'Lav Zindanı', image: 'dungeon', accent: '#ff7a2f', accent2: '#ffd166', bg: '#120c0a' },
  { id: 'ice', name: 'Buz Zirvesi', image: 'ice', accent: '#5ce1e6', accent2: '#a78bfa', bg: '#081222' },
  { id: 'ocean', name: 'Derin Okyanus', image: 'ocean', accent: '#2dd4bf', accent2: '#60a5fa', bg: '#03131b' },
  { id: 'midnight', name: 'Gece Yarısı', image: null, accent: '#5b8cff', accent2: '#a78bfa', bg: '#080b16' },
  { id: 'ember', name: 'Kor', image: null, accent: '#ff5d5d', accent2: '#ffb020', bg: '#120909' },
  { id: 'matrix', name: 'Terminal', image: null, accent: '#3ddc84', accent2: '#00e5ff', bg: '#050c08' }
]

// ---------- Renk yardımcıları ----------
function hexToRgb (hex) {
  const m = String(hex).replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 79, 139]
}
const rgbToHex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
function rgbToHsl (r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b); const min = Math.min(r, g, b)
  let h = 0; let s = 0; const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h *= 60
  }
  return [h, s * 100, l * 100]
}
function hslToHex (h, s, l) {
  s /= 100; l /= 100
  const k = n => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255)
}

// Taban ve vurgu renklerinden tüm arayüz tonlarını üret
function themeTokens (t) {
  const [h, s] = rgbToHsl(...hexToRgb(t.bg))
  const sat = Math.min(s, 45)
  const shade = (l, sm = 1) => hslToHex(h, sat * sm, l)
  const [ah, as] = rgbToHsl(...hexToRgb(t.accent))
  const accent = hslToHex(ah, Math.max(as, 55), 62)
  return {
    '--bg-0': shade(4),
    '--bg-1': shade(7.5),
    '--bg-2': shade(10.5, 0.9),
    '--bg-3': shade(14, 0.85),
    '--bg-4': shade(19, 0.8),
    '--line': shade(17, 0.8),
    '--line-2': shade(24, 0.75),
    '--panel-rgb': hexToRgb(shade(7.5)).join(','),
    '--panel-2-rgb': hexToRgb(shade(11, 0.9)).join(','),
    '--accent': accent,
    '--accent-2': t.accent2 || hslToHex((ah + 40) % 360, 80, 62),
    '--accent-rgb': hexToRgb(accent).join(','),
    '--accent-2-rgb': hexToRgb(t.accent2 || accent).join(','),
    '--accent-ink': rgbToHsl(...hexToRgb(accent))[2] > 70 ? '#111' : '#fff'
  }
}

let customImage = null

async function loadCustomThemeImage () {
  try { customImage = await window.yanki.loadThemeImage() } catch { customImage = null }
  return customImage
}

function currentTheme (cfg) {
  if (cfg && cfg.id === 'custom') return { id: 'custom', name: 'Özel', image: customImage ? 'custom' : null, accent: cfg.accent || '#ff4f8b', accent2: cfg.accent2 || '#18c8ff', bg: cfg.bg || '#0b0a14' }
  const base = THEMES.find(t => t.id === (cfg && cfg.id)) || THEMES[0]
  return { ...base, accent: cfg?.accentOverride || base.accent }
}

function applyTheme (cfg) {
  const t = currentTheme(cfg)
  const root = document.documentElement
  for (const [k, v] of Object.entries(themeTokens(t))) root.style.setProperty(k, v)
  const hasImage = !!t.image
  const url = t.image === 'custom' ? customImage : t.image ? `themes/${t.image}.jpg` : null
  root.style.setProperty('--wall-image', url ? `url("${url}")` : 'none')
  root.style.setProperty('--wall-dim', String((cfg?.dim ?? (hasImage ? 45 : 0)) / 100))
  root.style.setProperty('--wall-blur', (cfg?.blur ?? 0) + 'px')
  root.style.setProperty('--panel-a', hasImage ? String(1 - (cfg?.glass ?? 30) / 100) : '1')
  document.body.classList.toggle('has-wall', hasImage)
}

// Resimden baskın renkleri çıkar (k-ortalamalar) ve palet önerileri üret
async function extractPalettes (dataUrl) {
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = dataUrl })
  const c = document.createElement('canvas')
  c.width = 96; c.height = 54
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0, 96, 54)
  const data = ctx.getImageData(0, 0, 96, 54).data
  const px = []
  for (let i = 0; i < data.length; i += 4) px.push([data[i], data[i + 1], data[i + 2]])
  const k = 7
  let cents = Array.from({ length: k }, (_, i) => px[Math.floor((i + 0.5) * px.length / k)].slice())
  for (let it = 0; it < 10; it++) {
    const sums = cents.map(() => [0, 0, 0, 0])
    for (const p of px) {
      let best = 0; let bd = Infinity
      cents.forEach((cc, j) => { const d = (p[0] - cc[0]) ** 2 + (p[1] - cc[1]) ** 2 + (p[2] - cc[2]) ** 2; if (d < bd) { bd = d; best = j } })
      const s = sums[best]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++
    }
    cents = sums.map((s, j) => s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3], s[3]] : cents[j])
  }
  const cols = cents.map(cc => ({ rgb: cc.slice(0, 3), n: cc[3] || 0, hsl: rgbToHsl(...cc.slice(0, 3)) }))
  // Taban: en koyu baskın renk
  const darkest = [...cols].sort((a, b) => a.hsl[2] - b.hsl[2])[0]
  const bg = hslToHex(darkest.hsl[0], Math.min(darkest.hsl[1], 40), 7)
  // Vurgu adayları: en doygun renkler, parlaklıkları ayarlanmış
  const vivid = [...cols].sort((a, b) => (b.hsl[1] * (1 - Math.abs(b.hsl[2] - 55) / 60)) - (a.hsl[1] * (1 - Math.abs(a.hsl[2] - 55) / 60)))
  const pick = vivid.map(cc => hslToHex(cc.hsl[0], Math.max(60, cc.hsl[1]), 62))
  const uniq = []
  for (const p of pick) if (!uniq.some(u => hueDist(u, p) < 18)) uniq.push(p)
  while (uniq.length < 4) uniq.push(hslToHex((rgbToHsl(...hexToRgb(uniq[0] || '#ff4f8b'))[0] + 90 * uniq.length) % 360, 75, 62))
  return uniq.slice(0, 5).map((a, i) => ({ accent: a, accent2: uniq[(i + 1) % uniq.length], bg }))
}
function hueDist (a, b) {
  const ha = rgbToHsl(...hexToRgb(a))[0]; const hb = rgbToHsl(...hexToRgb(b))[0]
  const d = Math.abs(ha - hb)
  return Math.min(d, 360 - d)
}

window.THEMES = THEMES
window.applyTheme = applyTheme
window.extractPalettes = extractPalettes
window.loadCustomThemeImage = loadCustomThemeImage
window.themeTokens = themeTokens
window.currentTheme = currentTheme
window.themeImage = { get: () => customImage, set: (v) => { customImage = v } }
