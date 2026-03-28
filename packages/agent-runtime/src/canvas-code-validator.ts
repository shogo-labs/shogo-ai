// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas Code Validator — TypeScript-based type-checking for canvas v2 code.
 *
 * Uses the TypeScript compiler API with a virtual file system to validate
 * agent-generated canvas code against the ambient declarations in
 * canvas-globals.d.ts. Catches undefined references (e.g. `RefreshCw`),
 * syntax errors, and type mismatches at write time.
 */

import ts from 'typescript'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let _canvasGlobalsDts: string | null = null

function getCanvasGlobalsDts(): string {
  if (_canvasGlobalsDts !== null) return _canvasGlobalsDts
  const dtsPath = resolve(__dirname, '../../canvas-runtime/src/canvas-globals.d.ts')
  try {
    _canvasGlobalsDts = readFileSync(dtsPath, 'utf-8')
  } catch {
    console.warn('[canvas-code-validator] canvas-globals.d.ts not found at', dtsPath)
    _canvasGlobalsDts = ''
  }
  return _canvasGlobalsDts
}

export interface CanvasLintDiagnostic {
  line: number
  col: number
  message: string
  severity: 'error' | 'warning'
}

export interface CanvasLintResult {
  ok: boolean
  diagnostics: CanvasLintDiagnostic[]
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.None,
  jsx: ts.JsxEmit.React,
  jsxFactory: 'h',
  strict: false,
  noEmit: true,
  allowJs: true,
  checkJs: true,
  skipLibCheck: true,
  skipDefaultLibCheck: true,
  noLib: true,
  types: [],
}

