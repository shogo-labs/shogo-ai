// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Rewrites `import { Code2 } from 'lucide-react-native'` into a direct
 * icon-file import plus a NativeWind cssInterop call.
 *
 * The package's main entry re-exports every icon. Metro does not tree-shake
 * that barrel, so one `import *` or a barrel import pulled all ~3000 icons
 * into the desktop web chunk. Named imports go to `dist/esm/icons/<file>.js`.
 * Namespace imports (`import * as Lucide`) are left alone — those call sites
 * load the catalog lazily from `lib/lucide-catalog.tsx`.
 */
const fs = require('fs')
const path = require('path')

let cachedMap = null

function loadIconMap() {
  if (cachedMap) return cachedMap
  const pkg = require.resolve('lucide-react-native/package.json', { paths: [__dirname] })
  const entry = path.join(path.dirname(pkg), 'dist', 'esm', 'lucide-react-native.js')
  const text = fs.readFileSync(entry, 'utf8')
  const map = new Map()
  const re = /export \{([^}]+)\} from '\.\/icons\/([^']+)'/g
  let match
  while ((match = re.exec(text))) {
    const file = match[2]
    for (const part of match[1].split(',')) {
      const name = part.trim().match(/as\s+([A-Za-z0-9_]+)\s*$/)
      if (name) map.set(name[1], file)
    }
  }
  cachedMap = map
  return map
}

function cssInteropStmt(t, cssLocal, binding) {
  return t.expressionStatement(
    t.callExpression(t.identifier(cssLocal), [
      binding,
      t.objectExpression([
        t.objectProperty(
          t.identifier('className'),
          t.objectExpression([
            t.objectProperty(t.identifier('target'), t.stringLiteral('style')),
            t.objectProperty(
              t.identifier('nativeStyleToProp'),
              t.objectExpression([
                t.objectProperty(t.identifier('color'), t.booleanLiteral(true)),
              ]),
            ),
          ]),
        ),
      ]),
    ]),
  )
}

function plugin(babel) {
  const t = babel.types
  return {
    name: 'lucide-direct',
    visitor: {
      ImportDeclaration(importPath, state) {
        if (importPath.node.source.value !== 'lucide-react-native') return
        if (importPath.node.specifiers.some((spec) => spec.type !== 'ImportSpecifier')) return
        const map = state.opts.map || loadIconMap()
        const lookup = map instanceof Map ? (name) => map.get(name) : (name) => map[name]
        const specifiers = importPath.node.specifiers.filter((spec) => spec.type === 'ImportSpecifier')
        if (!specifiers.length) return
        if (specifiers.some((spec) => !lookup(spec.imported.name || spec.imported.value))) return

        const program = importPath.parentPath
        let cssName = null
        for (const stmt of program.node.body) {
          if (stmt.type !== 'ImportDeclaration' || stmt.source.value !== 'nativewind') continue
          const found = stmt.specifiers.find(
            (spec) => spec.type === 'ImportSpecifier' && (spec.imported.name || spec.imported.value) === 'cssInterop',
          )
          if (found) cssName = found.local.name
        }
        if (!cssName) {
          cssName = program.scope.generateUid('cssInterop')
          importPath.insertBefore(
            t.importDeclaration(
              [t.importSpecifier(t.identifier(cssName), t.identifier('cssInterop'))],
              t.stringLiteral('nativewind'),
            ),
          )
        }

        const replacements = []
        const interop = []
        for (const spec of specifiers) {
          const imported = spec.imported.name || spec.imported.value
          const file = lookup(imported)
          replacements.push(
            t.importDeclaration(
              [t.importDefaultSpecifier(spec.local)],
              t.stringLiteral(`lucide-react-native/dist/esm/icons/${file}`),
            ),
          )
          interop.push(cssInteropStmt(t, cssName, spec.local))
        }
        importPath.replaceWithMultiple([...replacements, ...interop])
      },
    },
  }
}

module.exports = plugin
module.exports.loadIconMap = loadIconMap
