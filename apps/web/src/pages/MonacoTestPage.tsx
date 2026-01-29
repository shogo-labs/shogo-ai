/**
 * Monaco TypeScript Test Page
 * 
 * Isolated test page for debugging TypeScript/TSX syntax highlighting
 * and intellisense issues in the Monaco editor.
 * 
 * Access at: /monaco-test
 * 
 * Tests:
 * 1. Monaco workers loading (required for syntax highlighting)
 * 2. TypeScript language service configuration
 * 3. LSP WebSocket connection (optional - for full intellisense)
 * 4. JSX/TSX syntax highlighting
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import Editor, { type Monaco, loader } from '@monaco-editor/react'
import type * as monacoType from 'monaco-editor'

// Test code samples
const TEST_SAMPLES = {
  typescript: `// TypeScript Test
interface User {
  id: number
  name: string
  email: string
}

function greet(user: User): string {
  return \`Hello, \${user.name}!\`
}

const user: User = {
  id: 1,
  name: 'Test User',
  email: 'test@example.com'
}

console.log(greet(user))
`,
  tsx: `// TSX/React Test
import React, { useState, useEffect } from 'react'

interface ButtonProps {
  label: string
  onClick: () => void
  variant?: 'primary' | 'secondary'
}

export function Button({ label, onClick, variant = 'primary' }: ButtonProps) {
  const [isHovered, setIsHovered] = useState(false)

  useEffect(() => {
    console.log('Button mounted')
    return () => console.log('Button unmounted')
  }, [])

  return (
    <button
      className={\`btn btn-\${variant} \${isHovered ? 'hovered' : ''}\`}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {label}
    </button>
  )
}

export default function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="app">
      <h1>Counter: {count}</h1>
      <Button 
        label="Increment" 
        onClick={() => setCount(c => c + 1)} 
        variant="primary"
      />
    </div>
  )
}
`,
  javascript: `// JavaScript Test
const multiply = (a, b) => a * b

function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

const cart = [
  { name: 'Apple', price: 1.5, quantity: 4 },
  { name: 'Banana', price: 0.75, quantity: 6 },
]

console.log('Total:', calculateTotal(cart))
`,
}

interface DiagnosticInfo {
  workersLoaded: boolean | null
  typescriptWorkerLoaded: boolean | null
  monacoVersion: string | null
  languageServiceReady: boolean | null
  lspStatus: 'disconnected' | 'connecting' | 'connected' | 'error'
  lspError: string | null
  compilerOptions: Record<string, unknown> | null
  registeredLanguages: string[]
  markers: monacoType.editor.IMarker[]
}

export function MonacoTestPage() {
  const [selectedLanguage, setSelectedLanguage] = useState<'typescript' | 'tsx' | 'javascript'>('tsx')
  const [code, setCode] = useState(TEST_SAMPLES.tsx)
  const [diagnostics, setDiagnostics] = useState<DiagnosticInfo>({
    workersLoaded: null,
    typescriptWorkerLoaded: null,
    monacoVersion: null,
    languageServiceReady: null,
    lspStatus: 'disconnected',
    lspError: null,
    compilerOptions: null,
    registeredLanguages: [],
    markers: [],
  })
  const [logs, setLogs] = useState<string[]>([])
  const [directLspUrl, setDirectLspUrl] = useState('ws://localhost:8081/lsp')
  
  const monacoRef = useRef<Monaco | null>(null)
  const editorRef = useRef<monacoType.editor.IStandaloneCodeEditor | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setLogs(prev => [...prev.slice(-50), `[${timestamp}] ${message}`])
    console.log(`[Monaco Test] ${message}`)
  }, [])

  // Check Monaco worker status
  const checkWorkerStatus = useCallback(async (monaco: Monaco) => {
    addLog('Checking Monaco worker status...')
    
    try {
      // Check TypeScript worker by creating a model and requesting diagnostics
      // Use a unique URI to avoid conflicts with React Strict Mode double-renders
      const testUri = monaco.Uri.parse(`file:///test-worker-${Date.now()}.ts`)
      
      // Clean up any existing test models first
      const existingModels = monaco.editor.getModels()
      existingModels.forEach(model => {
        if (model.uri.path.startsWith('/test-worker-')) {
          model.dispose()
        }
      })
      
      const testModel = monaco.editor.createModel(
        'const x: string = 123;', // This should produce a type error
        'typescript',
        testUri
      )

      // Get TypeScript worker - use type assertion for the deprecated API
      const tsLanguages = monaco.languages.typescript as any
      const tsWorker = await tsLanguages.getTypeScriptWorker()
      if (tsWorker) {
        const client = await tsWorker(testModel.uri)
        if (client) {
          addLog('TypeScript worker is responding')
          
          // Try to get diagnostics
          const semanticDiagnostics = await client.getSemanticDiagnostics(testModel.uri.toString())
          const syntaxDiagnostics = await client.getSyntacticDiagnostics(testModel.uri.toString())
          
          addLog(`Semantic diagnostics: ${semanticDiagnostics?.length ?? 0}`)
          addLog(`Syntax diagnostics: ${syntaxDiagnostics?.length ?? 0}`)
          
          setDiagnostics(prev => ({
            ...prev,
            typescriptWorkerLoaded: true,
            languageServiceReady: true,
          }))
        }
      } else {
        addLog('TypeScript worker not available')
        setDiagnostics(prev => ({
          ...prev,
          typescriptWorkerLoaded: false,
        }))
      }

      testModel.dispose()
    } catch (error) {
      addLog(`Worker check error: ${error}`)
      setDiagnostics(prev => ({
        ...prev,
        typescriptWorkerLoaded: false,
        languageServiceReady: false,
      }))
    }
  }, [addLog])

  // Configure Monaco before mount
  const handleEditorWillMount = useCallback((monaco: Monaco) => {
    addLog('Monaco will mount - configuring...')
    monacoRef.current = monaco

    // Access TypeScript language features through type assertion (API marked deprecated but still works)
    const tsLanguages = monaco.languages.typescript as any

    setDiagnostics(prev => ({
      ...prev,
      monacoVersion: 'monaco-editor',
      workersLoaded: true,
      registeredLanguages: monaco.languages.getLanguages().map(l => l.id),
    }))

    // Configure TypeScript/JavaScript compiler options
    const compilerOptions = {
      target: tsLanguages.ScriptTarget.ESNext,
      allowNonTsExtensions: true,
      moduleResolution: tsLanguages.ModuleResolutionKind.NodeJs,
      module: tsLanguages.ModuleKind.ESNext,
      noEmit: true,
      esModuleInterop: true,
      jsx: tsLanguages.JsxEmit.ReactJSX,
      reactNamespace: 'React',
      allowJs: true,
      typeRoots: ['node_modules/@types'],
      strict: true,
      allowSyntheticDefaultImports: true,
    }

    tsLanguages.typescriptDefaults.setCompilerOptions(compilerOptions)
    tsLanguages.javascriptDefaults.setCompilerOptions({
      ...compilerOptions,
      allowJs: true,
      checkJs: false,
    })

    // Enable diagnostics (not disabled like in production)
    tsLanguages.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    })

    setDiagnostics(prev => ({
      ...prev,
      compilerOptions: compilerOptions as unknown as Record<string, unknown>,
    }))

    addLog('TypeScript compiler options configured')

    // Add React type stubs
    const reactTypes = `
declare module 'react' {
  export function useState<T>(initialState: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void];
  export function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: unknown[]): T;
  export function useRef<T>(initialValue: T): { current: T };
  export function useMemo<T>(factory: () => T, deps: unknown[]): T;
  export const Fragment: unique symbol;
  export type ReactNode = string | number | boolean | null | undefined | ReactElement | ReactNode[];
  export interface ReactElement<P = any> {
    type: string | ((props: P) => ReactElement);
    props: P;
    key: string | number | null;
  }
}

declare namespace JSX {
  interface Element extends React.ReactElement<any, any> { }
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
`
    tsLanguages.typescriptDefaults.addExtraLib(reactTypes, 'file:///node_modules/@types/react/index.d.ts')
    addLog('Added React type stubs')
  }, [addLog])

  // Handle editor mount
  const handleEditorDidMount = useCallback((editor: monacoType.editor.IStandaloneCodeEditor, monaco: Monaco) => {
    addLog('Monaco editor mounted')
    editorRef.current = editor
    monacoRef.current = monaco

    // Check worker status
    checkWorkerStatus(monaco)

    // Listen for marker changes
    const disposable = monaco.editor.onDidChangeMarkers((uris) => {
      const model = editor.getModel()
      if (model) {
        const markers = monaco.editor.getModelMarkers({ resource: model.uri })
        setDiagnostics(prev => ({ ...prev, markers }))
        if (markers.length > 0) {
          addLog(`Markers updated: ${markers.length} diagnostic(s)`)
        }
      }
    })

    return () => disposable.dispose()
  }, [addLog, checkWorkerStatus])

  // Test LSP connection
  const testLspConnection = useCallback(async () => {
    addLog('Testing LSP connection...')
    setDiagnostics(prev => ({ ...prev, lspStatus: 'connecting', lspError: null }))

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    try {
      // First, check if we can reach the LSP endpoint info
      const response = await fetch('/api/projects/test/runtime/status')
      if (!response.ok) {
        throw new Error(`Runtime status check failed: ${response.status}`)
      }

      const data = await response.json()
      addLog(`Runtime status: ${data.status}, URL: ${data.url || 'N/A'}`)

      if (data.status !== 'running' || !data.url) {
        throw new Error('No running project runtime found. LSP requires an active project.')
      }

      // Try to connect to the LSP WebSocket
      const runtimeUrl = new URL(data.url)
      const wsProtocol = runtimeUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${wsProtocol}//${runtimeUrl.host}/lsp`

      addLog(`Connecting to LSP WebSocket: ${wsUrl}`)

      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        addLog('LSP WebSocket connected!')
        setDiagnostics(prev => ({ ...prev, lspStatus: 'connected' }))
        
        // Send initialize request
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            processId: null,
            rootUri: 'file:///test',
            capabilities: {},
          },
        }))
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          addLog(`LSP response: ${JSON.stringify(message).slice(0, 200)}...`)
        } catch {
          addLog(`LSP raw message: ${event.data.slice(0, 200)}...`)
        }
      }

      ws.onerror = (error) => {
        addLog(`LSP WebSocket error: ${error}`)
        setDiagnostics(prev => ({
          ...prev,
          lspStatus: 'error',
          lspError: 'WebSocket connection failed',
        }))
      }

      ws.onclose = (event) => {
        addLog(`LSP WebSocket closed: code=${event.code}, reason=${event.reason}`)
        setDiagnostics(prev => ({
          ...prev,
          lspStatus: 'disconnected',
        }))
      }
    } catch (error: any) {
      addLog(`LSP connection error: ${error.message}`)
      setDiagnostics(prev => ({
        ...prev,
        lspStatus: 'error',
        lspError: error.message,
      }))
    }
  }, [addLog])

  // Test direct LSP WebSocket connection (bypasses API)
  const testDirectLspConnection = useCallback(async () => {
    addLog(`Testing direct LSP connection to: ${directLspUrl}`)
    setDiagnostics(prev => ({ ...prev, lspStatus: 'connecting', lspError: null }))

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    try {
      const ws = new WebSocket(directLspUrl)
      wsRef.current = ws

      ws.onopen = () => {
        addLog('LSP WebSocket connected!')
        setDiagnostics(prev => ({ ...prev, lspStatus: 'connected' }))
        
        // Send initialize request
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            processId: null,
            rootUri: 'file:///tmp/monaco-test-project',
            rootPath: '/tmp/monaco-test-project',
            capabilities: {
              textDocument: {
                completion: { completionItem: { snippetSupport: true } },
                hover: { contentFormat: ['markdown', 'plaintext'] },
              },
            },
          },
        }))
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          addLog(`LSP response: ${JSON.stringify(message).slice(0, 300)}...`)
          
          // If initialize response, send initialized notification
          if (message.id === 1 && message.result) {
            addLog('LSP initialized! Sending initialized notification...')
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              method: 'initialized',
              params: {},
            }))
            
            // Open a test document
            setTimeout(() => {
              addLog('Opening test document...')
              ws.send(JSON.stringify({
                jsonrpc: '2.0',
                method: 'textDocument/didOpen',
                params: {
                  textDocument: {
                    uri: 'file:///tmp/monaco-test-project/src/App.tsx',
                    languageId: 'typescriptreact',
                    version: 1,
                    text: code,
                  },
                },
              }))
            }, 100)
          }
        } catch {
          addLog(`LSP raw message: ${event.data.slice(0, 200)}...`)
        }
      }

      ws.onerror = (error) => {
        addLog(`LSP WebSocket error: ${error}`)
        setDiagnostics(prev => ({
          ...prev,
          lspStatus: 'error',
          lspError: 'WebSocket connection failed',
        }))
      }

      ws.onclose = (event) => {
        addLog(`LSP WebSocket closed: code=${event.code}, reason=${event.reason}`)
        setDiagnostics(prev => ({
          ...prev,
          lspStatus: 'disconnected',
        }))
      }
    } catch (error: any) {
      addLog(`Direct LSP connection error: ${error.message}`)
      setDiagnostics(prev => ({
        ...prev,
        lspStatus: 'error',
        lspError: error.message,
      }))
    }
  }, [addLog, directLspUrl, code])

  // Switch language sample
  const handleLanguageChange = (lang: 'typescript' | 'tsx' | 'javascript') => {
    setSelectedLanguage(lang)
    setCode(TEST_SAMPLES[lang])
    addLog(`Switched to ${lang}`)
  }

  // Force refresh Monaco
  const handleRefreshEditor = useCallback(() => {
    addLog('Forcing Monaco refresh...')
    // Force re-render by clearing and resetting code
    const currentCode = code
    setCode('')
    setTimeout(() => setCode(currentCode), 100)
  }, [code, addLog])

  // Check webpack/vite worker paths
  useEffect(() => {
    addLog('Checking worker configuration...')
    
    // Check if Monaco environment is configured
    const monacoEnv = (window as any).MonacoEnvironment
    if (monacoEnv) {
      addLog(`MonacoEnvironment found: getWorkerUrl=${!!monacoEnv.getWorkerUrl}, getWorker=${!!monacoEnv.getWorker}`)
    } else {
      addLog('MonacoEnvironment not configured (may be handled by vite-plugin-monaco-editor)')
    }

    // Note: loader.config() returns void, so we just check MonacoEnvironment
    addLog('Monaco loader: using vite-plugin-monaco-editor bundled workers')
  }, [addLog])

  // Cleanup
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [])

  const getStatusColor = (status: boolean | null) => {
    if (status === null) return 'bg-gray-500'
    return status ? 'bg-green-500' : 'bg-red-500'
  }

  const getLspStatusColor = (status: string) => {
    switch (status) {
      case 'connected': return 'bg-green-500'
      case 'connecting': return 'bg-yellow-500'
      case 'error': return 'bg-red-500'
      default: return 'bg-gray-500'
    }
  }

  return (
    <div className="min-h-screen bg-[#1e1e1e] text-white p-4">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold mb-4">Monaco TypeScript Test Page</h1>
        <p className="text-gray-400 mb-6">
          Isolated test for debugging syntax highlighting and intellisense issues.
        </p>

        {/* Diagnostic Panel */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          {/* Status Indicators */}
          <div className="bg-[#252526] rounded-lg p-4">
            <h2 className="text-lg font-semibold mb-3">Status</h2>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${getStatusColor(diagnostics.workersLoaded)}`} />
                <span>Monaco Workers: {diagnostics.workersLoaded === null ? 'Checking...' : diagnostics.workersLoaded ? 'Loaded' : 'Failed'}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${getStatusColor(diagnostics.typescriptWorkerLoaded)}`} />
                <span>TS Worker: {diagnostics.typescriptWorkerLoaded === null ? 'Checking...' : diagnostics.typescriptWorkerLoaded ? 'Active' : 'Failed'}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${getStatusColor(diagnostics.languageServiceReady)}`} />
                <span>Language Service: {diagnostics.languageServiceReady === null ? 'Checking...' : diagnostics.languageServiceReady ? 'Ready' : 'Failed'}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${getLspStatusColor(diagnostics.lspStatus)}`} />
                <span>LSP: {diagnostics.lspStatus}{diagnostics.lspError ? ` (${diagnostics.lspError})` : ''}</span>
              </div>
            </div>
          </div>

          {/* Compiler Options */}
          <div className="bg-[#252526] rounded-lg p-4">
            <h2 className="text-lg font-semibold mb-3">Compiler Options</h2>
            <pre className="text-xs text-gray-400 overflow-auto max-h-40">
              {diagnostics.compilerOptions
                ? JSON.stringify(diagnostics.compilerOptions, null, 2)
                : 'Not configured yet...'}
            </pre>
          </div>

          {/* Diagnostics/Markers */}
          <div className="bg-[#252526] rounded-lg p-4">
            <h2 className="text-lg font-semibold mb-3">
              Diagnostics ({diagnostics.markers.length})
            </h2>
            <div className="text-xs space-y-1 max-h-40 overflow-auto">
              {diagnostics.markers.length === 0 ? (
                <p className="text-gray-500">No diagnostics</p>
              ) : (
                diagnostics.markers.map((marker, i) => (
                  <div key={i} className={`p-1 rounded ${
                    marker.severity === 8 ? 'bg-red-900/50' :
                    marker.severity === 4 ? 'bg-yellow-900/50' :
                    'bg-blue-900/50'
                  }`}>
                    <span className="text-gray-400">L{marker.startLineNumber}:</span> {marker.message}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="flex gap-1">
            {(['typescript', 'tsx', 'javascript'] as const).map(lang => (
              <button
                key={lang}
                onClick={() => handleLanguageChange(lang)}
                className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
                  selectedLanguage === lang
                    ? 'bg-blue-600 text-white'
                    : 'bg-[#3c3c3c] text-gray-300 hover:bg-[#4c4c4c]'
                }`}
              >
                {lang.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            onClick={handleRefreshEditor}
            className="px-4 py-2 rounded text-sm font-medium bg-[#3c3c3c] text-gray-300 hover:bg-[#4c4c4c]"
          >
            Refresh Editor
          </button>
          <button
            onClick={testLspConnection}
            className="px-4 py-2 rounded text-sm font-medium bg-purple-600 text-white hover:bg-purple-700"
          >
            Test LSP (via API)
          </button>
        </div>

        {/* Direct LSP Connection Test */}
        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <label className="text-sm text-gray-400">Direct LSP URL:</label>
          <input
            type="text"
            value={directLspUrl}
            onChange={(e) => setDirectLspUrl(e.target.value)}
            className="px-3 py-2 rounded text-sm bg-[#3c3c3c] text-white border border-[#555] w-64"
            placeholder="ws://localhost:8081/lsp"
          />
          <button
            onClick={testDirectLspConnection}
            className="px-4 py-2 rounded text-sm font-medium bg-green-600 text-white hover:bg-green-700"
          >
            Connect Direct
          </button>
        </div>

        {/* Editor and Logs */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Monaco Editor */}
          <div className="lg:col-span-2 bg-[#1e1e1e] rounded-lg overflow-hidden border border-[#3c3c3c]">
            <div className="bg-[#252526] px-3 py-2 text-sm text-gray-400 border-b border-[#3c3c3c]">
              {selectedLanguage === 'tsx' ? 'App.tsx' : selectedLanguage === 'typescript' ? 'test.ts' : 'test.js'}
            </div>
            <Editor
              height="500px"
              path={selectedLanguage === 'tsx' ? 'App.tsx' : selectedLanguage === 'typescript' ? 'test.ts' : 'test.js'}
              language={selectedLanguage === 'tsx' ? 'typescript' : selectedLanguage}
              value={code}
              theme="vs-dark"
              onChange={(value) => setCode(value || '')}
              beforeMount={handleEditorWillMount}
              onMount={handleEditorDidMount}
              options={{
                minimap: { enabled: true },
                fontSize: 14,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: 'on',
                padding: { top: 8 },
                tabSize: 2,
              }}
              loading={
                <div className="flex items-center justify-center h-full text-gray-400">
                  Loading Monaco Editor...
                </div>
              }
            />
          </div>

          {/* Logs */}
          <div className="bg-[#252526] rounded-lg p-4">
            <h2 className="text-lg font-semibold mb-3">Logs</h2>
            <div className="text-xs font-mono space-y-1 max-h-[500px] overflow-auto bg-[#1e1e1e] p-2 rounded">
              {logs.length === 0 ? (
                <p className="text-gray-500">No logs yet...</p>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="text-gray-400 break-all">
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Registered Languages */}
        <div className="mt-4 bg-[#252526] rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-3">Registered Languages</h2>
          <div className="flex flex-wrap gap-2">
            {diagnostics.registeredLanguages.map(lang => (
              <span
                key={lang}
                className={`px-2 py-1 rounded text-xs ${
                  ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'].includes(lang)
                    ? 'bg-blue-600'
                    : 'bg-[#3c3c3c]'
                }`}
              >
                {lang}
              </span>
            ))}
          </div>
        </div>

        {/* Instructions */}
        <div className="mt-4 bg-[#252526] rounded-lg p-4 text-sm text-gray-400">
          <h2 className="text-lg font-semibold mb-3 text-white">Debugging Guide</h2>
          <ol className="list-decimal list-inside space-y-2">
            <li>
              <strong>Check Status Indicators:</strong> All should be green for proper functionality.
            </li>
            <li>
              <strong>Syntax Highlighting:</strong> Keywords (const, function, interface) should be colored.
              JSX tags should have different colors from regular code.
            </li>
            <li>
              <strong>Hover Info:</strong> Hover over variables/functions to see type information.
            </li>
            <li>
              <strong>Diagnostics:</strong> The TSX code has intentional type usage - you should see proper
              TypeScript-aware highlighting even without full LSP.
            </li>
            <li>
              <strong>LSP Connection:</strong> Click "Test LSP Connection" to check if the TypeScript
              language server is accessible (requires a running project runtime).
            </li>
            <li>
              <strong>Console Errors:</strong> Check browser DevTools console for worker loading errors.
            </li>
          </ol>
        </div>
      </div>
    </div>
  )
}

export default MonacoTestPage
