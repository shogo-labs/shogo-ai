import { SandpackProvider, SandpackLayout, SandpackCodeEditor, SandpackConsole, SandpackPreview } from '@codesandbox/sandpack-react'
import { useState } from 'react'

export function ErrorHandlingTest() {
  const [activeTest, setActiveTest] = useState<'success' | 'runtime' | 'syntax'>('success')

  const testCases = {
    success: `// Test: Successful execution with various console outputs
console.log('📋 Regular log message');
console.info('ℹ️ Info message');
console.warn('⚠️ Warning message');
console.error('❌ Error message (but not thrown)');

console.log('\\n--- Object logging ---');
console.log({ name: 'Test', value: 42, nested: { deep: true } });

console.log('\\n--- Array logging ---');
console.log([1, 2, 3, { id: 'test' }]);

console.log('\\n✅ All console outputs working!');
`,
    runtime: `// Test: Runtime error handling
console.log('Starting execution...');

// This will throw a runtime error
const obj = null;
console.log('Accessing null property...');
obj.nonexistent.property; // TypeError

console.log('This should not execute');
`,
    syntax: `// Test: Syntax error handling
console.log('This has a syntax error');

// Unclosed string literal
const broken = 'unclosed string

console.log('This will not parse');
`,
  }

  return (
    <div style={{ margin: '2rem 0' }}>
      <h2>Unit 1: Error Handling & Console Test</h2>
      <p>Testing console output types and error scenarios</p>

      <div style={{ marginBottom: '1rem' }}>
        <button
          onClick={() => setActiveTest('success')}
          style={{
            padding: '0.5rem 1rem',
            marginRight: '0.5rem',
            background: activeTest === 'success' ? '#4CAF50' : '#666',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          ✅ Success Case
        </button>
        <button
          onClick={() => setActiveTest('runtime')}
          style={{
            padding: '0.5rem 1rem',
            marginRight: '0.5rem',
            background: activeTest === 'runtime' ? '#FF9800' : '#666',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          ⚠️ Runtime Error
        </button>
        <button
          onClick={() => setActiveTest('syntax')}
          style={{
            padding: '0.5rem 1rem',
            background: activeTest === 'syntax' ? '#F44336' : '#666',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          ❌ Syntax Error
        </button>
      </div>

      <SandpackProvider
        key={activeTest}
        template="node"
        options={{
          autorun: true,
          autoReload: true,
        }}
        files={{
          '/index.js': {
            code: testCases[activeTest],
          },
        }}
      >
        <SandpackLayout>
          <SandpackCodeEditor
            showLineNumbers
            readOnly
            style={{ height: '300px' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
            <SandpackPreview style={{ height: '300px', minHeight: 0 }} />
            <SandpackConsole
              showHeader
              showSyntaxError
              showSetupProgress
              style={{ height: '300px', minHeight: 0 }}
            />
          </div>
        </SandpackLayout>
      </SandpackProvider>
    </div>
  )
}
