import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const manifestPath = new URL('../docs/slack/manifest.yml', import.meta.url)
const manifest = parse(readFileSync(manifestPath, 'utf8'))

process.stdout.write(JSON.stringify(manifest))
