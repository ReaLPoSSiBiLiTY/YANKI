'use strict'
/*
 * YANKI oyunları: Futbol, Arena (2D nişancı) ve Yılan
 * - Oyunu kuran kişi (ev sahibi) oyunu kendi bilgisayarında yürütür. Oyuncular yalnızca tuş
 *   durumlarını gönderir, ev sahibi saniyede 30 kez oyunun anlık görüntüsünü yollar.
 * - Paketler YANKI'nın P2P bağlantısından gider (sunucu yok). Bu dosya yalnızca bir oyun
 *   açıldığında yüklenir; oyun kapalıyken hiçbir döngü çalışmaz.
 */
;(function () {
  const TICK = 1000 / 30
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v
  const r1 = (v) => Math.round(v * 10) / 10
  const lerp = (a, b, t) => a + (b - a) * t
  const TEAM = ['#ff5d6c', '#4ea8ff']
  const PCOL = ['#ff5d6c', '#4ea8ff', '#3ddc84', '#ffc24b', '#b78cff', '#ff8a2a', '#18d4d4', '#ff7bd0']

  // Çarpışma: iki daire (kütle Infinity olabilir)
  function collide (a, b, e) {
    const dx = b.x - a.x; const dy = b.y - a.y
    const rr = a.r + b.r
    const d2 = dx * dx + dy * dy
    if (d2 >= rr * rr || d2 === 0) return false
    const d = Math.sqrt(d2); const nx = dx / d; const ny = dy / d
    const ia = a.m === Infinity ? 0 : 1 / a.m; const ib = b.m === Infinity ? 0 : 1 / b.m
    const over = rr - d
    a.x -= nx * over * ia / (ia + ib); a.y -= ny * over * ia / (ia + ib)
    b.x += nx * over * ib / (ia + ib); b.y += ny * over * ib / (ia + ib)
    const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny
    if (vn < 0) {
      const j = -(1 + e) * vn / (ia + ib)
      a.vx -= j * ia * nx; a.vy -= j * ia * ny
      b.vx += j * ib * nx; b.vy += j * ib * ny
    }
    return true
  }

  // =====================================================================
  // Futbol
  // =====================================================================
  const FB = { W: 840, H: 380, GM: 130, GD: 34, PR: 15, BR: 10, MARGIN: 30 }
  const Football = {
    name: 'Futbol', icon: 'ball', max: 10, teams: true,
    desc: 'Haxball tarzı 2D futbol. 3 gol atan ya da 3 dakika sonunda önde olan kazanır.',
    help: 'Hareket: WASD / ok tuşları · Şut: Boşluk ya da X',
    view: { w: FB.W + FB.MARGIN * 2 + FB.GD * 2 - 20, h: FB.H + FB.MARGIN * 2 },
    create (players) {
      const s = { players: players.map(p => ({ k: p.k, t: p.t, x: 0, y: 0, vx: 0, vy: 0, r: FB.PR, m: 1, kick: 0, cd: 0 })), ball: { x: 0, y: 0, vx: 0, vy: 0, r: FB.BR, m: 0.5 }, sc: [0, 0], tick: 0, pause: 0, flash: -1, over: false }
      const gy0 = (FB.H - FB.GM) / 2; const gy1 = gy0 + FB.GM
      s.posts = [[0, gy0], [0, gy1], [FB.W, gy0], [FB.W, gy1]].map(([x, y]) => ({ x, y, vx: 0, vy: 0, r: 6, m: Infinity }))
      s.kickoff = () => {
        s.ball.x = FB.W / 2; s.ball.y = FB.H / 2; s.ball.vx = s.ball.vy = 0
        for (const t of [0, 1]) {
          const team = s.players.filter(p => p.t === t)
          team.forEach((p, i) => {
            const n = team.length
            p.x = t === 0 ? FB.W * (i === 0 ? 0.3 : 0.15) : FB.W * (i === 0 ? 0.7 : 0.85)
            p.y = n === 1 ? FB.H / 2 : i === 0 ? FB.H / 2 : FB.H * (0.2 + 0.6 * ((i - 1) / Math.max(1, n - 2)))
            p.vx = p.vy = 0
          })
        }
      }
      s.kickoff()
      return s
    },
    step (s, inputs) {
      if (s.over) return
      s.tick++
      if (s.pause > 0) { if (--s.pause === 0) { s.flash = -1; s.kickoff() } return }
      for (const p of s.players) {
        const i = inputs.get(p.k) || {}
        let ax = (i.r ? 1 : 0) - (i.l ? 1 : 0); let ay = (i.d ? 1 : 0) - (i.u ? 1 : 0)
        if (ax && ay) { ax *= 0.7071; ay *= 0.7071 }
        p.kick = i.a ? 1 : 0
        const acc = p.kick ? 0.42 : 0.55
        p.vx = (p.vx + ax * acc) * 0.9; p.vy = (p.vy + ay * acc) * 0.9
        p.x += p.vx; p.y += p.vy
        p.x = clamp(p.x, -FB.MARGIN + p.r, FB.W + FB.MARGIN - p.r)
        p.y = clamp(p.y, -FB.MARGIN + p.r, FB.H + FB.MARGIN - p.r)
        if (p.cd > 0) p.cd--
      }
      const b = s.ball
      b.x += b.vx; b.y += b.vy
      b.vx *= 0.985; b.vy *= 0.985
      // Oyuncular arası ve oyuncu-top
      for (let i = 0; i < s.players.length; i++) for (let j = i + 1; j < s.players.length; j++) collide(s.players[i], s.players[j], 0.5)
      for (const p of s.players) {
        collide(p, b, 0.5)
        if (p.kick && !p.cd) {
          const dx = b.x - p.x; const dy = b.y - p.y; const d = Math.hypot(dx, dy)
          if (d < p.r + b.r + 5 && d > 0) { b.vx += dx / d * 6.2; b.vy += dy / d * 6.2; p.cd = 8 }
        }
        for (const q of s.posts) collide(q, p, 0.3)
      }
      for (const q of s.posts) collide(q, b, 0.6)
      // Duvarlar ve kaleler
      const gy0 = (FB.H - FB.GM) / 2; const gy1 = gy0 + FB.GM
      if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * 0.8 }
      if (b.y > FB.H - b.r) { b.y = FB.H - b.r; b.vy = -Math.abs(b.vy) * 0.8 }
      const inMouth = b.y > gy0 && b.y < gy1
      if (!inMouth) {
        if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * 0.8 }
        if (b.x > FB.W - b.r) { b.x = FB.W - b.r; b.vx = -Math.abs(b.vx) * 0.8 }
      } else {
        if (b.x < -FB.GD + b.r) { b.x = -FB.GD + b.r; b.vx = Math.abs(b.vx) * 0.5 }
        if (b.x > FB.W + FB.GD - b.r) { b.x = FB.W + FB.GD - b.r; b.vx = -Math.abs(b.vx) * 0.5 }
      }
      if (b.x < -b.r || b.x > FB.W + b.r) {
        const team = b.x < 0 ? 1 : 0 // sol kale kırmızının; içine giren top maviye gol
        s.sc[team]++
        s.flash = team
        s.pause = 60
        if (s.sc[team] >= 3) s.over = true
      }
      if (s.tick >= 30 * 180 && !s.pause) s.over = true
    },
    snap (s) {
      return { t: Math.max(0, 180 - Math.floor(s.tick / 30)), sc: s.sc, f: s.flash, b: [r1(s.ball.x), r1(s.ball.y)], p: s.players.map(p => [r1(p.x), r1(p.y), p.kick]) }
    },
    result (s, players) {
      if (s.sc[0] === s.sc[1]) return { text: `Berabere! ${s.sc[0]} - ${s.sc[1]}`, winners: [] }
      const w = s.sc[0] > s.sc[1] ? 0 : 1
      return { text: `${w === 0 ? 'Kırmızı' : 'Mavi'} takım kazandı! ${s.sc[0]} - ${s.sc[1]}`, winners: players.filter(p => p.t === w).map(p => p.k) }
    },
    draw (g, a, b, al, ctx) {
      const { players, me } = ctx
      const ox = FB.MARGIN + FB.GD - 10; const oy = FB.MARGIN
      g.fillStyle = '#2f7a43'; g.fillRect(0, 0, this.view.w, this.view.h)
      g.fillStyle = '#358a4b'
      for (let i = 0; i < 8; i++) if (i % 2) g.fillRect(ox + i * FB.W / 8, oy, FB.W / 8, FB.H)
      g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 3
      g.strokeRect(ox, oy, FB.W, FB.H)
      g.beginPath(); g.moveTo(ox + FB.W / 2, oy); g.lineTo(ox + FB.W / 2, oy + FB.H); g.stroke()
      g.beginPath(); g.arc(ox + FB.W / 2, oy + FB.H / 2, 60, 0, Math.PI * 2); g.stroke()
      const gy0 = oy + (FB.H - FB.GM) / 2
      g.fillStyle = 'rgba(255,255,255,.12)'
      g.fillRect(ox - FB.GD, gy0, FB.GD, FB.GM); g.fillRect(ox + FB.W, gy0, FB.GD, FB.GM)
      g.strokeRect(ox - FB.GD, gy0, FB.GD, FB.GM); g.strokeRect(ox + FB.W, gy0, FB.GD, FB.GM)
      for (const [x, y] of [[0, 0], [0, FB.GM], [FB.W, 0], [FB.W, FB.GM]]) { g.fillStyle = '#fff'; g.beginPath(); g.arc(ox + x, gy0 + y, 6, 0, 7); g.fill() }
      b.p.forEach((q, i) => {
        const pa = a?.p?.[i] || q
        const x = ox + lerp(pa[0], q[0], al); const y = oy + lerp(pa[1], q[1], al)
        const pl = players[i]; if (!pl) return
        g.fillStyle = TEAM[pl.t]
        g.beginPath(); g.arc(x, y, FB.PR, 0, 7); g.fill()
        g.lineWidth = q[2] ? 4 : 2.5; g.strokeStyle = q[2] ? '#fff' : 'rgba(0,0,0,.55)'; g.stroke()
        if (pl.k === me) { g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.arc(x, y, FB.PR + 5, 0, 7); g.stroke() }
        label(g, pl.name, x, y + FB.PR + 14)
      })
      const ba = a?.b || b.b
      const bx = ox + lerp(ba[0], b.b[0], al); const by = oy + lerp(ba[1], b.b[1], al)
      g.fillStyle = '#fff'; g.beginPath(); g.arc(bx, by, FB.BR, 0, 7); g.fill()
      g.lineWidth = 2; g.strokeStyle = '#111'; g.stroke()
      if (b.f >= 0) banner(g, this.view, 'GOL!', TEAM[b.f])
    },
    hud (s) { return `<b style="color:${TEAM[0]}">${s.sc[0]}</b><span>${fmtT(s.t)}</span><b style="color:${TEAM[1]}">${s.sc[1]}</b>` }
  }

  // =====================================================================
  // Arena (2D nişancı, herkes herkese karşı)
  // =====================================================================
  const AR = { W: 900, H: 520, PR: 14, BS: 15, BL: 38, HP: 100, DMG: 20, GOAL: 10 }
  const ROCKS = [[150, 110, 90, 26], [660, 110, 90, 26], [150, 384, 90, 26], [660, 384, 90, 26], [420, 200, 60, 120], [70, 230, 26, 60], [804, 230, 26, 60], [300, 250, 70, 22], [530, 250, 70, 22]]
  const SPAWNS = [[50, 50], [850, 470], [850, 50], [50, 470], [450, 40], [450, 480], [250, 330], [650, 190]]
  function pushOutRect (p, [rx, ry, rw, rh]) {
    const cx = clamp(p.x, rx, rx + rw); const cy = clamp(p.y, ry, ry + rh)
    const dx = p.x - cx; const dy = p.y - cy; const d2 = dx * dx + dy * dy
    if (d2 >= p.r * p.r) return
    if (d2 === 0) { p.y = ry - p.r; return }
    const d = Math.sqrt(d2)
    p.x = cx + dx / d * p.r; p.y = cy + dy / d * p.r
  }
  const inRect = (x, y, [rx, ry, rw, rh]) => x > rx && x < rx + rw && y > ry && y < ry + rh
  const Arena = {
    name: 'Arena', icon: 'target', max: 8, teams: false,
    desc: 'Yukarıdan bakışlı 2D nişancı, herkes herkese karşı. 10 vuruş yapan ya da 3 dakika sonunda önde olan kazanır.',
    help: 'Hareket: WASD · Nişan: fare · Ateş: sol tık ya da Boşluk',
    view: { w: AR.W, h: AR.H },
    create (players) {
      const s = { tick: 0, over: false, bullets: [], players: players.map((p, i) => ({ k: p.k, i, x: SPAWNS[i % 8][0], y: SPAWNS[i % 8][1], r: AR.PR, ang: 0, hp: AR.HP, dead: 0, cd: 0, kills: 0, deaths: 0 })) }
      return s
    },
    step (s, inputs) {
      if (s.over) return
      s.tick++
      for (const p of s.players) {
        const i = inputs.get(p.k) || {}
        if (p.dead) {
          if (--p.dead === 0) {
            const sp = SPAWNS.map(x => [x, Math.min(...s.players.filter(o => !o.dead && o !== p).map(o => Math.hypot(o.x - x[0], o.y - x[1])), 9999)]).sort((a, b) => b[1] - a[1])[0][0]
            p.x = sp[0]; p.y = sp[1]; p.hp = AR.HP
          }
          continue
        }
        let ax = (i.r ? 1 : 0) - (i.l ? 1 : 0); let ay = (i.d ? 1 : 0) - (i.u ? 1 : 0)
        if (ax && ay) { ax *= 0.7071; ay *= 0.7071 }
        p.x = clamp(p.x + ax * 4.6, p.r, AR.W - p.r); p.y = clamp(p.y + ay * 4.6, p.r, AR.H - p.r)
        for (const rk of ROCKS) pushOutRect(p, rk)
        if (Number.isFinite(i.ax) && Number.isFinite(i.ay)) p.ang = Math.atan2(i.ay - p.y, i.ax - p.x)
        if (p.cd > 0) p.cd--
        if ((i.a || i.f) && !p.cd) {
          p.cd = 7
          s.bullets.push({ o: p.k, x: p.x + Math.cos(p.ang) * (p.r + 4), y: p.y + Math.sin(p.ang) * (p.r + 4), vx: Math.cos(p.ang) * AR.BS, vy: Math.sin(p.ang) * AR.BS, life: AR.BL })
        }
      }
      for (const b of s.bullets) {
        // İki yarım adım: hızlı mermi ince engelin içinden geçmesin
        for (let k = 0; k < 2 && b.life > 0; k++) {
          b.x += b.vx / 2; b.y += b.vy / 2
          if (b.x < 0 || b.y < 0 || b.x > AR.W || b.y > AR.H || ROCKS.some(rk => inRect(b.x, b.y, rk))) { b.life = 0; break }
          for (const p of s.players) {
            if (p.dead || p.k === b.o) continue
            if ((p.x - b.x) ** 2 + (p.y - b.y) ** 2 < (p.r + 4) ** 2) {
              b.life = 0
              p.hp -= AR.DMG
              if (p.hp <= 0) {
                p.dead = 60; p.deaths++
                const killer = s.players.find(q => q.k === b.o)
                if (killer) { killer.kills++; if (killer.kills >= AR.GOAL) s.over = true }
              }
              break
            }
          }
        }
        b.life--
      }
      s.bullets = s.bullets.filter(b => b.life > 0)
      if (s.tick >= 30 * 180) s.over = true
    },
    snap (s) {
      return { t: Math.max(0, 180 - Math.floor(s.tick / 30)), p: s.players.map(p => [r1(p.x), r1(p.y), Math.round(p.ang * 100) / 100, p.hp, p.dead ? 1 : 0, p.kills, p.deaths]), b: s.bullets.flatMap(b => [Math.round(b.x), Math.round(b.y)]) }
    },
    result (s, players) {
      const best = Math.max(...s.players.map(p => p.kills))
      const top = s.players.filter(p => p.kills === best)
      if (best === 0) return { text: 'Kimse kimseyi vuramadı. Barış kazandı!', winners: [] }
      return { text: top.length > 1 ? `Berabere! ${best} vuruş` : `${nameOfKey(top[0].k)} kazandı! ${best} vuruş`, winners: top.length > 1 ? [] : [top[0].k] }
    },
    draw (g, a, b, al, ctx) {
      const { players, me } = ctx
      g.fillStyle = '#1a1c2c'; g.fillRect(0, 0, AR.W, AR.H)
      g.strokeStyle = 'rgba(255,255,255,.04)'; g.lineWidth = 1
      for (let x = 0; x < AR.W; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, AR.H); g.stroke() }
      for (let y = 0; y < AR.H; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(AR.W, y); g.stroke() }
      g.fillStyle = '#3a3f5c'
      for (const [x, y, w, h] of ROCKS) { g.fillRect(x, y, w, h) }
      g.fillStyle = '#ffd36b'
      for (let i = 0; i < b.b.length; i += 2) { g.beginPath(); g.arc(b.b[i], b.b[i + 1], 4, 0, 7); g.fill() }
      b.p.forEach((q, i) => {
        if (q[4]) return
        const pa = a?.p?.[i] || q
        const x = lerp(pa[0], q[0], al); const y = lerp(pa[1], q[1], al)
        const pl = players[i]; if (!pl) return
        const c = PCOL[i % 8]
        g.save(); g.translate(x, y); g.rotate(q[2])
        g.fillStyle = '#d9dbea'; g.fillRect(6, -4, 18, 8)
        g.restore()
        g.fillStyle = c; g.beginPath(); g.arc(x, y, AR.PR, 0, 7); g.fill()
        g.lineWidth = pl.k === me ? 3 : 2; g.strokeStyle = pl.k === me ? '#fff' : 'rgba(0,0,0,.5)'; g.stroke()
        g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(x - 16, y - 26, 32, 4)
        g.fillStyle = q[3] > 40 ? '#3ddc84' : '#ff5d5d'; g.fillRect(x - 16, y - 26, 32 * q[3] / AR.HP, 4)
        label(g, pl.name, x, y + AR.PR + 14)
      })
      const mi = players.findIndex(p => p.k === me)
      if (mi >= 0 && b.p[mi]?.[4]) banner(g, this.view, 'Vuruldun! Birazdan yeniden doğacaksın', '#ff5d5d', 22)
    },
    hud (s, players) {
      const order = s.p.map((q, i) => [i, q[5]]).sort((x, y) => y[1] - x[1]).slice(0, 4)
      return `<span>${fmtT(s.t)}</span>` + order.map(([i, k]) => `<b style="color:${PCOL[i % 8]}">${esc(players[i]?.name || '')} ${k}</b>`).join('')
    }
  }

  // =====================================================================
  // Yılan
  // =====================================================================
  const SN = { W: 36, H: 22, C: 24, EVERY: 4, LEN: 4, MAXLEN: 60, GOAL: 25 }
  const DIRS = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] }
  const Snake = {
    name: 'Yılan', icon: 'snake', max: 6, teams: false,
    desc: 'Çok oyunculu yılan. Yemleri topla, başkalarına çarpma. 25 puana ulaşan ya da 2 dakika sonunda önde olan kazanır.',
    help: 'Yön: WASD / ok tuşları',
    view: { w: SN.W * SN.C, h: SN.H * SN.C },
    interp: false,
    create (players) {
      const s = { tick: 0, over: false, food: [], snakes: players.map((p, i) => ({ k: p.k, i, body: [], dir: 'r', next: 'r', dead: 1, score: 0 })) }
      s.free = () => {
        const occ = new Set(); for (const z of s.snakes) for (const c of z.body) occ.add(c[0] + ',' + c[1]); for (const f of s.food) occ.add(f[0] + ',' + f[1])
        for (let n = 0; n < 200; n++) { const x = 5 + Math.floor(Math.random() * (SN.W - 10)); const y = 2 + Math.floor(Math.random() * (SN.H - 4)); if (!occ.has(x + ',' + y)) return [x, y] }
        return [1, 1]
      }
      return s
    },
    step (s, inputs) {
      if (s.over) return
      s.tick++
      for (const z of s.snakes) {
        const d = inputs.get(z.k)?.dir
        if (DIRS[d]) { const [a, b] = DIRS[d]; const [c, e] = DIRS[z.dir]; if (a !== -c || b !== -e) z.next = d }
      }
      if (s.tick % SN.EVERY) return
      while (s.food.length < s.snakes.length + 2) s.food.push(s.free())
      for (const z of s.snakes) {
        z.head = null
        if (z.dead) {
          if (--z.dead === 0) {
            const [x, y] = s.free(); const dir = x < SN.W / 2 ? 'r' : 'l'; const [dx] = DIRS[dir]
            z.body = Array.from({ length: SN.LEN }, (_, i) => [x - dx * i, y]); z.dir = z.next = dir
          }
          continue
        }
        z.dir = z.next
        const [dx, dy] = DIRS[z.dir]
        z.head = [z.body[0][0] + dx, z.body[0][1] + dy]
      }
      const alive = s.snakes.filter(z => z.head) // bu adımda yeniden doğanlar bir sonraki adımda hareket eder
      // Önce yeni baş konumları: yem yiyen uzar, yemeyenin kuyruğu ilerler
      for (const z of alive) {
        const fi = s.food.findIndex(f => f[0] === z.head[0] && f[1] === z.head[1])
        z.body.unshift(z.head)
        if (fi >= 0) { s.food.splice(fi, 1); z.score++; if (z.body.length > SN.MAXLEN) z.body.pop(); if (z.score >= SN.GOAL) s.over = true } else z.body.pop()
      }
      const occ = new Map()
      for (const z of alive) z.body.forEach((c, i) => { if (i) occ.set(c[0] + ',' + c[1], z) })
      for (const z of alive) {
        const [x, y] = z.head
        const hit = x < 0 || y < 0 || x >= SN.W || y >= SN.H || occ.has(x + ',' + y) || alive.some(o => o !== z && o.head[0] === x && o.head[1] === y)
        if (hit) z.crash = true
      }
      for (const z of alive) if (z.crash) { z.crash = false; z.dead = 6; z.body = []; z.score = Math.max(0, z.score - 2) }
      if (s.tick >= 30 * 120) s.over = true
    },
    snap (s) {
      return { t: Math.max(0, 120 - Math.floor(s.tick / 30)), s: s.snakes.map(z => [z.score, z.body.flat()]), f: s.food.flat() }
    },
    result (s) {
      const best = Math.max(...s.snakes.map(z => z.score))
      const top = s.snakes.filter(z => z.score === best)
      if (s.snakes.length > 1 && top.length > 1) return { text: `Berabere! ${best} puan`, winners: [] }
      return { text: `${nameOfKey(top[0].k)} kazandı! ${best} puan`, winners: [top[0].k] }
    },
    draw (g, a, b, al, ctx) {
      const { players, me } = ctx
      const C = SN.C
      g.fillStyle = '#14251c'; g.fillRect(0, 0, SN.W * C, SN.H * C)
      g.fillStyle = 'rgba(255,255,255,.03)'
      for (let x = 0; x < SN.W; x++) for (let y = (x % 2); y < SN.H; y += 2) g.fillRect(x * C, y * C, C, C)
      g.fillStyle = '#ff5d6c'
      for (let i = 0; i < b.f.length; i += 2) { g.beginPath(); g.arc(b.f[i] * C + C / 2, b.f[i + 1] * C + C / 2, C * 0.32, 0, 7); g.fill() }
      b.s.forEach(([, body], i) => {
        const c = PCOL[(i + 2) % 8]
        for (let j = body.length - 2; j >= 0; j -= 2) {
          g.fillStyle = j === 0 ? '#fff' : c
          g.globalAlpha = j === 0 ? 1 : 0.85
          g.fillRect(body[j] * C + 2, body[j + 1] * C + 2, C - 4, C - 4)
        }
        g.globalAlpha = 1
        if (body.length) {
          g.fillStyle = c; g.fillRect(body[0] * C + 5, body[1] * C + 5, C - 10, C - 10)
          const pl = players[i]
          if (pl) label(g, pl.k === me ? 'Sen' : pl.name, body[0] * C + C / 2, body[1] * C - 6)
        }
      })
      const mi = players.findIndex(p => p.k === me)
      if (mi >= 0 && b.s[mi] && !b.s[mi][1].length) banner(g, this.view, 'Çarptın! Birazdan yeniden başlıyorsun', '#ffc24b', 22)
    },
    hud (s, players) {
      return `<span>${fmtT(s.t)}</span>` + s.s.map(([sc], i) => [i, sc]).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([i, sc]) => `<b style="color:${PCOL[(i + 2) % 8]}">${esc(players[i]?.name || '')} ${sc}</b>`).join('')
    }
  }

  const KINDS = { football: Football, arena: Arena, snake: Snake }

  // ---------- Çizim yardımcıları ----------
  const fmtT = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
  const nameOfKey = (k) => nameOf(k)
  function label (g, text, x, y) {
    g.font = '600 12px system-ui, sans-serif'; g.textAlign = 'center'
    if (g._vw) { const h = g.measureText(text).width / 2 + 4; x = clamp(x, h, g._vw - h) } // kenardaki oyuncunun adı kesilmesin
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.6)'; g.strokeText(text, x, y)
    g.fillStyle = '#fff'; g.fillText(text, x, y)
  }
  function banner (g, v, text, color, size = 54) {
    g.font = `900 ${size}px system-ui, sans-serif`; g.textAlign = 'center'
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.55)'; g.strokeText(text, v.w / 2, v.h / 2 + size / 3)
    g.fillStyle = color; g.fillText(text, v.w / 2, v.h / 2 + size / 3)
  }

  // =====================================================================
  // Oyun oturumu (ev sahibi ya da oyuncu)
  // =====================================================================
  let cur = null

  class Session {
    constructor ({ id, kind, host, server }) {
      this.id = id
      this.kind = kind
      this.def = KINDS[kind]
      this.host = host
      this.server = server
      this.me = S.me
      this.isHost = host === S.me
      this.state = 'lobby'
      this.lobby = this.isHost ? [{ k: S.me, t: 0 }] : []
      this.players = [] // oyun başladığında sabitlenir
      this.inputs = new Map()
      this.seen = new Map() // oyuncu -> son paket zamanı
      this.snaps = [null, null]
      this.snapAt = 0
      this.input = {}
      this.lastHost = Date.now()
      this.result = null
      this._buildUI()
      this._keys = this._onKey.bind(this)
      window.addEventListener('keydown', this._keys, true)
      window.addEventListener('keyup', this._keys, true)
      this.pulse = setInterval(() => this._pulse(), 1000)
      api.setInVoice?.(true) // pencere arkadayken de oyun akmaya devam etsin
      if (this.isHost) this._announce()
      else this._send(this.host, { y: 'join' })
      this._renderLobby()
    }

    _send (to, d) { api.sendGame([to], { g: this.id, ...d }) }
    _sendAll (d) { const to = this.lobby.map(p => p.k).filter(k => k !== S.me); if (to.length) api.sendGame(to, { g: this.id, ...d }) }

    _announce (closed = false) {
      api.eph(this.server, 'game', closed ? { id: this.id, closed: true } : { id: this.id, kind: this.kind, n: this.lobby.length, max: this.def.max, st: this.state })
    }

    _pulse () {
      const now = Date.now()
      if (this.isHost) {
        // Sessizleşen oyuncuları çıkar
        let changed = false
        for (const p of [...this.lobby]) if (p.k !== S.me && now - (this.seen.get(p.k) || now) > 9000) { this.lobby = this.lobby.filter(x => x !== p); changed = true }
        if (changed) this._lobbyChanged()
        if (now - (this._annAt || 0) > 4000) { this._annAt = now; this._announce() }
        // Bekleme odasında oyunculara "buradayım" de (oyun sırasında anlık görüntüler bu işi görür)
        if (this.state !== 'play' && now - (this._lbAt || 0) > 2500) { this._lbAt = now; this._sendAll({ y: 'lobby', kind: this.kind, st: this.state, l: this.lobby }) }
      } else {
        this._send(this.host, { y: 'hb' })
        if (now - this.lastHost > 9000) { toast('Oyunun ev sahibine ulaşılamıyor; oyun kapandı.'); this.close(true) }
      }
    }

    _lobbyChanged () {
      this._sendAll({ y: 'lobby', kind: this.kind, st: this.state, l: this.lobby })
      this._announce()
      this._renderLobby()
    }

    // ---------- Gelen paketler ----------
    onPacket (from, d) {
      if (this.isHost) {
        const inLobby = this.lobby.find(p => p.k === from)
        if (d.y === 'join') {
          if (!inLobby) {
            if (this.state !== 'lobby' || this.lobby.length >= this.def.max) return this._send(from, { y: 'deny', why: this.state !== 'lobby' ? 'Oyun başlamış; bitince yeniden dene.' : 'Oyun dolu.' })
            const red = this.lobby.filter(p => p.t === 0).length; const blue = this.lobby.length - red
            this.lobby.push({ k: from, t: this.def.teams && red > blue ? 1 : 0 })
          }
          this.seen.set(from, Date.now())
          this._lobbyChanged()
          return
        }
        if (!inLobby) return
        this.seen.set(from, Date.now())
        if (d.y === 'in' && d.i && typeof d.i === 'object') this.inputs.set(from, cleanInput(d.i))
        else if (d.y === 'team' && this.def.teams && this.state === 'lobby') { inLobby.t = inLobby.t ? 0 : 1; this._lobbyChanged() } else if (d.y === 'leave') { this.lobby = this.lobby.filter(p => p.k !== from); this._lobbyChanged() }
        return
      }
      if (from !== this.host) return
      this.lastHost = Date.now()
      if (d.y === 'lobby' && Array.isArray(d.l)) {
        this.lobby = d.l.filter(p => p && typeof p.k === 'string').slice(0, 12).map(p => ({ k: p.k, t: p.t ? 1 : 0 }))
        if (!this.lobby.some(p => p.k === S.me)) { toast('Oyundan çıkarıldın.'); return this.close(true) }
        if (this.state === 'play' && d.st === 'lobby') this.state = 'lobby'
        this._renderLobby()
      } else if (d.y === 'deny') { toast(String(d.why || 'Oyuna katılınamadı.')); this.close(true) } else if (d.y === 'start' && Array.isArray(d.p)) {
        this._begin(d.p.filter(p => p && typeof p.k === 'string').slice(0, 12).map(p => ({ k: p.k, t: p.t ? 1 : 0 })))
      } else if (d.y === 's' && d.s && typeof d.s === 'object' && this.state === 'play') this._snap(d.s)
      else if (d.y === 'end' && d.r) this._end({ text: String(d.r.text || '').slice(0, 120), winners: Array.isArray(d.r.winners) ? d.r.winners.map(String) : [] })
      else if (d.y === 'close') { toast('Ev sahibi oyunu kapattı.'); this.close(true) }
    }

    // ---------- Oyun akışı ----------
    start () {
      if (!this.isHost || this.state !== 'lobby') return
      const players = this.lobby.map(p => ({ k: p.k, t: this.def.teams ? p.t : 0 }))
      this._sendAll({ y: 'start', p: players })
      this._begin(players)
      this.sim = this.def.create(players)
      this.inputs.clear()
      this.loop = setInterval(() => this._tick(), TICK)
      this._announce()
    }

    _begin (players) {
      this.players = players.map(p => ({ ...p, name: nameOfKey(p.k) }))
      this.state = 'play'
      this.snaps = [null, null]
      this.result = null
      this.input = {}
      this._renderLobby()
      this._startDraw()
    }

    _tick () {
      const s = this.sim
      this.inputs.set(S.me, this.input)
      this.def.step(s, this.inputs)
      const snap = this.def.snap(s)
      // Yılan yalnızca adım attığında değişir; aynı görüntüyü tekrar göndermeyelim
      const key = this.kind === 'snake' ? JSON.stringify(snap) : null
      if (!key || key !== this._lastSnap) {
        this._lastSnap = key
        this._sendAll({ y: 's', s: snap })
        this._snap(snap)
      }
      if (s.over) {
        clearInterval(this.loop); this.loop = null
        const r = this.def.result(s, this.players)
        this._sendAll({ y: 'end', r })
        this._end(r)
        this.state = 'lobby'
        this._lobbyChanged()
      }
    }

    _snap (s) {
      this.snaps = [this.snaps[1] || s, s]
      this.snapAt = performance.now()
      const hud = this.ui.querySelector('.gm-hud')
      try { const h = this.def.hud(s, this.players); if (hud._h !== h) { hud.innerHTML = h; hud._h = h } } catch {}
    }

    _end (r) {
      this.result = r
      this.state = 'lobby'
      bump('played')
      if (r.winners.includes(S.me)) bump('wins')
      this._stopDraw(true)
      this._renderLobby()
    }

    // ---------- Girdi ----------
    _onKey (e) {
      if (this.state !== 'play' || e.target.closest?.('input, textarea')) return
      const down = e.type === 'keydown'
      const k = e.code
      const map = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r', Space: 'a', KeyX: 'a', KeyK: 'a' }
      const f = map[k]
      if (!f) return
      e.preventDefault(); e.stopPropagation()
      const next = { ...this.input }
      if (this.kind === 'snake') { if (down && f !== 'a') next.dir = f } else next[f] = down ? 1 : 0
      this._setInput(next)
    }

    _setInput (next) {
      const same = JSON.stringify(next) === JSON.stringify(this.input)
      this.input = next
      if (same || this.isHost) return
      const now = performance.now()
      // Fare hareketi çok sık olabilir: nişan değişikliklerini en fazla saniyede 30 kez gönder
      if (now - (this._inAt || 0) < 30 && !this._inTimer) { this._inTimer = setTimeout(() => { this._inTimer = null; this._flushInput() }, 30); return }
      if (!this._inTimer) this._flushInput()
    }

    _flushInput () { this._inAt = performance.now(); this._send(this.host, { y: 'in', i: this.input }) }

    // ---------- Arayüz ----------
    _buildUI () {
      const v = this.def.view
      const root = document.createElement('div')
      root.id = 'game-root'
      root.innerHTML = `
        <div class="gm-box">
          <div class="gm-top">
            <span class="gm-title">${icon(this.def.icon, 20)} ${esc(this.def.name)}</span>
            <span class="gm-hud"></span>
            <button class="btn small danger-ghost" data-g="leave">${icon('logout', 15)} Çık</button>
          </div>
          <div class="gm-stage"><canvas width="${v.w}" height="${v.h}"></canvas><div class="gm-lobby"></div></div>
          <div class="gm-help muted small">${esc(this.def.help)}</div>
        </div>`
      document.body.appendChild(root)
      this.ui = root
      this.canvas = root.querySelector('canvas')
      // Keskin görüntü için piksel yoğunluğu (en fazla 2x; daha fazlası boşuna işlemci harcar)
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      this.canvas.width = v.w * dpr; this.canvas.height = v.h * dpr
      this.g = this.canvas.getContext('2d', { alpha: false })
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0)
      this.g._vw = v.w
      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-g]')
        if (!b) return
        const a = b.dataset.g
        if (a === 'leave') this.close()
        else if (a === 'start') this.start()
        else if (a === 'team') {
          if (this.isHost) { const me = this.lobby.find(p => p.k === S.me); me.t = me.t ? 0 : 1; this._lobbyChanged() } else this._send(this.host, { y: 'team' })
        }
      })
      // Fare ile nişan (yalnızca Arena)
      const aim = (e) => {
        if (this.kind !== 'arena' || this.state !== 'play') return
        const r = this.canvas.getBoundingClientRect()
        const next = { ...this.input, ax: Math.round((e.clientX - r.left) / r.width * v.w), ay: Math.round((e.clientY - r.top) / r.height * v.h) }
        if (e.type === 'mousedown') next.f = 1
        if (e.type === 'mouseup') next.f = 0
        this._setInput(next)
      }
      this.canvas.addEventListener('mousemove', aim)
      this.canvas.addEventListener('mousedown', aim)
      window.addEventListener('mouseup', this._mu = aim)
    }

    _renderLobby () {
      const box = this.ui.querySelector('.gm-lobby')
      box.hidden = this.state === 'play'
      if (this.state === 'play') return
      const p = (x) => `<li>${avatar(x.k, 26)}<span>${esc(nameOfKey(x.k))}</span>${x.k === this.host ? `<small>${icon('crown', 12)} Kurucu</small>` : ''}</li>`
      const teams = this.def.teams
        ? `<div class="gm-teams">${[0, 1].map(t => `<div class="gm-team" style="--tc:${TEAM[t]}"><h4>${t ? 'Mavi' : 'Kırmızı'}</h4><ul>${this.lobby.filter(x => x.t === t).map(p).join('') || '<li class="muted">Boş</li>'}</ul></div>`).join('')}</div>`
        : `<ul class="gm-list">${this.lobby.map(p).join('')}</ul>`
      box.innerHTML = `
        ${this.result ? `<div class="gm-result">${icon('trophy', 22)}<b>${esc(this.result.text)}</b>${this.result.winners.includes(S.me) ? '<span>Tebrikler! 🎉</span>' : ''}</div>` : ''}
        <div class="gm-desc">${esc(this.def.desc)}</div>
        ${teams}
        <div class="gm-actions">
          ${teams ? `<button class="btn small" data-g="team">${icon('users', 15)} Takım değiştir</button>` : ''}
          ${this.isHost ? `<button class="btn primary" data-g="start">${icon('play', 16)} ${this.result ? 'Yeniden başlat' : 'Başlat'}</button>` : '<span class="muted">Kurucunun oyunu başlatması bekleniyor…</span>'}
        </div>
        <div class="muted small">${this.lobby.length}/${this.def.max} oyuncu · Sunucudaki herkes Oyunlar menüsünden katılabilir</div>`
      if (this.state !== 'play' && !this.drawing && this.snaps[1]) this._drawOnce()
    }

    _startDraw () {
      if (this.drawing) return
      this.drawing = true
      const frame = () => {
        if (!this.drawing) return
        this._drawOnce()
        this.raf = requestAnimationFrame(frame)
      }
      this.raf = requestAnimationFrame(frame)
    }

    _stopDraw () { this.drawing = false; cancelAnimationFrame(this.raf) }

    _drawOnce () {
      const [a, b] = this.snaps
      const g = this.g
      if (!b) { g.fillStyle = '#111320'; g.fillRect(0, 0, this.def.view.w, this.def.view.h); return }
      const al = this.def.interp === false ? 1 : clamp((performance.now() - this.snapAt) / TICK, 0, 1)
      try { this.def.draw(g, a, b, al, { players: this.players, me: S.me }) } catch (e) { console.warn('game draw', e) }
    }

    close (silent = false) {
      if (this.closed) return
      this.closed = true
      clearInterval(this.pulse); clearInterval(this.loop); clearTimeout(this._inTimer)
      this._stopDraw()
      window.removeEventListener('keydown', this._keys, true)
      window.removeEventListener('keyup', this._keys, true)
      window.removeEventListener('mouseup', this._mu)
      if (this.isHost) { this._sendAll({ y: 'close' }); this._announce(true) } else if (!silent) this._send(this.host, { y: 'leave' })
      this.ui.remove()
      api.setInVoice?.(!!voice?.active)
      if (cur === this) cur = null
      window.onGameClosed?.(this.id)
    }
  }

  function cleanInput (i) {
    const o = {}
    for (const k of ['u', 'd', 'l', 'r', 'a', 'f']) if (i[k]) o[k] = 1
    if (DIRS[i.dir]) o.dir = i.dir
    if (Number.isFinite(i.ax) && Number.isFinite(i.ay)) { o.ax = clamp(i.ax, -100, 1100); o.ay = clamp(i.ay, -100, 700) }
    return o
  }

  window.YankiGames = {
    KINDS,
    get current () { return cur },
    host (kind, server) {
      if (!KINDS[kind]) return
      cur?.close()
      const id = Math.random().toString(36).slice(2, 10)
      cur = new Session({ id, kind, host: S.me, server })
      return cur
    },
    join (lobby) {
      if (cur?.id === lobby.id) return cur
      cur?.close()
      cur = new Session({ id: lobby.id, kind: lobby.kind, host: lobby.host, server: lobby.server })
      return cur
    },
    onPacket (from, d) { if (cur && d && d.g === cur.id) cur.onPacket(from, d) }
  }
})()
