// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tree-sitter Code Extractor
 *
 * Parses source files with Tree-sitter (WASM) to produce code-level graph
 * nodes (Function, Class, Test) and edges (CALLS, IMPORTS_FROM, INHERITS,
 * CONTAINS, TESTED_BY).
 *
 * Supports: Python, TypeScript, TSX, JavaScript, Go, Rust, Java.
 */

import type { Extractor, ExtractedData } from './workspace-graph'
import { dirname, join, extname, basename } from 'path'

// ---------------------------------------------------------------------------
// Language + AST type mappings
// ---------------------------------------------------------------------------

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
}

const CLASS_TYPES: Record<string, string[]> = {
  python: ['class_definition'],
  typescript: ['class_declaration', 'class', 'interface_declaration'],
  tsx: ['class_declaration', 'class', 'interface_declaration'],
  javascript: ['class_declaration', 'class'],
  go: ['type_declaration'],
  rust: ['struct_item', 'enum_item', 'impl_item', 'trait_item'],
  java: ['class_declaration', 'interface_declaration', 'enum_declaration'],
}

const FUNCTION_TYPES: Record<string, string[]> = {
  python: ['function_definition'],
  typescript: ['function_declaration', 'method_definition', 'arrow_function'],
  tsx: ['function_declaration', 'method_definition', 'arrow_function'],
  javascript: ['function_declaration', 'method_definition', 'arrow_function'],
  go: ['function_declaration', 'method_declaration'],
  rust: ['function_item'],
  java: ['method_declaration', 'constructor_declaration'],
}

const IMPORT_TYPES: Record<string, string[]> = {
  python: ['import_statement', 'import_from_statement'],
  typescript: ['import_statement'],
  tsx: ['import_statement'],
  javascript: ['import_statement'],
  go: ['import_declaration'],
  rust: ['use_declaration'],
  java: ['import_declaration'],
}

const CALL_TYPES: Record<string, string[]> = {
  python: ['call'],
  typescript: ['call_expression', 'new_expression'],
  tsx: ['call_expression', 'new_expression'],
  javascript: ['call_expression', 'new_expression'],
  go: ['call_expression'],
  rust: ['call_expression', 'macro_invocation'],
  java: ['method_invocation', 'object_creation_expression'],
}

// ---------------------------------------------------------------------------
// Test detection patterns
// ---------------------------------------------------------------------------

const TEST_FILE_PATTERNS = [
  /test_.*\.py$/,
  /.*_test\.py$/,
  /.*\.test\.[jt]sx?$/,
  /.*\.spec\.[jt]sx?$/,
  /.*_test\.go$/,
  /tests?\//,
]

const TEST_NAME_PATTERNS = [
  /^test_/,
  /^Test[A-Z]/,
  /_test$/,
]

const TEST_RUNNER_NAMES = new Set([
  'describe', 'it', 'test', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
])

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some(p => p.test(filePath))
}

function isTestFunction(name: string, fileIsTest: boolean): boolean {
  if (TEST_NAME_PATTERNS.some(p => p.test(name))) return true
  if (fileIsTest && TEST_RUNNER_NAMES.has(name)) return true
  return false
}

// ---------------------------------------------------------------------------
// Tree-sitter lazy initialization
// ---------------------------------------------------------------------------

let _Parser: any = null
let _Language: any = null
let _initPromise: Promise<void> | null = null
let _initialized = false
const _langCache = new Map<string, any>()

function getWasmDir(): string {
  const path = require('path')
  return path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out')
}

async function ensureInit(): Promise<void> {
  if (_initialized) return
  if (_initPromise) { await _initPromise; return }
  _initPromise = (async () => {
    const mod = require('web-tree-sitter')
    _Parser = mod.Parser
    _Language = mod.Language
    await _Parser.init()
    _initialized = true
  })()
  await _initPromise
}

