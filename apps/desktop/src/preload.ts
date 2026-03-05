import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('shogoDesktop', {
  platform: process.platform,
  isDesktop: true,
})
