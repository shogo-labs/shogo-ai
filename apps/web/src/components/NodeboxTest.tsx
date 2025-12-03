import { SandpackProvider, SandpackLayout, SandpackCodeEditor, SandpackConsole, SandpackPreview } from '@codesandbox/sandpack-react'

export function NodeboxTest() {
  return (
    <div style={{ margin: '2rem 0' }}>
      <h2>Unit 1: Nodebox Integration Test</h2>
      <p>Testing Node.js execution in the browser via Sandpack/Nodebox</p>

      <SandpackProvider
        template="node"
        options={{
          autorun: true,
          autoReload: true,
        }}
        files={{
          '/index.js': {
            code: `// Unit 1: Test 1 - Basic Node.js execution
console.log('✅ Node.js is running in the browser!');
console.log('Node version:', process.version);
console.log('Platform:', process.platform);

// Test 2: Virtual filesystem
const fs = require('fs');
console.log('\\n--- Testing Virtual Filesystem ---');
fs.writeFileSync('/test.txt', 'Hello from Nodebox!');
const content = fs.readFileSync('/test.txt', 'utf-8');
console.log('File content:', content);

// Test 3: Multiple file operations
fs.writeFileSync('/data.json', JSON.stringify({ test: true, count: 42 }));
const data = JSON.parse(fs.readFileSync('/data.json', 'utf-8'));
console.log('JSON data:', data);

// Test 4: Path operations
const path = require('path');
console.log('\\n--- Testing Path Module ---');
console.log('Join paths:', path.join('/foo', 'bar', 'baz.txt'));
console.log('Dirname:', path.dirname('/foo/bar/baz.txt'));
console.log('Basename:', path.basename('/foo/bar/baz.txt'));

// Test 5: Error handling
console.log('\\n--- Testing Error Handling ---');
try {
  throw new Error('This is a test error');
} catch (err) {
  console.error('Caught error:', err.message);
}

console.log('\\n✅ All basic tests passed!');
`,
          },
        }}
      >
        <SandpackLayout>
          <SandpackCodeEditor
            showLineNumbers
            showTabs
            style={{ height: '400px' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
            <SandpackPreview style={{ height: '400px', minHeight: 0 }} />
            <SandpackConsole
              showHeader
              showSyntaxError
              style={{ height: '400px', minHeight: 0 }}
            />
          </div>
        </SandpackLayout>
      </SandpackProvider>
    </div>
  )
}
