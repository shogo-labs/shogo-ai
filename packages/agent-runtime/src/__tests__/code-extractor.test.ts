// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Code Extractor — Unit Tests
 *
 * Tests Tree-sitter AST extraction of Function, Class, Test nodes
 * and CALLS, IMPORTS_FROM, INHERITS, TESTED_BY, CONTAINS edges.
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { CodeExtractor } from '../code-extractor'

const ext = new CodeExtractor()

beforeAll(async () => {
  await ext.preload()
})

// ============================================================================
// canHandle
// ============================================================================

describe('canHandle', () => {
  test('accepts Python, TypeScript, JS, Go, Rust, Java', () => {
    expect(ext.canHandle('main.py', 'code')).toBe(true)
    expect(ext.canHandle('app.ts', 'code')).toBe(true)
    expect(ext.canHandle('App.tsx', 'code')).toBe(true)
    expect(ext.canHandle('index.js', 'code')).toBe(true)
    expect(ext.canHandle('util.jsx', 'code')).toBe(true)
    expect(ext.canHandle('main.go', 'code')).toBe(true)
    expect(ext.canHandle('lib.rs', 'code')).toBe(true)
    expect(ext.canHandle('Main.java', 'code')).toBe(true)
  })

  test('rejects non-code extensions', () => {
    expect(ext.canHandle('readme.md', 'code')).toBe(false)
    expect(ext.canHandle('data.csv', 'code')).toBe(false)
    expect(ext.canHandle('style.css', 'code')).toBe(false)
  })

  test('rejects non-code sources', () => {
    expect(ext.canHandle('app.py', 'files')).toBe(false)
  })
})

// ============================================================================
// Python extraction
// ============================================================================

