// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Shiki highlighter behind the chat code previews, built from the
 * languages `file-lang-map.ts` can actually ask for.
 *
 * Why not `import("shiki")`: its full bundle lists all 235 TextMate grammars as
 * dynamic imports, and the grammars that other grammars embed (typescript for
 * tsx/jsx, cpp for cpp-macro, css/html for vue/svelte) are then reachable from
 * two chunks — so Metro parks them in `__common`, the one chunk every cold
 * start parses. That was 2.6 MB of eager JavaScript for highlighting nobody had
 * asked for yet.
 *
 * Here every grammar is a static import of this one module, so the whole set
 * lives in this module's async chunk and nothing is shared with `__common`. The
 * language list is exactly `EXT_TO_LANG` in `components/chat/turns/file-lang-map.ts`
 * — the only ids the previews ever pass — so no file loses highlighting.
 */
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import githubDarkDefault from 'shiki/dist/themes/github-dark-default.mjs'
import githubLightHighContrast from 'shiki/dist/themes/github-light-high-contrast.mjs'

import astro from 'shiki/dist/langs/astro.mjs'
import bash from 'shiki/dist/langs/bash.mjs'
import c from 'shiki/dist/langs/c.mjs'
import clojure from 'shiki/dist/langs/clojure.mjs'
import cpp from 'shiki/dist/langs/cpp.mjs'
import csharp from 'shiki/dist/langs/csharp.mjs'
import css from 'shiki/dist/langs/css.mjs'
import dart from 'shiki/dist/langs/dart.mjs'
import dockerfile from 'shiki/dist/langs/dockerfile.mjs'
import dotenv from 'shiki/dist/langs/dotenv.mjs'
import elixir from 'shiki/dist/langs/elixir.mjs'
import erlang from 'shiki/dist/langs/erlang.mjs'
import fish from 'shiki/dist/langs/fish.mjs'
import go from 'shiki/dist/langs/go.mjs'
import graphql from 'shiki/dist/langs/graphql.mjs'
import haskell from 'shiki/dist/langs/haskell.mjs'
import hcl from 'shiki/dist/langs/hcl.mjs'
import html from 'shiki/dist/langs/html.mjs'
import ini from 'shiki/dist/langs/ini.mjs'
import java from 'shiki/dist/langs/java.mjs'
import javascript from 'shiki/dist/langs/javascript.mjs'
import json from 'shiki/dist/langs/json.mjs'
import jsonc from 'shiki/dist/langs/jsonc.mjs'
import jsx from 'shiki/dist/langs/jsx.mjs'
import kotlin from 'shiki/dist/langs/kotlin.mjs'
import less from 'shiki/dist/langs/less.mjs'
import lua from 'shiki/dist/langs/lua.mjs'
import makefile from 'shiki/dist/langs/makefile.mjs'
import markdown from 'shiki/dist/langs/markdown.mjs'
import mdx from 'shiki/dist/langs/mdx.mjs'
import php from 'shiki/dist/langs/php.mjs'
import powershell from 'shiki/dist/langs/powershell.mjs'
import prisma from 'shiki/dist/langs/prisma.mjs'
import python from 'shiki/dist/langs/python.mjs'
import r from 'shiki/dist/langs/r.mjs'
import ruby from 'shiki/dist/langs/ruby.mjs'
import rust from 'shiki/dist/langs/rust.mjs'
import scala from 'shiki/dist/langs/scala.mjs'
import scss from 'shiki/dist/langs/scss.mjs'
import sql from 'shiki/dist/langs/sql.mjs'
import svelte from 'shiki/dist/langs/svelte.mjs'
import swift from 'shiki/dist/langs/swift.mjs'
import toml from 'shiki/dist/langs/toml.mjs'
import tsx from 'shiki/dist/langs/tsx.mjs'
import typescript from 'shiki/dist/langs/typescript.mjs'
import viml from 'shiki/dist/langs/viml.mjs'
import vue from 'shiki/dist/langs/vue.mjs'
import xml from 'shiki/dist/langs/xml.mjs'
import yaml from 'shiki/dist/langs/yaml.mjs'

const LANGS = [
  astro, bash, c, clojure, cpp, csharp, css, dart, dockerfile, dotenv, elixir,
  erlang, fish, go, graphql, haskell, hcl, html, ini, java, javascript, json,
  jsonc, jsx, kotlin, less, lua, makefile, markdown, mdx, php, powershell,
  prisma,
  python, r, ruby, rust, scala, scss, sql, svelte, swift, toml, tsx,
  typescript, viml, vue, xml, yaml,
] as never[]

let highlighter: Promise<HighlighterCore> | null = null

export function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [githubDarkDefault, githubLightHighContrast],
    langs: LANGS,
    // Pure JS regex engine: no oniguruma wasm to ship or fetch. `forgiving`
    // skips a pattern the engine cannot express instead of throwing, which is
    // what keeps a single odd grammar from taking the whole preview down.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  return highlighter
}
