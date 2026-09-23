#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const HTML_PATH = path.resolve(__dirname, '..', 'dist', 'index.html')
const THEME_BOOTSTRAP_SCRIPT = `<script data-shogo-theme-bootstrap>(function(){try{var preference=window.localStorage.getItem('theme-preference');var isDark=preference==='dark'||(preference!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(isDark)document.documentElement.classList.add('dark')}catch(e){}})();</script>`

let html = fs.readFileSync(HTML_PATH, 'utf8')

if (!html.includes('data-shogo-theme-bootstrap')) {
  html = html.replace('</head>', `${THEME_BOOTSTRAP_SCRIPT}</head>`)
  fs.writeFileSync(HTML_PATH, html)
}

console.log(`[inject-theme-bootstrap] Done — wrote ${HTML_PATH}`)
