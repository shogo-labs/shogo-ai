#!/usr/bin/env node
// Injects analytics scripts (GA4, FB Pixel, Rewardful) and web shell
// attributes into the exported index.html. Runs as a post-export build step
// because Expo's "single" output mode strips some +html.tsx customizations.
//
// Deployed studio images are promoted unchanged from staging to production,
// so CI does not pass GA4/FB IDs here. Instead this leaves RUNTIME_ENV_MARKER
// at the top of <head>, and the nginx entrypoint
// (apps/mobile/docker/shogo-runtime-env.sh) replaces it with the
// per-environment config and analytics tags at container start.

const fs = require('fs')
const path = require('path')

const {
  LANDSCAPE_OVERLAY_HTML,
  LANDSCAPE_OVERLAY_ID,
  PHONE_GUARD_STYLE_ID,
  PHONE_VIEWPORT_GUARD_CSS,
  VIEWPORT_META_CONTENT,
  ZOOM_GUARD_ATTRIBUTE,
  ZOOM_GUARD_SCRIPT,
} = require('./web-shell-guards')

const HTML_PATH = path.resolve(__dirname, '..', 'dist', 'index.html')
const GA4_ID = process.env.EXPO_PUBLIC_GA4_ID || ''
const FB_PIXEL_ID = process.env.EXPO_PUBLIC_FB_PIXEL_ID || ''
const RUNTIME_ENV_MARKER = '<!--shogo-runtime-env-->'
const GOOGLE_NOTRANSLATE_META = '<meta name="google" content="notranslate">'
const THEME_BOOTSTRAP_SCRIPT = `<script data-shogo-theme-bootstrap>(function(){try{var preference=window.localStorage.getItem('theme-preference');var isDark=preference==='dark'||(preference!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(isDark)document.documentElement.classList.add('dark')}catch(e){}})();</script>`

let snippets = ''

// Rewardful affiliate tracking (always included)
snippets += `<script>(function(w,r){w._rwq=r;w[r]=w[r]||function(){(w[r].q=w[r].q||[]).push(arguments)}})(window,'rewardful');</script>`
snippets += `<script async src="https://r.wdfl.co/rw.js" data-rewardful="039716"></script>`

// Google Analytics 4
if (GA4_ID) {
  snippets += `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA4_ID}"></script>`
  snippets += `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA4_ID}');</script>`
  console.log(`[inject-analytics] GA4 ${GA4_ID} injected`)
}

// Facebook Pixel
if (FB_PIXEL_ID) {
  snippets += `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${FB_PIXEL_ID}');fbq('track','PageView');</script>`
  snippets += `<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${FB_PIXEL_ID}&ev=PageView&noscript=1"/></noscript>`
  console.log(`[inject-analytics] FB Pixel ${FB_PIXEL_ID} injected`)
}

let html = fs.readFileSync(HTML_PATH, 'utf8')

if (!html.includes('data-shogo-theme-bootstrap')) {
  snippets = THEME_BOOTSTRAP_SCRIPT + snippets
}

// Pinch-zoom / auto-zoom guard (SHO-405), from scripts/web-shell-guards.js.
// First in <head> so it runs before the app boots.
if (!html.includes(ZOOM_GUARD_ATTRIBUTE)) {
  snippets = `<script ${ZOOM_GUARD_ATTRIBUTE}>${ZOOM_GUARD_SCRIPT}</script>` + snippets
}

html = html.replace(/<html([^>]*)>/, (_tag, attrs) => {
  let nextAttrs = attrs
  if (!/\btranslate=/.test(nextAttrs)) nextAttrs += ' translate="no"'
  if (/\bclass=/.test(nextAttrs)) {
    nextAttrs = nextAttrs.replace(/class="([^"]*)"/, (_match, classes) => {
      const nextClasses = new Set(classes.split(/\s+/).filter(Boolean))
      nextClasses.add('notranslate')
      return `class="${Array.from(nextClasses).join(' ')}"`
    })
  } else {
    nextAttrs += ' class="notranslate"'
  }
  return `<html${nextAttrs}>`
})

if (!html.includes(RUNTIME_ENV_MARKER)) {
  html = html.replace(/<head([^>]*)>/, (tag) => tag + RUNTIME_ENV_MARKER)
}

if (!html.includes('name="google" content="notranslate"')) {
  html = html.replace('</head>', `${GOOGLE_NOTRANSLATE_META}</head>`)
}

// --- Phone viewport guard (SHO-405) ---------------------------------------
// `web.output: "single"` makes the web export ignore `app/+html.tsx` entirely:
// the shipped shell is Expo's default template, with a permissive viewport, no
// manifest link and none of the guard's markup or CSS (the branch's test runs
// this step against a captured export). Put all of it back.
if (!html.includes(VIEWPORT_META_CONTENT)) {
  const viewportMeta = `<meta name="viewport" content="${VIEWPORT_META_CONTENT}" />`
  html = html.replace(/<meta[^>]+name="viewport"[^>]*>/i, viewportMeta)
  if (!html.includes(VIEWPORT_META_CONTENT)) {
    html = html.replace('</head>', `${viewportMeta}</head>`)
  }
}

if (!html.includes('rel="manifest"')) {
  html = html.replace('</head>', '<link rel="manifest" href="/manifest.json" /></head>')
}

if (!html.includes(PHONE_GUARD_STYLE_ID)) {
  html = html.replace('</head>', `<style id="${PHONE_GUARD_STYLE_ID}">${PHONE_VIEWPORT_GUARD_CSS}</style></head>`)
}

if (!html.includes(`id="${LANDSCAPE_OVERLAY_ID}"`)) {
  html = html.replace(/<body([^>]*)>/, (tag) => `${tag}${LANDSCAPE_OVERLAY_HTML}`)
}

if (snippets) {
  html = html.replace('</head>', snippets + '</head>')
} else {
  console.log('[inject-analytics] No analytics configured, only injected shell guards')
}

fs.writeFileSync(HTML_PATH, html)
console.log(`[inject-analytics] Done — wrote ${HTML_PATH}`)