const LIB_DTS_CONTENT = `
interface Array<T> {
  length: number;
  [n: number]: T;
  push(...items: T[]): number;
  pop(): T | undefined;
  shift(): T | undefined;
  unshift(...items: T[]): number;
  slice(start?: number, end?: number): T[];
  splice(start: number, deleteCount?: number, ...items: T[]): T[];
  indexOf(searchElement: T, fromIndex?: number): number;
  includes(searchElement: T, fromIndex?: number): boolean;
  find(predicate: (value: T, index: number, obj: T[]) => unknown): T | undefined;
  findIndex(predicate: (value: T, index: number, obj: T[]) => unknown): number;
  filter(predicate: (value: T, index: number, array: T[]) => unknown): T[];
  filter<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S): S[];
  map<U>(callbackfn: (value: T, index: number, array: T[]) => U): U[];
  forEach(callbackfn: (value: T, index: number, array: T[]) => void): void;
  reduce<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue: U): U;
  reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T): T;
  some(predicate: (value: T, index: number, array: T[]) => unknown): boolean;
  every(predicate: (value: T, index: number, array: T[]) => unknown): boolean;
  join(separator?: string): string;
  reverse(): T[];
  sort(compareFn?: (a: T, b: T) => number): this;
  concat(...items: (T | T[])[]): T[];
  flat<D extends number = 1>(depth?: D): any[];
  flatMap<U>(callback: (value: T, index: number, array: T[]) => U | U[]): U[];
  fill(value: T, start?: number, end?: number): this;
  entries(): IterableIterator<[number, T]>;
  keys(): IterableIterator<number>;
  values(): IterableIterator<T>;
}
interface ArrayConstructor {
  new <T>(...items: T[]): T[];
  isArray(arg: any): arg is any[];
  from<T>(arrayLike: ArrayLike<T>): T[];
  from<T, U>(arrayLike: ArrayLike<T>, mapfn: (v: T, k: number) => U): U[];
}
declare var Array: ArrayConstructor;

interface ReadonlyArray<T> {
  length: number;
  [n: number]: T;
  indexOf(searchElement: T, fromIndex?: number): number;
  includes(searchElement: T, fromIndex?: number): boolean;
  find(predicate: (value: T, index: number, obj: readonly T[]) => unknown): T | undefined;
  filter(predicate: (value: T, index: number, array: readonly T[]) => unknown): T[];
  map<U>(callbackfn: (value: T, index: number, array: readonly T[]) => U): U[];
  forEach(callbackfn: (value: T, index: number, array: readonly T[]) => void): void;
  reduce<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: readonly T[]) => U, initialValue: U): U;
  some(predicate: (value: T, index: number, array: readonly T[]) => unknown): boolean;
  every(predicate: (value: T, index: number, array: readonly T[]) => unknown): boolean;
  join(separator?: string): string;
  slice(start?: number, end?: number): T[];
  concat(...items: (T | readonly T[])[]): T[];
  flat<D extends number = 1>(depth?: D): any[];
  flatMap<U>(callback: (value: T, index: number, array: readonly T[]) => U | U[]): U[];
}

interface String {
  length: number;
  charAt(pos: number): string;
  charCodeAt(index: number): number;
  indexOf(searchString: string, position?: number): number;
  lastIndexOf(searchString: string, position?: number): number;
  includes(searchString: string, position?: number): boolean;
  startsWith(searchValue: string, start?: number): boolean;
  endsWith(searchString: string, endPosition?: number): boolean;
  slice(start?: number, end?: number): string;
  substring(start: number, end?: number): string;
  toLowerCase(): string;
  toUpperCase(): string;
  trim(): string;
  trimStart(): string;
  trimEnd(): string;
  split(separator: string | RegExp, limit?: number): string[];
  replace(searchValue: string | RegExp, replaceValue: string): string;
  replaceAll(searchValue: string | RegExp, replaceValue: string): string;
  match(regexp: string | RegExp): RegExpMatchArray | null;
  padStart(maxLength: number, fillString?: string): string;
  padEnd(maxLength: number, fillString?: string): string;
  repeat(count: number): string;
  at(index: number): string | undefined;
}
interface StringConstructor {
  new (value?: any): String;
  (value?: any): string;
  fromCharCode(...codes: number[]): string;
}
declare var String: StringConstructor;

interface Number {
  toFixed(fractionDigits?: number): string;
  toLocaleString(locales?: string, options?: any): string;
  toPrecision(precision?: number): string;
  toString(radix?: number): string;
  valueOf(): number;
}
interface NumberConstructor {
  new (value?: any): Number;
  (value?: any): number;
  isFinite(number: unknown): boolean;
  isInteger(number: unknown): boolean;
  isNaN(number: unknown): boolean;
  parseFloat(string: string): number;
  parseInt(string: string, radix?: number): number;
  MAX_SAFE_INTEGER: number;
  MIN_SAFE_INTEGER: number;
}
declare var Number: NumberConstructor;

interface Boolean { valueOf(): boolean; }
interface BooleanConstructor { new (value?: any): Boolean; (value?: any): boolean; }
declare var Boolean: BooleanConstructor;

interface Function {
  apply(thisArg: any, argArray?: any): any;
  call(thisArg: any, ...argArray: any[]): any;
  bind(thisArg: any, ...argArray: any[]): any;
  length: number;
  name: string;
}

interface Object {
  constructor: Function;
  toString(): string;
  valueOf(): Object;
  hasOwnProperty(v: string | number | symbol): boolean;
}
interface ObjectConstructor {
  new (value?: any): any;
  keys(o: any): string[];
  values(o: any): any[];
  entries(o: any): [string, any][];
  assign<T, U>(target: T, source: U): T & U;
  assign<T>(target: T, ...sources: any[]): any;
  freeze<T>(o: T): Readonly<T>;
  fromEntries(entries: Iterable<readonly [PropertyKey, any]>): any;
  defineProperty(o: any, p: PropertyKey, attributes: PropertyDescriptor): any;
  getPrototypeOf(o: any): any;
  create(o: object | null, properties?: PropertyDescriptorMap): any;
}
declare var Object: ObjectConstructor;

interface RegExp {
  test(string: string): boolean;
  exec(string: string): RegExpExecArray | null;
  source: string;
  flags: string;
  global: boolean;
  ignoreCase: boolean;
  multiline: boolean;
  lastIndex: number;
}
interface RegExpMatchArray extends Array<string> { index?: number; input?: string; groups?: { [key: string]: string } }
interface RegExpExecArray extends Array<string> { index: number; input: string; groups?: { [key: string]: string } }
interface RegExpConstructor { new (pattern: string | RegExp, flags?: string): RegExp; (pattern: string | RegExp, flags?: string): RegExp; }
declare var RegExp: RegExpConstructor;

interface Error { name: string; message: string; stack?: string; }
interface ErrorConstructor { new (message?: string): Error; (message?: string): Error; }
declare var Error: ErrorConstructor;
declare var TypeError: ErrorConstructor;
declare var RangeError: ErrorConstructor;
declare var SyntaxError: ErrorConstructor;
declare var ReferenceError: ErrorConstructor;

interface Date {
  getTime(): number;
  getFullYear(): number;
  getMonth(): number;
  getDate(): number;
  getHours(): number;
  getMinutes(): number;
  getSeconds(): number;
  getMilliseconds(): number;
  getDay(): number;
  toISOString(): string;
  toLocaleDateString(locales?: string, options?: any): string;
  toLocaleTimeString(locales?: string, options?: any): string;
  toLocaleString(locales?: string, options?: any): string;
  toDateString(): string;
  toTimeString(): string;
  toString(): string;
  valueOf(): number;
}
interface DateConstructor {
  new (): Date;
  new (value: number | string): Date;
  new (year: number, month: number, date?: number, hours?: number, minutes?: number, seconds?: number, ms?: number): Date;
  (): string;
  now(): number;
  parse(s: string): number;
}
declare var Date: DateConstructor;

interface Map<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): this;
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
  forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void): void;
  size: number;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
}
interface MapConstructor { new <K, V>(entries?: readonly (readonly [K, V])[]): Map<K, V>; }
declare var Map: MapConstructor;

interface Set<T> {
  add(value: T): this;
  has(value: T): boolean;
  delete(value: T): boolean;
  clear(): void;
  forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void): void;
  size: number;
  keys(): IterableIterator<T>;
  values(): IterableIterator<T>;
  entries(): IterableIterator<[T, T]>;
}
interface SetConstructor { new <T>(values?: readonly T[]): Set<T>; }
declare var Set: SetConstructor;

interface Promise<T> {
  then<TResult1 = T, TResult2 = never>(onfulfilled?: (value: T) => TResult1 | PromiseLike<TResult1>, onrejected?: (reason: any) => TResult2 | PromiseLike<TResult2>): Promise<TResult1 | TResult2>;
  catch<TResult = never>(onrejected?: (reason: any) => TResult | PromiseLike<TResult>): Promise<T | TResult>;
  finally(onfinally?: (() => void) | undefined | null): Promise<T>;
}
interface PromiseLike<T> { then<TResult1 = T, TResult2 = never>(onfulfilled?: (value: T) => TResult1 | PromiseLike<TResult1>, onrejected?: (reason: any) => TResult2 | PromiseLike<TResult2>): PromiseLike<TResult1 | TResult2>; }
interface PromiseConstructor {
  new <T>(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void): Promise<T>;
  resolve<T>(value: T | PromiseLike<T>): Promise<T>;
  resolve(): Promise<void>;
  reject<T = never>(reason?: any): Promise<T>;
  all<T>(values: readonly (T | PromiseLike<T>)[]): Promise<T[]>;
  race<T>(values: readonly (T | PromiseLike<T>)[]): Promise<T>;
  allSettled<T>(values: readonly (T | PromiseLike<T>)[]): Promise<PromiseSettledResult<T>[]>;
}
declare var Promise: PromiseConstructor;
type PromiseSettledResult<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: any };

interface JSON {
  parse(text: string, reviver?: (key: string, value: any) => any): any;
  stringify(value: any, replacer?: (key: string, value: any) => any, space?: string | number): string;
  stringify(value: any, replacer?: (number | string)[] | null, space?: string | number): string;
}
declare var JSON: JSON;

interface Math {
  abs(x: number): number;
  ceil(x: number): number;
  floor(x: number): number;
  round(x: number): number;
  max(...values: number[]): number;
  min(...values: number[]): number;
  random(): number;
  pow(x: number, y: number): number;
  sqrt(x: number): number;
  log(x: number): number;
  PI: number;
  E: number;
  sign(x: number): number;
  trunc(x: number): number;
}
declare var Math: Math;

declare function parseInt(string: string, radix?: number): number;
declare function parseFloat(string: string): number;
declare function isNaN(number: number): boolean;
declare function isFinite(number: number): boolean;
declare function encodeURIComponent(uriComponent: string | number | boolean): string;
declare function decodeURIComponent(encodedURIComponent: string): string;
declare function encodeURI(uri: string): string;
declare function decodeURI(encodedURI: string): string;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;
declare function clearTimeout(id: number | undefined): void;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;
declare function clearInterval(id: number | undefined): void;
declare function atob(data: string): string;
declare function btoa(data: string): string;
declare var console: { log(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void; info(...args: any[]): void; debug(...args: any[]): void; };
declare var undefined: undefined;
declare var NaN: number;
declare var Infinity: number;

declare function fetch(input: string, init?: {
  method?: string;
  headers?: Record<string, string> | [string, string][];
  body?: string | FormData | URLSearchParams | Blob | ArrayBuffer;
  signal?: AbortSignal;
  credentials?: string;
  mode?: string;
}): Promise<Response>;
interface Response {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  json(): Promise<any>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
  clone(): Response;
}
interface Headers {
  get(name: string): string | null;
  set(name: string, value: string): void;
  has(name: string): boolean;
  delete(name: string): void;
  forEach(callbackfn: (value: string, key: string) => void): void;
}
interface Blob {
  size: number;
  type: string;
  slice(start?: number, end?: number, contentType?: string): Blob;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface BlobConstructor { new (blobParts?: any[], options?: { type?: string }): Blob; }
declare var Blob: BlobConstructor;
interface FormData {
  append(name: string, value: string | Blob, fileName?: string): void;
  get(name: string): string | null;
  set(name: string, value: string | Blob, fileName?: string): void;
  has(name: string): boolean;
  delete(name: string): void;
}
interface FormDataConstructor { new (): FormData; }
declare var FormData: FormDataConstructor;
interface URL {
  href: string;
  origin: string;
  protocol: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  searchParams: URLSearchParams;
  toString(): string;
}
interface URLConstructor { new (url: string, base?: string): URL; createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void; }
declare var URL: URLConstructor;
interface URLSearchParams {
  append(name: string, value: string): void;
  get(name: string): string | null;
  set(name: string, value: string): void;
  has(name: string): boolean;
  delete(name: string): void;
  toString(): string;
  forEach(callbackfn: (value: string, name: string) => void): void;
}
interface URLSearchParamsConstructor { new (init?: string | Record<string, string> | string[][]): URLSearchParams; }
declare var URLSearchParams: URLSearchParamsConstructor;

interface AbortController { signal: AbortSignal; abort(reason?: any): void; }
interface AbortControllerConstructor { new (): AbortController; }
declare var AbortController: AbortControllerConstructor;
interface AbortSignal { aborted: boolean; reason: any; addEventListener(type: string, listener: (...args: any[]) => void): void; removeEventListener(type: string, listener: (...args: any[]) => void): void; }

interface ArrayBuffer { byteLength: number; slice(begin: number, end?: number): ArrayBuffer; }
interface ArrayBufferConstructor { new (byteLength: number): ArrayBuffer; }
declare var ArrayBuffer: ArrayBufferConstructor;

interface IterableIterator<T> { next(): IteratorResult<T>; [Symbol.iterator](): IterableIterator<T>; }
interface IteratorResult<T> { done?: boolean; value: T; }
interface Iterable<T> { [Symbol.iterator](): Iterator<T>; }
interface Iterator<T> { next(value?: any): IteratorResult<T>; return?(value?: any): IteratorResult<T>; }

interface SymbolConstructor {
  readonly iterator: unique symbol;
  readonly hasInstance: unique symbol;
  readonly toPrimitive: unique symbol;
}
declare var Symbol: SymbolConstructor;

type PropertyKey = string | number | symbol;
interface PropertyDescriptor { configurable?: boolean; enumerable?: boolean; value?: any; writable?: boolean; get?(): any; set?(v: any): void; }
interface PropertyDescriptorMap { [key: string]: PropertyDescriptor; }

type Partial<T> = { [P in keyof T]?: T[P] };
type Required<T> = { [P in keyof T]-?: T[P] };
type Readonly<T> = { readonly [P in keyof T]: T[P] };
type Record<K extends keyof any, T> = { [P in K]: T };
type Pick<T, K extends keyof T> = { [P in K]: T[P] };
type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
type Exclude<T, U> = T extends U ? never : T;
type Extract<T, U> = T extends U ? T : never;
type NonNullable<T> = T extends null | undefined ? never : T;
type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
type Parameters<T extends (...args: any) => any> = T extends (...args: infer P) => any ? P : never;
type InstanceType<T extends abstract new (...args: any) => any> = T extends abstract new (...args: any) => infer R ? R : any;
type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T;
type ArrayLike<T> = { length: number; [n: number]: T };
type ConstructorParameters<T extends abstract new (...args: any) => any> = T extends abstract new (...args: infer P) => any ? P : never;
type ThisParameterType<T> = T extends (this: infer U, ...args: never) => any ? U : unknown;
`

