'use strict'
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron')
const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a)
const snd = (ch, ...a) => ipcRenderer.send(ch, ...a)

contextBridge.exposeInMainWorld('yanki', {
  init: () => inv('p2p:init'),
  createServer: (name, icon) => inv('p2p:createServer', name, icon),
  joinServer: (code) => inv('p2p:join', code),
  leaveServer: (id) => inv('p2p:leave', id),
  post: (s, type, data) => inv('p2p:post', s, type, data),
  meta: (s) => inv('p2p:meta', s),
  messages: (s, c, o) => inv('p2p:messages', s, c, o),
  music: (s, c) => inv('p2p:music', s, c),
  setProfile: (p) => inv('p2p:setProfile', p),
  eph: (s, k, d) => snd('p2p:eph', s, k, d),
  signal: (to, d) => snd('p2p:signal', to, d),
  wantPeer: (key, reason, on) => snd('p2p:wantPeer', key, reason, on),

  dmList: () => inv('dm:list'),
  dmMessages: (key, o) => inv('dm:messages', key, o),
  dmPost: (key, type, data) => inv('dm:post', key, type, data),
  canDM: (key) => inv('dm:canDM', key),
  dmTyping: (key) => snd('dm:typing', key),
  friendRequest: (key) => inv('friend:request', key),
  friendAccept: (key) => inv('friend:accept', key),
  friendRemove: (key) => inv('friend:remove', key),
  friendStatus: (key) => inv('friend:status', key),
  block: (key) => inv('friend:block', key),
  unblock: (key) => inv('friend:unblock', key),
  blockedList: () => inv('friend:blocked'),

  activityConfig: (cfg) => inv('activity:config', cfg),
  activityCurrent: () => inv('activity:current'),
  activities: () => inv('activity:all'),
  canCreateServer: () => inv('p2p:canCreate'),
  netStats: () => inv('net:stats'),
  setStatus: (s) => inv('status:set', s),
  getStatus: () => inv('status:get'),
  setZoom: (z) => { const n = Number(z); if (n >= 0.5 && n <= 2) webFrame.setZoomFactor(n) },
  setInVoice: (on) => snd('app:inVoice', on),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f) || '' } catch { return '' } },
  shareFile: (p, ctx) => inv('file:share', p, ctx),
  hasFile: (h) => inv('file:has', h),
  fileCtx: (h, ctx) => inv('file:ctx', h, ctx),
  downloadFile: (file, ctx, author) => inv('file:download', file, ctx, author),
  cancelDownload: (id) => inv('file:cancel', id),
  showFile: (p) => snd('file:show', p),
  sendAudio: (to, pkt) => snd('voice:audio', to, pkt),
  sendGame: (to, d) => snd('game:send', to, d),
  createInvite: (s, o) => inv('invite:create', s, o),
  invites: (s) => inv('invite:list', s),
  revokeInvite: (s, id) => inv('invite:revoke', s, id),
  setCloseToTray: (on) => snd('app:closeToTray', on),
  updateCheck: () => inv('update:check'),
  updateDownload: () => inv('update:download'),
  updateInstall: () => inv('update:install'),
  updatePage: () => inv('update:page'),
  updateInfo: () => inv('update:info'),

  on: (cb) => {
    const h = (_e, ev) => cb(ev)
    ipcRenderer.on('p2p:event', h)
    return () => ipcRenderer.removeListener('p2p:event', h)
  },
  desktopSources: () => inv('desktop:sources'),
  prepareScreen: (sourceId, audio) => inv('screen:prepare', sourceId, audio),
  mediaAccess: (kind) => inv('media:access', kind),
  linkPreview: (url) => inv('link:preview', url),
  ytMeta: (id) => inv('yt:meta', id),
  saveThemeImage: (dataUrl) => inv('theme:saveImage', dataUrl),
  loadThemeImage: () => inv('theme:loadImage'),
  notify: (title, body) => snd('app:notify', title, body),
  badge: (n) => snd('app:badge', n),
  openExternal: (url) => snd('app:open', url),
  platform: process.platform
})
