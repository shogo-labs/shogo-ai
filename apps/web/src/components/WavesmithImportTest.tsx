import { SandpackProvider, SandpackLayout, SandpackCodeEditor, SandpackConsole, SandpackFileExplorer, SandpackPreview } from '@codesandbox/sandpack-react'

export function WavesmithImportTest() {
  return (
    <div style={{ margin: '2rem 0' }}>
      <h2>Unit 1: Wavesmith Code Import Test</h2>
      <p>Testing ability to load and run wavesmith utilities in Nodebox</p>

      <SandpackProvider
        template="node"
        options={{
          autorun: true,
          autoReload: true,
        }}
        files={{
          '/index.js': {
            code: `// Testing wavesmith utility imports
console.log('🔍 Testing wavesmith code in Nodebox...');

// Simple inline utility test (simulating wavesmith pattern)
function createSchemaMetadata(name, version) {
  return {
    name,
    version,
    timestamp: Date.now(),
    type: 'enhanced-json-schema'
  };
}

const schema = createSchemaMetadata('test-schema', '1.0.0');
console.log('Schema metadata:', JSON.stringify(schema, null, 2));

// Test mobx-state-tree can be required
try {
  const mst = require('mobx-state-tree');
  console.log('✅ MST loaded successfully');
  console.log('MST has types:', typeof mst.types !== 'undefined');

  // Create simple MST model
  const User = mst.types.model({
    name: mst.types.string,
    age: mst.types.number
  });

  const user = User.create({ name: 'Test User', age: 30 });
  console.log('MST model created:', mst.getSnapshot(user));
} catch (err) {
  console.error('❌ Failed to load MST:', err.message);
}

// Test arktype
try {
  const { type } = require('arktype');
  console.log('✅ arktype loaded successfully');

  const userType = type({ name: 'string', age: 'number' });
  const result = userType({ name: 'Alice', age: 25 });
  console.log('arktype validation:', result);
} catch (err) {
  console.error('❌ Failed to load arktype:', err.message);
}

console.log('\\n✅ Wavesmith dependencies test complete!');
`,
          },
          '/package.json': {
            code: JSON.stringify({
              scripts: {
                start: 'node index.js'
              },
              dependencies: {
                'mobx-state-tree': '^6.0.1',
                'mobx': '^6.13.5',
                'arktype': '^2.0.0-beta.7'
              }
            }, null, 2),
          },
        }}
      >
        <SandpackLayout>
          <SandpackFileExplorer style={{ height: '400px' }} />
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