const REACT_SHIM = `
declare namespace React {
  type ReactNode = React.ReactElement | string | number | boolean | null | undefined | ReactNode[];
  type ReactElement = { type: any; props: any; key: any };
  type Key = string | number;
  type Ref<T> = ((instance: T | null) => void) | { current: T | null } | null;
  type RefObject<T> = { current: T | null };
  type FC<P = {}> = (props: P & { children?: ReactNode }) => ReactElement | null;
  type SetStateAction<S> = S | ((prevState: S) => S);
  type Dispatch<A> = (value: A) => void;
  type MutableRefObject<T> = { current: T };
  type DependencyList = readonly unknown[];
  type EffectCallback = () => (void | (() => void));
  type Reducer<S, A> = (prevState: S, action: A) => S;
  type ReducerState<R extends Reducer<any, any>> = R extends Reducer<infer S, any> ? S : never;
  type ReducerAction<R extends Reducer<any, any>> = R extends Reducer<any, infer A> ? A : never;
  function createElement(type: any, props?: any, ...children: any[]): ReactElement;
  const Fragment: any;
  function useState<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  function useEffect(effect: EffectCallback, deps?: DependencyList): void;
  function useMemo<T>(factory: () => T, deps: DependencyList): T;
  function useCallback<T extends (...args: any[]) => any>(callback: T, deps: DependencyList): T;
  function useRef<T>(initialValue: T): MutableRefObject<T>;
  function useRef<T>(initialValue: T | null): RefObject<T>;
  function useRef<T = undefined>(): MutableRefObject<T | undefined>;
  function useReducer<R extends Reducer<any, any>>(reducer: R, initialState: ReducerState<R>): [ReducerState<R>, Dispatch<ReducerAction<R>>];
  function useReducer<R extends Reducer<any, any>, I>(reducer: R, initialArg: I, init: (arg: I) => ReducerState<R>): [ReducerState<R>, Dispatch<ReducerAction<R>>];
}
`