async function getLanguage(langId: string): Promise<any> {
  await ensureInit()
  let lang = _langCache.get(langId)
  if (lang) return lang
  const wasmName = langId === 'typescript' ? 'tree-sitter-typescript'
    : langId === 'tsx' ? 'tree-sitter-tsx'
    : `tree-sitter-${langId}`
  const wasmPath = join(getWasmDir(), `${wasmName}.wasm`)
  lang = await _Language.load(wasmPath)
  _langCache.set(langId, lang)
  return lang
}

function parseSync(langId: string, content: string): any | null {
  const lang = _langCache.get(langId)
  if (!lang) return null
  const parser = new _Parser()
  parser.setLanguage(lang)
  return parser.parse(content)
}

// ---------------------------------------------------------------------------
// AST walking helpers
// ---------------------------------------------------------------------------

interface SymbolInfo {
  kind: 'Class' | 'Function' | 'Test'
  name: string
  parentName: string | null
  lineStart: number
  lineEnd: number
  params?: string
  returnType?: string
  decorators?: string[]
}

function getNodeName(node: any, language: string): string | null {
  const nameNode = node.childForFieldName('name')
  if (nameNode) return nameNode.text

  if ((language === 'typescript' || language === 'tsx' || language === 'javascript') &&
      (node.type === 'arrow_function' || node.type === 'function_expression')) {
    const parent = node.parent
    if (parent?.type === 'variable_declarator') {
      const id = parent.childForFieldName('name')
      if (id) return id.text
    }
    if (parent?.type === 'pair') {
      const key = parent.childForFieldName('key')
      if (key) return key.text
    }
  }

  if (language === 'go' && node.type === 'type_declaration') {
    const spec = node.children.find((c: any) => c.type === 'type_spec')
    if (spec) {
      const n = spec.childForFieldName('name')
      if (n) return n.text
    }
  }

  return null
}

function getParams(node: any): string | undefined {
  const params = node.childForFieldName('parameters') || node.childForFieldName('formal_parameters')
  if (!params) return undefined
  const text = params.text
  return text?.length > 500 ? text.substring(0, 500) + '...' : text
}

function getReturnType(node: any, language: string): string | undefined {
  const retType = node.childForFieldName('return_type') || node.childForFieldName('type')
  if (retType) return retType.text?.substring(0, 200)

  if (language === 'python') {
    for (const child of node.children) {
      if (child.type === 'type' || child.type === 'return_type') return child.text?.substring(0, 200)
    }
  }
  return undefined
}

function getDecorators(node: any, language: string): string[] {
  const decorators: string[] = []
  if (language === 'python') {
    let prev = node.previousNamedSibling
    while (prev && prev.type === 'decorator') {
      decorators.push(prev.text)
      prev = prev.previousNamedSibling
    }
  } else if (language === 'typescript' || language === 'tsx' || language === 'javascript' || language === 'java') {
    let prev = node.previousNamedSibling
    while (prev && (prev.type === 'decorator' || prev.type === 'annotation' || prev.type === 'marker_annotation')) {
      decorators.push(prev.text)
      prev = prev.previousNamedSibling
    }
  }
  return decorators
}

function getBases(node: any, language: string): string[] {
  const bases: string[] = []
  if (language === 'python') {
    const argList = node.childForFieldName('superclasses') || node.children.find((c: any) => c.type === 'argument_list')
    if (argList) {
      for (const child of argList.namedChildren) {
        if (child.type === 'identifier' || child.type === 'attribute') bases.push(child.text)
      }
    }
  } else if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    for (const child of node.children) {
      if (child.type === 'class_heritage') {
        for (const clause of child.namedChildren) {
          if (clause.type === 'extends_clause' || clause.type === 'implements_clause') {
            for (const base of clause.namedChildren) {
              if (base.type === 'identifier' || base.type === 'generic_type' || base.type === 'nested_type_identifier') {
                const id = base.type === 'generic_type' ? base.childForFieldName('name')?.text : base.text
                if (id) bases.push(id)
              }
            }
          }
        }
      }
    }
  } else if (language === 'java') {
    const sc = node.childForFieldName('superclass')
    if (sc) bases.push(sc.text)
    const interfaces = node.childForFieldName('interfaces')
    if (interfaces) {
      for (const child of interfaces.namedChildren) {
        if (child.type === 'type_list') {
          for (const t of child.namedChildren) bases.push(t.text)
        } else {
          bases.push(child.text)
        }
      }
    }
  } else if (language === 'go') {
    // Go type declarations with embedded types not handled here
  } else if (language === 'rust') {
    // Rust impl blocks: impl Trait for Struct
    if (node.type === 'impl_item') {
      const trait_ = node.childForFieldName('trait')
      if (trait_) bases.push(trait_.text)
    }
  }
  return bases
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

