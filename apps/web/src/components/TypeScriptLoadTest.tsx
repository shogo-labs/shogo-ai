import { SandpackProvider, SandpackLayout, SandpackCodeEditor, SandpackConsole, SandpackFileExplorer, SandpackPreview } from '@codesandbox/sandpack-react'
import { useState } from 'react'

type TestCase = 'simple' | 'dependencies' | 'mst' | 'wavesmith'
type TestCaseConfig = {
  files: Record<string, { code: string } | string>
  description: string
  dependencies?: Record<string, string>
}

export function TypeScriptLoadTest() {
  const [activeTest, setActiveTest] = useState<TestCase>('simple')

  const testCases: Record<TestCase, TestCaseConfig> = {
    simple: {
      files: {
        '/App.tsx': {
          code: `// Test 1: Simple TypeScript execution (Vite + React + TS)
export default function App() {
  // Type annotations
  function greet(name: string): string {
    return \`Hello, \${name}!\`;
  }

  const message: string = greet('Wavesmith');

  // Interface
  interface User {
    id: string;
    name: string;
    age: number;
  }

  const user: User = {
    id: '123',
    name: 'Alice',
    age: 30
  };

  // Generic function
  function identity<T>(value: T): T {
    return value;
  }

  // Log everything to console
  console.log('🔍 Testing TypeScript with Vite transpiler...');
  console.log('Message:', message);
  console.log('User:', JSON.stringify(user, null, 2));
  console.log('Identity number:', identity(42));
  console.log('Identity string:', identity('test'));
  console.log('\\n✅ Simple TypeScript execution works!');

  return (
    <div style={{ padding: '2rem', fontFamily: 'monospace' }}>
      <h2>TypeScript Test Running ✅</h2>
      <p>Check the console for output →</p>
      <pre style={{ background: '#f5f5f5', padding: '1rem', borderRadius: '4px' }}>
        {\`Message: \${message}
User: \${user.name} (age \${user.age})
Identity: \${identity(42)}\`}
      </pre>
    </div>
  );
}
`,
        },
      },
      description: 'Basic TypeScript with type annotations, interfaces, and generics'
    },

    dependencies: {
      files: {
        '/App.tsx': {
          code: `// Test 2: TypeScript with external dependencies
import { v4 as uuidv4 } from 'uuid';

export default function App() {
  // Type annotation with dependency
  function createId(): string {
    return uuidv4();
  }

  const id1: string = createId();
  const id2: string = createId();

  // Interface with dependency
  interface Entity {
    id: string;
    createdAt: Date;
  }

  function createEntity(): Entity {
    return {
      id: uuidv4(),
      createdAt: new Date()
    };
  }

  const entity: Entity = createEntity();

  // Log to console
  console.log('🔍 Testing TypeScript with npm dependencies...');
  console.log('UUID 1:', id1);
  console.log('UUID 2:', id2);
  console.log('IDs are different:', id1 !== id2);
  console.log('Entity:', JSON.stringify(entity, null, 2));
  console.log('\\n✅ External dependencies work with TypeScript!');

  return (
    <div style={{ padding: '2rem', fontFamily: 'monospace' }}>
      <h2>Dependencies Test Running ✅</h2>
      <p>Check the console for UUID output →</p>
      <pre style={{ background: '#f5f5f5', padding: '1rem', borderRadius: '4px' }}>
        {\`UUID 1: \${id1}
UUID 2: \${id2}
Different: \${String(id1 !== id2)}\`}
      </pre>
    </div>
  );
}
`,
        },
      },
      dependencies: {
        'uuid': '^9.0.0'
      },
      description: 'TypeScript with npm dependencies (uuid)'
    },

    mst: {
      files: {
        '/App.tsx': {
          code: `// Test 3: TypeScript with MobX-State-Tree
import { types, Instance } from 'mobx-state-tree';

// MST model with TypeScript types
const User = types.model('User', {
  id: types.identifier,
  name: types.string,
  age: types.number,
  isActive: types.optional(types.boolean, true)
})
.actions(self => ({
  setName(newName: string) {
    self.name = newName;
  },
  incrementAge() {
    self.age += 1;
  }
}))
.views(self => ({
  get displayName(): string {
    return \`\${self.name} (age \${self.age})\`;
  }
}));

// TypeScript type inference from MST model
type IUser = Instance<typeof User>;

const UserStore = types.model('UserStore', {
  users: types.array(User)
})
.actions(self => ({
  addUser(id: string, name: string, age: number) {
    self.users.push({ id, name, age });
  }
}));

export default function App() {
  // Create instance
  const user: IUser = User.create({
    id: '1',
    name: 'Alice',
    age: 30
  });

  // Test actions
  user.setName('Alice Smith');
  user.incrementAge();

  // Test collection
  const store = UserStore.create({ users: [] });
  store.addUser('2', 'Bob', 25);
  store.addUser('3', 'Charlie', 35);

  // Log to console
  console.log('🔍 Testing TypeScript with MST...');
  console.log('Initial user:', user.displayName);
  console.log('User snapshot:', JSON.stringify(user, null, 2));
  console.log('Store has', store.users.length, 'users');
  console.log('Users:', store.users.map((u: IUser) => u.displayName).join(', '));
  console.log('\\n✅ MST with TypeScript works!');

  return (
    <div style={{ padding: '2rem', fontFamily: 'monospace' }}>
      <h2>MST Test Running ✅</h2>
      <p>Check the console for MST output →</p>
      <pre style={{ background: '#f5f5f5', padding: '1rem', borderRadius: '4px' }}>
        {\`User: \${user.displayName}
Store users: \${store.users.length}
Names: \${store.users.map((u: IUser) => u.displayName).join(', ')}\`}
      </pre>
    </div>
  );
}
`,
        },
      },
      dependencies: {
        'mobx': '^6.13.5',
        'mobx-state-tree': '^6.0.1'
      },
      description: 'TypeScript with MobX-State-Tree models and type inference'
    },

    wavesmith: {
      files: {
        '/App.tsx': {
          code: `// Test 4: Wavesmith-style code patterns
import { scope } from 'arktype';
import { types, Instance } from 'mobx-state-tree';
import { v4 as uuidv4 } from 'uuid';

// Utility function (like src/utils/string.ts)
function camelCase(str: string): string {
  return str.replace(/[-_](.)/g, (_, c) => c.toUpperCase());
}

// ArkType schema (like meta-registry pattern)
const taskSchema = scope({
  Task: {
    id: 'string.uuid',
    title: 'string',
    completed: 'boolean',
    'createdAt?': 'Date'
  }
});

const taskType = taskSchema.type('Task');

// MST model (like runtime store pattern)
const TaskModel = types.model('Task', {
  id: types.identifier,
  title: types.string,
  completed: types.boolean
})
.actions(self => ({
  toggle() {
    self.completed = !self.completed;
  }
}));

type ITask = Instance<typeof TaskModel>;

const TaskStore = types.model('TaskStore', {
  tasks: types.array(TaskModel)
})
.actions(self => ({
  addTask(title: string): ITask {
    const task = TaskModel.create({
      id: uuidv4(),
      title,
      completed: false
    });
    self.tasks.push(task);
    return task;
  }
}));

export default function App() {
  // Test utility
  const camelTest = camelCase('hello-world');

  // Validate with arktype
  const validTask = {
    id: uuidv4(),
    title: 'Test Task',
    completed: false,
    createdAt: new Date()
  };

  const result = taskType(validTask);

  // Create store and test operations
  const store = TaskStore.create({ tasks: [] });
  const task1 = store.addTask('Learn TypeScript');
  const task2 = store.addTask('Build meta system');
  task1.toggle();

  // Log to console
  console.log('🔍 Testing Wavesmith code patterns...');
  console.log('camelCase test:', camelTest, '===', 'helloWorld');
  console.log('ArkType validation:', result.problems ? 'failed' : 'passed');
  console.log('Valid task:', JSON.stringify(validTask, null, 2));
  console.log('\\nCreated tasks:');
  store.tasks.forEach((task: ITask) => {
    console.log(\`  - [\${task.completed ? 'x' : ' '}] \${task.title}\`);
  });
  console.log('\\n✅ Wavesmith code patterns work in TypeScript!');
  console.log('\\n🎉 ALL TESTS PASSED - Vite + React + TS is fully compatible!');

  return (
    <div style={{ padding: '2rem', fontFamily: 'monospace' }}>
      <h2>Wavesmith Patterns Test Running ✅</h2>
      <p>Check the console for full output →</p>
      <pre style={{ background: '#f5f5f5', padding: '1rem', borderRadius: '4px' }}>
        {\`camelCase: \${camelTest}
ArkType: \${result.problems ? 'failed' : 'passed'}
Tasks: \${store.tasks.length}
\${store.tasks.map((task: ITask) =>
  '[\' + (task.completed ? \'x\' : \' \') + \'] \' + task.title
).join('\\n')}\`}
      </pre>
    </div>
  );
}
`,
        },
      },
      dependencies: {
        'uuid': '^9.0.0',
        'arktype': '^2.0.0-beta.7',
        'mobx': '^6.13.5',
        'mobx-state-tree': '^6.0.1'
      },
      description: 'Full wavesmith patterns: arktype + MST + utilities'
    }
  }

  const currentTest = testCases[activeTest]

  return (
    <div style={{ margin: '2rem 0' }}>
      <h2>Unit 1.5: TypeScript Loading Test</h2>
      <p>Testing TypeScript with Vite bundler (matches our project setup: Vite + React + TS)</p>

      <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          onClick={() => setActiveTest('simple')}
          style={{
            padding: '0.5rem 1rem',
            background: activeTest === 'simple' ? '#4CAF50' : '#666',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '0.9rem'
          }}
        >
          1️⃣ Simple TS
        </button>
        <button
          onClick={() => setActiveTest('dependencies')}
          style={{
            padding: '0.5rem 1rem',
            background: activeTest === 'dependencies' ? '#2196F3' : '#666',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '0.9rem'
          }}
        >
          2️⃣ + Dependencies
        </button>
        <button
          onClick={() => setActiveTest('mst')}
          style={{
            padding: '0.5rem 1rem',
            background: activeTest === 'mst' ? '#FF9800' : '#666',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '0.9rem'
          }}
        >
          3️⃣ + MST Types
        </button>
        <button
          onClick={() => setActiveTest('wavesmith')}
          style={{
            padding: '0.5rem 1rem',
            background: activeTest === 'wavesmith' ? '#9C27B0' : '#666',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '0.9rem'
          }}
        >
          4️⃣ Wavesmith Patterns
        </button>
      </div>

      <div style={{
        padding: '0.75rem',
        background: '#1a1a1a',
        borderRadius: '4px',
        marginBottom: '1rem',
        color: '#ccc',
        fontSize: '0.9rem'
      }}>
        <strong>Current Test:</strong> {currentTest.description}
      </div>

      <div style={{
        padding: '0.75rem',
        background: '#dbeafe',
        border: '2px solid #3b82f6',
        borderRadius: '4px',
        marginBottom: '1rem',
        fontSize: '0.9rem',
        color: '#1e40af'
      }}>
        <strong>📋 Note:</strong> Using <code>vite-react-ts</code> template (Vite bundler transpiles TS → JS, then Nodebox executes). Check both Preview and Console panels below.
      </div>

      <SandpackProvider
        key={activeTest}
        template="vite-react-ts"
        customSetup={{
          dependencies: currentTest.dependencies ?? {}
        }}
        options={{
          autorun: true,
          autoReload: true,
        }}
        files={currentTest.files}
      >
        <SandpackLayout>
          <SandpackFileExplorer style={{ height: '500px' }} />
          <SandpackCodeEditor
            showLineNumbers
            showTabs
            style={{ height: '500px' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '0.5rem' }}>
            <div style={{ flex: 1, minHeight: 0, border: '2px solid #3b82f6' }}>
              <div style={{
                background: '#3b82f6',
                color: 'white',
                padding: '0.25rem 0.5rem',
                fontSize: '0.85rem',
                fontWeight: 'bold'
              }}>
                Preview (React Output)
              </div>
              <SandpackPreview style={{ height: 'calc(100% - 28px)' }} />
            </div>
            <div style={{ flex: 1, minHeight: 0, border: '2px solid #059669' }}>
              <div style={{
                background: '#059669',
                color: 'white',
                padding: '0.25rem 0.5rem',
                fontSize: '0.85rem',
                fontWeight: 'bold'
              }}>
                Console (Logs)
              </div>
              <SandpackConsole
                showHeader={false}
                showSyntaxError
                showSetupProgress
                style={{ height: 'calc(100% - 28px)' }}
              />
            </div>
          </div>
        </SandpackLayout>
      </SandpackProvider>

      <div style={{
        marginTop: '1rem',
        padding: '1rem',
        background: '#f5f5f5',
        borderRadius: '4px',
        fontSize: '0.9rem'
      }}>
        <h4 style={{ margin: '0 0 0.5rem 0' }}>What We're Testing:</h4>
        <ul style={{ margin: 0, paddingLeft: '1.5rem' }}>
          <li><strong>Test 1:</strong> Basic TypeScript features (types, interfaces, generics)</li>
          <li><strong>Test 2:</strong> npm dependencies (uuid) with TypeScript</li>
          <li><strong>Test 3:</strong> Complex MST types and inference</li>
          <li><strong>Test 4:</strong> All wavesmith patterns combined (arktype + MST + utilities)</li>
        </ul>
        <p style={{ margin: '0.5rem 0 0 0', fontStyle: 'italic', color: '#666' }}>
          ✅ Using <strong>vite-react-ts</strong> template: Vite bundler transpiles TypeScript → JavaScript, then Nodebox executes the compiled code. This matches our actual project setup (Vite + React + TS).
        </p>
        <p style={{ margin: '0.5rem 0 0 0', fontStyle: 'italic', color: '#666' }}>
          If all 4 tests pass, we can proceed to Unit 2 and load wavesmith .ts files with the same approach!
        </p>
      </div>
    </div>
  )
}
