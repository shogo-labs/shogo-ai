#!/usr/bin/env node
// Injects analytics scripts (GA4, FB Pixel, Rewardful) into the exported
// index.html. Runs as a post-export build step because Expo's "single" output
// mode strips <script> tags from +html.tsx during export.

const fs = require('fs')
const path = require('path')

const HTML_PATH = path.resolve(__dirname, '..', 'dist', 'index.html')
const GA4_ID = process.env.EXPO_PUBLIC_GA4_ID || ''
const FB_PIXEL_ID = process.env.EXPO_PUBLIC_FB_PIXEL_ID || ''

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

if (!snippets) {
  console.log('[inject-analytics] No analytics configured, skipping')
  process.exit(0)
}

let html = fs.readFileSync(HTML_PATH, 'utf8')
html = html.replace('</head>', snippets + '</head>')
fs.writeFileSync(HTML_PATH, html)
console.log(`[inject-analytics] Done — wrote ${HTML_PATH}`)