function extractImports(
  node: any, language: string, filePath: string, allFiles: string[]
): Array<{ module: string; names: string[]; resolvedPath: string | null; line: number }> {
  const imports: Array<{ module: string; names: string[]; resolvedPath: string | null; line: number }> = []
  const importTypes = IMPORT_TYPES[language] || []

  function walk(n: any) {
    if (importTypes.includes(n.type)) {
      const info = parseImportNode(n, language, filePath, allFiles)
      if (info) imports.push(info)
    }
    for (const child of n.namedChildren) walk(child)
  }
  walk(node)
  return imports
}

function parseImportNode(
  node: any, language: string, filePath: string, allFiles: string[]
): { module: string; names: string[]; resolvedPath: string | null; line: number } | null {
  const line = node.startPosition.row + 1

  if (language === 'python') {
    if (node.type === 'import_from_statement') {
      const mod = node.childForFieldName('module_name')?.text || node.children.find((c: any) => c.type === 'dotted_name')?.text
      if (!mod) return null
      const names: string[] = []
      for (const child of node.namedChildren) {
        if (child.type === 'dotted_name' && child !== node.children[1]) names.push(child.text)
        if (child.type === 'aliased_import') {
          const n = child.childForFieldName('name')
          if (n) names.push(n.text)
        }
      }
      return { module: mod, names, resolvedPath: resolveModule(mod, language, filePath, allFiles), line }
    }
    if (node.type === 'import_statement') {
      const mod = node.children.find((c: any) => c.type === 'dotted_name')?.text
      if (mod) return { module: mod, names: [], resolvedPath: resolveModule(mod, language, filePath, allFiles), line }
    }
  }

  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    const source = node.childForFieldName('source')?.text?.replace(/['"]/g, '')
    if (!source) return null
    const names: string[] = []
    const clause = node.children.find((c: any) => c.type === 'import_clause')
    if (clause) {
      for (const child of clause.namedChildren) {
        if (child.type === 'identifier') names.push(child.text)
        if (child.type === 'named_imports') {
          for (const spec of child.namedChildren) {
            if (spec.type === 'import_specifier') {
              const n = spec.childForFieldName('name')
              if (n) names.push(n.text)
            }
          }
        }
      }
    }
    return { module: source, names, resolvedPath: resolveModule(source, language, filePath, allFiles), line }
  }

  if (language === 'go') {
    for (const child of node.namedChildren) {
      if (child.type === 'import_spec' || child.type === 'import_spec_list') {
        const specs = child.type === 'import_spec_list' ? child.namedChildren : [child]
        for (const spec of specs) {
          const path = spec.childForFieldName('path')?.text?.replace(/"/g, '') || spec.text?.replace(/"/g, '')
          if (path) return { module: path, names: [], resolvedPath: null, line }
        }
      }
    }
  }

  if (language === 'rust') {
    const path = node.text?.replace(/^use\s+/, '').replace(/;$/, '').trim()
    if (path) return { module: path, names: [], resolvedPath: null, line }
  }

  if (language === 'java') {
    const parts: string[] = []
    for (const child of node.namedChildren) {
      if (child.type === 'scoped_identifier' || child.type === 'identifier') parts.push(child.text)
    }
    const mod = parts.join('.')
    if (mod) return { module: mod, names: [], resolvedPath: null, line }
  }

  return null
}

function resolveModule(mod: string, language: string, filePath: string, allFiles: string[]): string | null {
  if (language === 'python') {
    const asPath = mod.replace(/\./g, '/')
    const candidates = [`${asPath}.py`, `${asPath}/__init__.py`]
    for (const c of candidates) {
      if (allFiles.includes(c)) return c
    }
  }

  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    if (!mod.startsWith('.')) return null
    const dir = dirname(filePath)
    const resolved = join(dir, mod).replace(/\\/g, '/')
    const exts = ['.ts', '.tsx', '.js', '.jsx']
    for (const ext of exts) {
      if (allFiles.includes(resolved + ext)) return resolved + ext
    }
    for (const ext of exts) {
      const indexPath = resolved + '/index' + ext
      if (allFiles.includes(indexPath)) return indexPath
    }
    if (allFiles.includes(resolved)) return resolved
  }

  return null
}

