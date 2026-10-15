'use strict'
const { contextBridge, ipcRenderer } = require('electron')
const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a)

contextBridge.exposeInMainWorld('yanki', {
  init: () => inv('p2p:init'),
  createServer: (name, icon) => inv('p2p:createServer', name, icon),
  joinServer: (code) => inv('p2p:join', code),
  leaveServer: (id) => inv('p2p:leave', id),
  post: (s, type, data) => inv('p2p:post', s, type, data),
  meta: (s) => inv('p2p:meta', s),
  messages: (s, c, o) => inv('p2p:messages', s, c, o),
  setProfile: (p) => inv('p2p:setProfile', p),
  eph: (s, k, d) => ipcRenderer.send('p2p:eph', s, k, d),
  signal: (to, d) => ipcRenderer.send('p2p:signal', to, d),
  on: (cb) => {
    const h = (_e, ev) => cb(ev)
    ipcRenderer.on('p2p:event', h)
    return () => ipcRenderer.removeListener('p2p:event', h)
  },
  desktopSources: () => inv('desktop:sources'),
  mediaAccess: (kind) => inv('media:access', kind),
  linkPreview: (url) => inv('link:preview', url),
  notify: (title, body) => ipcRenderer.send('app:notify', title, body),
  badge: (n) => ipcRenderer.send('app:badge', n),
  openExternal: (url) => ipcRenderer.send('app:open', url),
  platform: process.platform
})
