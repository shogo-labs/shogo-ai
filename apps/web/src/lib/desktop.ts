/**
 * Desktop (Electron) detection helpers.
 *
 * `window.shogoDesktop` is injected by the Electron preload script.
 * These utilities let the web app branch behaviour when running
 * inside the desktop shell vs. a normal browser.
 */

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.shogoDesktop != null
}

export function getDesktopAPI(): ShogoDesktopAPI {
  if (!window.shogoDesktop) {
    throw new Error('getDesktopAPI() called outside of Electron context')
  }
  return window.shogoDesktop
}