// ---------------------------------------------------------------------------
// Call extraction
// ---------------------------------------------------------------------------

function extractCalls(
  rootNode: any, language: string,
  enclosedSymbols: Map<string, SymbolInfo>,
  symbolQualifiedNames: Map<string, string>,
): Array<{ caller: string; callee: string; line: number }> {
  const calls: Array<{ caller: string; callee: string; line: number }> = []
  const callTypes = CALL_TYPES[language] || []

  function findEnclosingSymbol(row: number): string | null {
    let best: { name: string; span: number } | null = null
    for (const [name, info] of enclosedSymbols) {
      if (row >= info.lineStart - 1 && row <= info.lineEnd - 1) {
        const span = info.lineEnd - info.lineStart
        if (!best || span < best.span) {
          best = { name, span }
        }
      }
    }
    return best ? best.name : null
  }

  function getCallTarget(node: any): string | null {
    if (language === 'python' && node.type === 'call') {
      const fn = node.childForFieldName('function')
      if (!fn) return null
      if (fn.type === 'identifier') return fn.text
      if (fn.type === 'attribute') {
        const attr = fn.childForFieldName('attribute')
        return attr?.text || null
      }
      return fn.text?.substring(0, 100)
    }

    if (node.type === 'call_expression' || node.type === 'new_expression') {
      const fn = node.childForFieldName('function') || node.childForFieldName('constructor')
      if (!fn) {
        const first = node.namedChildren[0]
        if (first) return first.text?.substring(0, 100)
        return null
      }
      if (fn.type === 'identifier') return fn.text
      if (fn.type === 'member_expression' || fn.type === 'field_expression' || fn.type === 'selector_expression') {
        const prop = fn.childForFieldName('property') || fn.childForFieldName('field') || fn.childForFieldName('selector')
        return prop?.text || fn.text?.substring(0, 100)
      }
      return fn.text?.substring(0, 100)
    }

    if (node.type === 'method_invocation') {
      const name = node.childForFieldName('name')
      return name?.text || null
    }

    if (node.type === 'object_creation_expression') {
      const type = node.childForFieldName('type')
      return type?.text || null
    }

    if (node.type === 'macro_invocation') {
      const macro = node.childForFieldName('macro')
      return macro?.text || null
    }

    return null
  }

  function walk(n: any) {
    if (callTypes.includes(n.type)) {
      const target = getCallTarget(n)
      if (target) {
        const callerSymbol = findEnclosingSymbol(n.startPosition.row)
        if (callerSymbol) {
          calls.push({
            caller: callerSymbol,
            callee: target,
            line: n.startPosition.row + 1,
          })
        }
      }
    }
    for (const child of n.namedChildren) walk(child)
  }
  walk(rootNode)
  return calls
}

// ---------------------------------------------------------------------------
// CodeExtractor
// ---------------------------------------------------------------------------

export class CodeExtractor implements Extractor {
  name = 'code'
  private _preloaded = false

  canHandle(filePath: string, source: string): boolean {
    if (source !== 'code') return false
    const ext = extname(filePath).toLowerCase()
    return ext in EXTENSION_TO_LANGUAGE
  }

