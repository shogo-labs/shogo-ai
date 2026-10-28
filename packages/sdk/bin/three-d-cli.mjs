// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo 3d` — generate and post-process 3D models through the Shogo AI proxy.
 *
 * Shared by bin/shogo.ts (monorepo, Bun) and bin/cli.mjs (published wrapper,
 * Node) so both entries behave identically. Plain ESM with global fetch: the
 * CLI never talks to the vendor and never reads TRIPO_API_KEY — the proxy owns
 * the key and the billing.
 */

import * as nodeFs from 'node:fs'
import * as path from 'node:path'

export const THREE_D_COMMANDS = ['generate', 'edit', 'status', 'upload', 'models']

/** Ops the proxy accepts for post-processing, and the export formats it can produce. */
const EDIT_OPS = ['texture', 'convert', 'retopology', 'segment', 'complete', 'rig-check', 'rig', 'retarget', 'import']
const CONVERT_FORMATS = ['GLTF', 'FBX', 'USDZ', 'OBJ', 'STL', '3MF']
const EXT_BY_FORMAT = { GLTF: '.glb', FBX: '.fbx', USDZ: '.usdz', OBJ: '.obj', STL: '.stl', '3MF': '.3mf' }

const MISSING_ENV =
  '3D generation needs the Shogo runtime (AI_PROXY_URL / AI_PROXY_TOKEN are unset). ' +
  'Run this inside a Shogo project, or use the 3D tools from the agent.'

export function threeDHelp() {
  return `
shogo 3d — 3D models through the Shogo AI proxy (billed per task)

Usage:
  shogo 3d generate --prompt "..." [--model tripo-v3.1] [--texture|--no-texture]
                    [--texture-quality standard|detailed|extreme] [--face-limit N]
                    [--out models/chest.glb] [--wait] [--json]
  shogo 3d generate --image refs/chair.png [same options]
  shogo 3d generate --images front.png,left.png,back.png,right.png [same options]

  shogo 3d edit --op <op> --input <job id | path | https url> [options]
       ops: ${EDIT_OPS.join(', ')}
       --format GLTF|FBX|USDZ|OBJ|STL|3MF   convert
       --texture-prompt "..."  --style-image <path>  --texture-quality <tier>
       --face-limit N                       retopology
       --part-names a,b                     complete (from segment)
       --rig-type biped                     rig
       --animation preset:walk | --animations preset:walk,preset:run   retarget
       --out <path> [--wait] [--json]

  shogo 3d status <job id> [--out <path>] [--json]
  shogo 3d upload <path> [--json]
  shogo 3d models [--json]

Environment:
  AI_PROXY_URL    Proxy base URL (a trailing /v1 is ignored)
  AI_PROXY_TOKEN  Project-scoped proxy token
`
}

const stripV1 = (url) => url.replace(/\/v1\/?$/, '')

function splitList(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.split(',').map((v) => v.trim()).filter(Boolean)
}

function basename(p) {
  return String(p).split(/[\\/]/).pop() || 'model'
}

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 4)
      .join('-') || 'model'
  )
}

/** A value the proxy forwards as-is; anything else is a local file to upload. */
function forwardsAsInput(value) {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    /^file_[A-Za-z0-9]+$/.test(value) ||
    /^gen3d_/.test(value) ||
    /^https:\/\/\S+$/i.test(value)
  )
}

class ThreeDError extends Error {}