const HAS_EXPORT = /\bexport\s+(default\b|function\b|const\b|class\b)/
const HAS_IMPORT = /\bimport\s+/

export function typecheckCanvasCode(
  code: string,
  fileName = 'canvas/surface.js',
): CanvasLintResult {
  const canvasGlobals = getCanvasGlobalsDts()
  if (!canvasGlobals) {
    return { ok: true, diagnostics: [] }
  }

  const isModule = HAS_EXPORT.test(code) || HAS_IMPORT.test(code)

  // Inline-mode code is evaluated as a function body (new Function(...)),
  // so top-level `return` is valid. Wrap it for TS to accept this.
  const wrappedCode = isModule ? code : `function __canvas__() {\n${code}\n}`
  const lineOffset = isModule ? 0 : 1

  const virtualFiles: Record<string, string> = {
    [fileName]: wrappedCode,
    'canvas-globals.d.ts': canvasGlobals,
    'lib.d.ts': LIB_DTS_CONTENT,
    'react-shim.d.ts': REACT_SHIM,
  }

  const host: ts.CompilerHost = {
    getSourceFile(name, languageVersion) {
      const content = virtualFiles[name]
      if (content !== undefined) {
        return ts.createSourceFile(name, content, languageVersion, true)
      }
      return undefined
    },
    writeFile: () => {},
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => false,
    getCanonicalFileName: (f) => f.toLowerCase(),
    getCurrentDirectory: () => '/',
    getNewLine: () => '\n',
    fileExists: (name) => name in virtualFiles,
    readFile: (name) => virtualFiles[name],
    directoryExists: () => true,
    getDirectories: () => [],
  }

  const program = ts.createProgram(
    [fileName, 'canvas-globals.d.ts', 'react-shim.d.ts'],
    COMPILER_OPTIONS,
    host,
  )

  let rawDiagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].filter(d => d.file?.fileName === fileName)

  if (isModule) {
    rawDiagnostics = rawDiagnostics.filter(d => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
      return !msg.startsWith('Cannot find module')
    })
  }

  const diagnostics: CanvasLintDiagnostic[] = rawDiagnostics.map(d => {
    let line = 0
    let col = 0
    if (d.file && d.start !== undefined) {
      const pos = ts.getLineAndCharacterOfPosition(d.file, d.start)
      line = pos.line + 1 - lineOffset
      col = pos.character
    }
    return {
      line,
      col,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      severity: d.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
    }
  })

  const errorCount = diagnostics.filter(d => d.severity === 'error').length
  return {
    ok: errorCount === 0,
    diagnostics,
  }
}