  /**
   * Pre-load all language grammars. Must be called once before extract().
   * buildGraph calls this via the graph initialization path.
   */
  async preload(): Promise<void> {
    if (this._preloaded) return
    await ensureInit()
    const langs = new Set(Object.values(EXTENSION_TO_LANGUAGE))
    await Promise.all([...langs].map(l => getLanguage(l)))
    this._preloaded = true
  }

  extract(filePath: string, content: string, source: string, allFiles: string[]): ExtractedData {
    const ext = extname(filePath).toLowerCase()
    const langId = EXTENSION_TO_LANGUAGE[ext]
    if (!langId) return { nodes: [], edges: [] }

    const tree = parseSync(langId, content)
    if (!tree) return { nodes: [], edges: [] }

    const fileIsTest = isTestFile(filePath)
    const nodes: ExtractedData['nodes'] = []
    const edges: ExtractedData['edges'] = []
    const fileQN = `${source}::${filePath}`

    const symbolMap = new Map<string, SymbolInfo>()
    const qualifiedNames = new Map<string, string>()
    const definedNames = new Map<string, string>() // name -> qualified name

    // Pass 1: extract symbols (classes, functions, tests)
    function walkSymbols(node: any, parentName: string | null) {
      const classTypes = CLASS_TYPES[langId] || []
      const funcTypes = FUNCTION_TYPES[langId] || []

      if (classTypes.includes(node.type)) {
        const name = getNodeName(node, langId)
        if (name) {
          const qn = parentName
            ? `${fileQN}::${parentName}.${name}`
            : `${fileQN}::${name}`
          const bases = getBases(node, langId)
          const decorators = getDecorators(node, langId)
          const info: SymbolInfo = {
            kind: 'Class',
            name,
            parentName,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            decorators: decorators.length > 0 ? decorators : undefined,
          }
          symbolMap.set(qn, info)
          qualifiedNames.set(name, qn)
          definedNames.set(name, qn)

          nodes.push({
            kind: 'Class', name, qualifiedName: qn, filePath, source,
            lineStart: info.lineStart, lineEnd: info.lineEnd,
            language: langId, parentName,
            extra: { bases, decorators: info.decorators },
          })

          edges.push({
            kind: 'CONTAINS',
            sourceQualified: parentName ? qualifiedNames.get(parentName) || fileQN : fileQN,
            targetQualified: qn, filePath, line: info.lineStart,
          })

          for (const base of bases) {
            edges.push({
              kind: 'INHERITS',
              sourceQualified: qn, targetQualified: base,
              filePath, line: info.lineStart,
            })
          }

          // Recurse into class body for methods
          for (const child of node.namedChildren) walkSymbols(child, name)
          return
        }
      }

      if (funcTypes.includes(node.type)) {
        let name = getNodeName(node, langId)
        if (!name && (node.type === 'arrow_function' || node.type === 'function_expression')) {
          // Already handled by getNodeName looking at parent
        }
        if (name) {
          const qn = parentName
            ? `${fileQN}::${parentName}.${name}`
            : `${fileQN}::${name}`
          const decorators = getDecorators(node, langId)
          const isTF = isTestFunction(name, fileIsTest)
          const info: SymbolInfo = {
            kind: isTF ? 'Test' : 'Function',
            name,
            parentName,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            params: getParams(node),
            returnType: getReturnType(node, langId),
            decorators: decorators.length > 0 ? decorators : undefined,
          }
          symbolMap.set(qn, info)
          qualifiedNames.set(name, qn)
          definedNames.set(name, qn)

          nodes.push({
            kind: info.kind, name, qualifiedName: qn, filePath, source,
            lineStart: info.lineStart, lineEnd: info.lineEnd,
            language: langId, parentName,
            params: info.params, returnType: info.returnType,
            extra: { decorators: info.decorators },
          })

          edges.push({
            kind: 'CONTAINS',
            sourceQualified: parentName ? qualifiedNames.get(parentName) || fileQN : fileQN,
            targetQualified: qn, filePath, line: info.lineStart,
          })
          return
        }
      }

      // Handle variable declarations with arrow functions / function expressions (JS/TS)
      if ((langId === 'typescript' || langId === 'tsx' || langId === 'javascript') &&
          (node.type === 'lexical_declaration' || node.type === 'variable_declaration')) {
        for (const decl of node.namedChildren) {
          if (decl.type === 'variable_declarator') {
            const value = decl.childForFieldName('value')
            if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
              const nameNode = decl.childForFieldName('name')
              const name = nameNode?.text
              if (name) {
                const qn = parentName ? `${fileQN}::${parentName}.${name}` : `${fileQN}::${name}`
                const isTF = isTestFunction(name, fileIsTest)
                const info: SymbolInfo = {
                  kind: isTF ? 'Test' : 'Function',
                  name,
                  parentName,
                  lineStart: node.startPosition.row + 1,
                  lineEnd: node.endPosition.row + 1,
                  params: getParams(value),
                  returnType: getReturnType(value, langId),
                }
                symbolMap.set(qn, info)
                qualifiedNames.set(name, qn)
                definedNames.set(name, qn)

                nodes.push({
                  kind: info.kind, name, qualifiedName: qn, filePath, source,
                  lineStart: info.lineStart, lineEnd: info.lineEnd,
                  language: langId, parentName,
                  params: info.params, returnType: info.returnType,
                  extra: {},
                })

                edges.push({
                  kind: 'CONTAINS',
                  sourceQualified: parentName ? qualifiedNames.get(parentName) || fileQN : fileQN,
                  targetQualified: qn, filePath, line: info.lineStart,
                })
              }
            }
          }
        }
        return
      }

      for (const child of node.namedChildren) walkSymbols(child, parentName)
    }