export async function runThreeDCommand(args, flags, deps = {}) {
  const env = deps.env || process.env
  const cwd = deps.cwd || process.cwd()
  const fetchImpl = deps.fetch || globalThis.fetch
  const out = deps.stdout || ((s) => process.stdout.write(s))
  const err = deps.stderr || ((s) => process.stderr.write(s))
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const pollIntervalMs = deps.pollIntervalMs ?? (Number(env.SHOGO_3D_POLL_MS) || 2500)
  const json = flags.json === true
  const fs = deps.fs || nodeFs

  const sub = args[0]
  if (!sub || sub === 'help' || flags.help === true) {
    out(threeDHelp())
    return sub ? 0 : 1
  }
  if (!THREE_D_COMMANDS.includes(sub)) {
    err(`Unknown 3d subcommand: ${sub}\n`)
    err(threeDHelp())
    return 1
  }

  const proxyUrl = env.AI_PROXY_URL
  const token = env.AI_PROXY_TOKEN
  if (!proxyUrl || !token) {
    err(`${MISSING_ENV}\n`)
    return 2
  }
  const base = stripV1(proxyUrl)
  const headers = { Authorization: `Bearer ${token}` }

  const request = async (path, init = {}) => {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
    })
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { error: { message: text } }
    }
    if (!response.ok) {
      const message =
        body?.error?.message || (typeof body?.error === 'string' ? body.error : undefined) || `HTTP ${response.status}`
      throw new ThreeDError(message)
    }
    return body
  }

  const upload = async (filePath) => {
    const absolute = path.resolve(cwd, filePath)
    if (!fs.existsSync(absolute)) throw new ThreeDError(`File not found: ${filePath}`)
    const bytes = fs.readFileSync(absolute)
    if (bytes.length > 25 * 1024 * 1024) {
      throw new ThreeDError(`${filePath} is larger than the 25MB upload limit.`)
    }
    const body = await request('/v1/3d/files', {
      method: 'POST',
      body: JSON.stringify({
        filename: basename(absolute),
        contentType: 'application/octet-stream',
        data_base64: bytes.toString('base64'),
      }),
    })
    if (!body?.file_token) throw new ThreeDError('Upload succeeded but returned no file token.')
    return body.file_token
  }

  const defaultOut = (op, id, ext) => path.resolve(cwd, 'models', `${op}-${id.replace(/^gen3d_/, '')}${ext}`)

  const download = async (url, target) => {
    const response = await fetchImpl(url)
    if (!response.ok) throw new ThreeDError(`Model download failed (HTTP ${response.status}).`)
    const buffer = Buffer.from(await response.arrayBuffer())
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, buffer)
    return buffer.length
  }

  const poll = async (id, outPath, preferredExt = '.glb') => {
    let lastProgress = -1
    for (;;) {
      const status = await request(`/v1/3d/${encodeURIComponent(id)}`)
      if (status.status === 'success') {
        let bytes
        let saved
        if (status.model_url) {
          const ext = outPath ? path.extname(outPath) || preferredExt : preferredExt
          saved = outPath ? path.resolve(cwd, outPath) : defaultOut(status.op || 'model', id, ext)
          bytes = await download(status.model_url, saved)
        }
        return { ...status, path: saved ? path.relative(cwd, saved) : undefined, bytes }
      }
      if (status.status === 'failed') return status
      if (!json && typeof status.progress === 'number' && status.progress !== lastProgress) {
        lastProgress = status.progress
        err(`\r  ${status.status} ${status.progress}%`)
      }
      await sleep(pollIntervalMs)
    }
  }

  const report = (result) => {
    if (json) {
      out(JSON.stringify(result, null, 2) + '\n')
      return
    }
    if (result.path) out(`Saved ${result.path}${result.bytes ? ` (${result.bytes} bytes)` : ''}\n`)
    if (result.parts?.length) out(`Parts: ${result.parts.join(', ')}\n`)
    if (result.riggable !== undefined) out(`Riggable: ${result.riggable ? 'yes' : 'no'}\n`)
    if (result.credits_consumed !== undefined) {
      const billed = result.billed_usd !== undefined ? ` — billed $${Number(result.billed_usd).toFixed(2)}` : ''
      out(`${result.credits_consumed} credits${billed}\n`)
    }
  }

  try {
    if (sub === 'models') {
      const body = await request('/v1/3d/models')
      if (json) {
        out(JSON.stringify(body, null, 2) + '\n')
        return 0
      }
      // The route returns `price.usd` per model and `estimated_credits` per
      // operation; 1 credit = $0.01.
      const models = body.models ?? []
      const operations = body.operations ?? []
      if (!models.length) {
        out('No 3D models available: this server has no Tripo key, so nothing can run.\n')
        return 0
      }
      out('Models:\n')
      for (const model of models) {
        const usd = model.price?.usd
        const bare = model.price?.untextured_usd
        const price = usd === undefined ? '' : `$${Number(usd).toFixed(2)}`
        const bareLabel = bare === undefined ? '' : ` (untextured $${Number(bare).toFixed(2)})`
        out(`  ${String(model.id).padEnd(26)} ${price}${bareLabel}${model.name ? `  ${model.name}` : ''}\n`)
      }
      if (operations.length) {
        out('\nOperations:\n')
        for (const operation of operations) {
          const credits = operation.estimated_credits
          const price =
            credits === 0 ? 'free' : credits === undefined ? 'unknown' : `${credits} credits`
          out(`  ${String(operation.op).padEnd(18)} ${price}\n`)
        }
      }
      return 0
    }

    if (sub === 'upload') {
      const filePath = args[1]
      if (!filePath) {
        err('Usage: shogo 3d upload <path>\n')
        return 1
      }
      const fileToken = await upload(filePath)
      out(json ? JSON.stringify({ file_token: fileToken }, null, 2) + '\n' : `${fileToken}\n`)
      return 0
    }

    if (sub === 'status') {
      const id = args[1]
      if (!id) {
        err('Usage: shogo 3d status <job id>\n')
        return 1
      }
      const result = await poll(id, flags.out)
      report(result)
      return result.status === 'success' ? 0 : 1
    }

    let body
    if (sub === 'generate') {
      const imageList = splitList(flags.images)
      const hasPrompt = typeof flags.prompt === 'string' && flags.prompt.trim().length > 0
      const hasImage = typeof flags.image === 'string' && flags.image.length > 0
      const given = [hasPrompt, hasImage, Boolean(imageList?.length)].filter(Boolean).length
      if (given === 0) {
        err('Pass --prompt, --image or --images (4 views).\n')
        return 1
      }
      if (given > 1) {
        err('Pass only one of --prompt, --image or --images.\n')
        return 1
      }
      if (imageList && imageList.length !== 4) {
        err(`--images needs exactly 4 paths in the order front, left, back, right; got ${imageList.length}.\n`)
        return 1
      }
      body = { op: imageList ? 'multiview_to_model' : hasImage ? 'image_to_model' : 'text_to_model' }
      if (hasPrompt) body.prompt = flags.prompt
      if (hasImage) body.image = await upload(flags.image)
      if (imageList) body.images = []
      if (imageList) {
        for (const view of imageList) {
          body.images.push(/^https:\/\//i.test(view) ? view : await upload(view))
        }
      }
      if (flags.model) body.model = flags.model
      if (flags.texture === true) body.texture = true
      if (flags['no-texture'] === true) body.texture = false
      if (flags['texture-quality']) body.texture_quality = flags['texture-quality']
      if (flags['face-limit'] !== undefined) body.face_limit = Number(flags['face-limit'])
    } else {
      const op = typeof flags.op === 'string' ? flags.op : ''
      if (!op) {
        err(`--op is required. One of: ${EDIT_OPS.join(', ')}\n`)
        return 1
      }
      if (!EDIT_OPS.includes(op)) {
        err(`Unknown op "${op}". One of: ${EDIT_OPS.join(', ')}\n`)
        return 1
      }
      const input = typeof flags.input === 'string' ? flags.input : ''
      if (!input) {
        err('--input is required: a job id, a workspace model path, or an https URL.\n')
        return 1
      }
      body = { op: op.replace(/-/g, '_') }
      if (op === 'convert') {
        const format = String(flags.format || '').toUpperCase()
        if (!EXT_BY_FORMAT[format]) {
          err(`convert needs --format ${CONVERT_FORMATS.join('|')}.\n`)
          return 1
        }
        body.format = format
      }
      if (op === 'texture') {
        if (flags['style-image']) {
          const styleImage = /^https:\/\//i.test(flags['style-image'])
            ? flags['style-image']
            : await upload(flags['style-image'])
          body.texture_prompt = {
            ...(flags['texture-prompt'] ? { text: flags['texture-prompt'] } : {}),
            style_image: styleImage,
          }
        } else if (flags['texture-prompt']) {
          body.texture_prompt = { text: flags['texture-prompt'] }
        }
        if (flags['texture-quality']) body.texture_quality = flags['texture-quality']
      }
      if (op === 'retopology' && flags['face-limit'] !== undefined) body.face_limit = Number(flags['face-limit'])
      const partNames = splitList(flags['part-names'])
      if (partNames) body.part_names = partNames
      if (op === 'complete' && !partNames) {
        err('complete needs --part-names (the parts reported by segment).\n')
        return 1
      }
      if (op === 'rig') body.rig_type = flags['rig-type'] || 'biped'
      if (op === 'retarget') {
        const animations = splitList(flags.animations)
        if (flags.animation && animations) {
          err('Pass either --animation or --animations, not both.\n')
          return 1
        }
        if (!flags.animation && !animations) {
          err('retarget needs --animation or --animations.\n')
          return 1
        }
        if (animations && animations.length > 5) {
          err(`--animations takes at most 5 presets; got ${animations.length}.\n`)
          return 1
        }
        if (flags.animation) body.animation = flags.animation
        if (animations) body.animations = animations
      }
      body.input = forwardsAsInput(input) ? input : await upload(input)
    }

    const submitted = await request('/v1/3d/generations', { method: 'POST', body: JSON.stringify(body) })
    if (!json && submitted?.estimated_usd !== undefined) {
      err(`  ~$${Number(submitted.estimated_usd).toFixed(2)} estimated\n`)
    }

    const result = await poll(submitted.id, flags.out, sub === 'edit' ? EXT_BY_FORMAT[body.format] || '.glb' : '.glb')
    if (json) out(JSON.stringify({ ...result, id: submitted.id }, null, 2) + '\n')
    else report(result)
    if (result.status !== 'success') {
      if (!json) err(`${result.error || 'Task failed'}\n`)
      return 1
    }
    return 0
  } catch (error) {
    err(`${error instanceof ThreeDError ? error.message : `3D request failed: ${error?.message || error}`}\n`)
    return 1
  }
}