describe('Python', () => {
  const pyCode = `
import os
from pathlib import Path

def greet(name: str) -> str:
    return f"Hello, {name}"

class UserService:
    def __init__(self, db):
        self.db = db

    def get_user(self, user_id: int):
        return self.db.query(user_id)

def process():
    svc = UserService(None)
    svc.get_user(42)
    greet("world")
`

  test('extracts functions and classes', () => {
    const result = ext.extract('app.py', pyCode, 'code', ['app.py'])
    const nodes = result.nodes

    const classes = nodes.filter(n => n.kind === 'Class')
    expect(classes.length).toBe(1)
    expect(classes[0].name).toBe('UserService')

    const funcs = nodes.filter(n => n.kind === 'Function')
    expect(funcs.some(f => f.name === 'greet')).toBe(true)
    expect(funcs.some(f => f.name === 'process')).toBe(true)
    expect(funcs.some(f => f.name === '__init__')).toBe(true)
    expect(funcs.some(f => f.name === 'get_user')).toBe(true)
  })

  test('produces CONTAINS edges', () => {
    const result = ext.extract('app.py', pyCode, 'code', ['app.py'])
    const contains = result.edges.filter(e => e.kind === 'CONTAINS')
    expect(contains.length).toBeGreaterThanOrEqual(4)
  })

  test('produces IMPORTS_FROM edges', () => {
    const result = ext.extract('app.py', pyCode, 'code', ['app.py'])
    const imports = result.edges.filter(e => e.kind === 'IMPORTS_FROM')
    expect(imports.length).toBe(2)
    expect(imports.some(i => i.targetQualified.includes('os'))).toBe(true)
    expect(imports.some(i => i.targetQualified.includes('pathlib'))).toBe(true)
  })

  test('produces CALLS edges', () => {
    const result = ext.extract('app.py', pyCode, 'code', ['app.py'])
    const calls = result.edges.filter(e => e.kind === 'CALLS')
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  test('detects test functions', () => {
    const testCode = `
def test_greet():
    assert greet("world") == "Hello, world"

class TestUserService:
    def test_get_user(self):
        pass
`
    const result = ext.extract('test_app.py', testCode, 'code', ['test_app.py', 'app.py'])
    const tests = result.nodes.filter(n => n.kind === 'Test')
    expect(tests.length).toBeGreaterThanOrEqual(1)
    expect(tests.some(t => t.name === 'test_greet')).toBe(true)
  })

  test('produces TESTED_BY edges for test files', () => {
    const testCode = `
from app import greet

def test_greet():
    assert greet("world") == "Hello, world"
`
    const result = ext.extract('test_app.py', testCode, 'code', ['test_app.py', 'app.py'])
    const testedBy = result.edges.filter(e => e.kind === 'TESTED_BY')
    expect(testedBy.length).toBeGreaterThanOrEqual(1)
  })
})

// ============================================================================
// TypeScript extraction
// ============================================================================

describe('TypeScript', () => {
  const tsCode = `
import { readFile } from 'fs'
import { join } from 'path'

export class FileReader {
  private basePath: string

  constructor(basePath: string) {
    this.basePath = basePath
  }

  read(name: string): string {
    return readFile(join(this.basePath, name), 'utf-8')
  }
}

export function processFile(reader: FileReader): void {
  reader.read('config.json')
}

const helper = (x: number): number => x * 2
`

  test('extracts classes, methods, functions, arrow functions', () => {
    const result = ext.extract('reader.ts', tsCode, 'code', ['reader.ts'])
    const nodes = result.nodes

    expect(nodes.some(n => n.kind === 'Class' && n.name === 'FileReader')).toBe(true)
    expect(nodes.some(n => n.kind === 'Function' && n.name === 'processFile')).toBe(true)
    expect(nodes.some(n => n.kind === 'Function' && n.name === 'helper')).toBe(true)
  })

  test('produces IMPORTS_FROM edges', () => {
    const result = ext.extract('reader.ts', tsCode, 'code', ['reader.ts'])
    const imports = result.edges.filter(e => e.kind === 'IMPORTS_FROM')
    expect(imports.length).toBe(2)
  })

  test('produces CALLS edges', () => {
    const result = ext.extract('reader.ts', tsCode, 'code', ['reader.ts'])
    const calls = result.edges.filter(e => e.kind === 'CALLS')
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  test('extracts params and returnType', () => {
    const result = ext.extract('reader.ts', tsCode, 'code', ['reader.ts'])
    const processFile = result.nodes.find(n => n.name === 'processFile')
    expect(processFile).toBeDefined()
    expect(processFile!.params).toBeDefined()
  })

  test('detects test file and TESTED_BY edges', () => {
    const testCode = `
import { FileReader, processFile } from './reader'

function test_read() {
  const reader = new FileReader('/tmp')
  processFile(reader)
}
`
    const result = ext.extract('reader.test.ts', testCode, 'code', ['reader.test.ts', 'reader.ts'])
    // file is a test file, test_read matches test name pattern
    const testNodes = result.nodes.filter(n => n.kind === 'Test')
    expect(testNodes.length).toBeGreaterThanOrEqual(1)
    const testedBy = result.edges.filter(e => e.kind === 'TESTED_BY')
    expect(testedBy.length).toBeGreaterThanOrEqual(1)
  })
})

// ============================================================================
// Go extraction
// ============================================================================

describe('Go', () => {
  const goCode = `
package main

import "fmt"

type Server struct {
	port int
}

func (s *Server) Start() {
	fmt.Println("Starting on", s.port)
}

func NewServer(port int) *Server {
	return &Server{port: port}
}
`

  test('extracts structs and functions', () => {
    const result = ext.extract('main.go', goCode, 'code', ['main.go'])
    const nodes = result.nodes

    expect(nodes.some(n => n.kind === 'Class' && n.name === 'Server')).toBe(true)
    expect(nodes.some(n => n.kind === 'Function' && n.name === 'Start')).toBe(true)
    expect(nodes.some(n => n.kind === 'Function' && n.name === 'NewServer')).toBe(true)
  })

  test('produces IMPORTS_FROM edges for Go', () => {
    const result = ext.extract('main.go', goCode, 'code', ['main.go'])
    const imports = result.edges.filter(e => e.kind === 'IMPORTS_FROM')
    expect(imports.length).toBeGreaterThanOrEqual(1)
  })
})

// ============================================================================
// Rust extraction
// ============================================================================

describe('Rust', () => {
  const rustCode = `
use std::io;

struct Config {
    name: String,
}

fn load_config() -> Config {
    Config { name: "test".to_string() }
}

fn main() {
    let cfg = load_config();
    println!("{}", cfg.name);
}
`

  test('extracts struct and functions', () => {
    const result = ext.extract('main.rs', rustCode, 'code', ['main.rs'])
    const nodes = result.nodes

    expect(nodes.some(n => n.kind === 'Class' && n.name === 'Config')).toBe(true)
    expect(nodes.some(n => n.kind === 'Function' && n.name === 'load_config')).toBe(true)
    expect(nodes.some(n => n.kind === 'Function' && n.name === 'main')).toBe(true)
  })

  test('produces use declaration edges', () => {
    const result = ext.extract('main.rs', rustCode, 'code', ['main.rs'])
    const imports = result.edges.filter(e => e.kind === 'IMPORTS_FROM')
    expect(imports.length).toBeGreaterThanOrEqual(1)
  })
})

// ============================================================================
// Java extraction
// ============================================================================

describe('Java', () => {
  const javaCode = `
import java.util.List;

public class UserController {
    private UserService service;

    public List<User> getUsers() {
        return service.findAll();
    }
}
`

  test('extracts class and methods', () => {
    const result = ext.extract('UserController.java', javaCode, 'code', ['UserController.java'])
    const nodes = result.nodes

    expect(nodes.some(n => n.kind === 'Class' && n.name === 'UserController')).toBe(true)
    expect(nodes.some(n => n.kind === 'Function' && n.name === 'getUsers')).toBe(true)
  })

  test('produces IMPORTS_FROM edges for Java', () => {
    const result = ext.extract('UserController.java', javaCode, 'code', ['UserController.java'])
    const imports = result.edges.filter(e => e.kind === 'IMPORTS_FROM')
    expect(imports.length).toBe(1)
  })
})

// ============================================================================
// Inheritance
// ============================================================================

describe('Inheritance', () => {
  test('Python class inheritance produces INHERITS edge', () => {
    const code = `
class Animal:
    pass

class Dog(Animal):
    pass
`
    const result = ext.extract('models.py', code, 'code', ['models.py'])
    const inherits = result.edges.filter(e => e.kind === 'INHERITS')
    expect(inherits.length).toBeGreaterThanOrEqual(1)
    expect(inherits.some(e => e.targetQualified.includes('Animal'))).toBe(true)
  })

  test('TypeScript class extends produces INHERITS edge', () => {
    const code = `
class Base {}
class Child extends Base {}
`
    const result = ext.extract('models.ts', code, 'code', ['models.ts'])
    const inherits = result.edges.filter(e => e.kind === 'INHERITS')
    expect(inherits.length).toBeGreaterThanOrEqual(1)
    expect(inherits.some(e => e.targetQualified.includes('Base'))).toBe(true)
  })
})

// ============================================================================
// Edge cases
// ============================================================================

describe('Edge cases', () => {
  test('empty file produces no nodes or edges', () => {
    const result = ext.extract('empty.py', '', 'code', [])
    expect(result.nodes.length).toBe(0)
    expect(result.edges.length).toBe(0)
  })

  test('file with only comments produces no symbol nodes', () => {
    const result = ext.extract('comments.py', '# This is a comment\n# Another comment\n', 'code', [])
    const symbolNodes = result.nodes.filter(n => n.kind !== 'File')
    expect(symbolNodes.length).toBe(0)
  })

  test('syntax errors do not crash', () => {
    const result = ext.extract('broken.ts', 'function {{{ broken syntax', 'code', [])
    expect(result).toBeDefined()
  })

  test('unrecognized extension returns empty', () => {
    const result = ext.extract('data.csv', 'a,b,c\n1,2,3', 'code', [])
    expect(result.nodes.length).toBe(0)
    expect(result.edges.length).toBe(0)
  })
})