    walkSymbols(tree.rootNode, null)

    // Pass 2: extract imports
    const imports = extractImports(tree.rootNode, langId, filePath, allFiles)
    const importMap = new Map<string, string>() // imported name -> resolved path or module

    for (const imp of imports) {
      const targetQN = imp.resolvedPath ? `${source}::${imp.resolvedPath}` : imp.module
      edges.push({
        kind: 'IMPORTS_FROM',
        sourceQualified: fileQN,
        targetQualified: targetQN,
        filePath, line: imp.line,
      })

      for (const name of imp.names) {
        importMap.set(name, imp.resolvedPath || imp.module)
      }
    }

    // Pass 3: extract calls
    const rawCalls = extractCalls(tree.rootNode, langId, symbolMap, qualifiedNames)

    for (const call of rawCalls) {
      const callerQN = call.caller
      let calleeQN = call.callee

      // Try to resolve to a known symbol in this file
      if (definedNames.has(calleeQN)) {
        calleeQN = definedNames.get(calleeQN)!
      } else if (importMap.has(call.callee)) {
        const importedFrom = importMap.get(call.callee)!
        calleeQN = importedFrom.includes('::')
          ? `${importedFrom}::${call.callee}`
          : `${source}::${importedFrom}::${call.callee}`
      }

      edges.push({
        kind: 'CALLS',
        sourceQualified: callerQN,
        targetQualified: calleeQN,
        filePath, line: call.line,
      })
    }

    // Pass 4: TESTED_BY edges (reverse calls from test functions)
    if (fileIsTest) {
      for (const call of rawCalls) {
        const callerInfo = symbolMap.get(call.caller)
        if (callerInfo?.kind === 'Test') {
          let calleeQN = call.callee
          if (definedNames.has(calleeQN)) {
            calleeQN = definedNames.get(calleeQN)!
          } else if (importMap.has(call.callee)) {
            const importedFrom = importMap.get(call.callee)!
            calleeQN = importedFrom.includes('::')
              ? `${importedFrom}::${call.callee}`
              : `${source}::${importedFrom}::${call.callee}`
          }
          edges.push({
            kind: 'TESTED_BY',
            sourceQualified: calleeQN,
            targetQualified: call.caller,
            filePath, line: call.line,
          })
        }
      }
    }

    return { nodes, edges }
  }
}
