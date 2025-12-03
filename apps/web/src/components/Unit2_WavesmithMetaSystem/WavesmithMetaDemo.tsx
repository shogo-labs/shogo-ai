import { useState, useEffect, useCallback } from 'react'
import { SandpackProvider, SandpackLayout, SandpackCodeEditor, SandpackConsole, SandpackFileExplorer, SandpackPreview } from '@codesandbox/sandpack-react'
import { SchemaIntentInput } from './SchemaIntentInput'

// ===========================
// Wavesmith Source Files (Tier 1)
// ===========================

// Schematic Layer
import schematicIndex from '../../../../../packages/state-api/src/schematic/index.ts?raw'
import schematicTypes from '../../../../../packages/state-api/src/schematic/types.ts?raw'
import arktypeToJsonSchema from '../../../../../packages/state-api/src/schematic/arktype-to-json-schema.ts?raw'
import helpersFoundation from '../../../../../packages/state-api/src/schematic/helpers-foundation.ts?raw'
import helpersCore from '../../../../../packages/state-api/src/schematic/helpers-core.ts?raw'
import helpersAdvanced from '../../../../../packages/state-api/src/schematic/helpers-advanced.ts?raw'
import helpersMultidomain from '../../../../../packages/state-api/src/schematic/helpers-multidomain.ts?raw'
import helpersTypeResolution from '../../../../../packages/state-api/src/schematic/helpers-type-resolution.ts?raw'
import helpersModelBuilder from '../../../../../packages/state-api/src/schematic/helpers-model-builder.ts?raw'
import helpersStore from '../../../../../packages/state-api/src/schematic/helpers-store.ts?raw'
import enhancedJsonSchemaToMst from '../../../../../packages/state-api/src/schematic/enhanced-json-schema-to-mst.ts?raw'

// Meta Layer
import metaIndex from '../../../../../packages/state-api/src/meta/index.ts?raw'
import metaRegistry from '../../../../../packages/state-api/src/meta/meta-registry.ts?raw'
import metaStore from '../../../../../packages/state-api/src/meta/meta-store.ts?raw'
import metaStorePropertyEnhancements from '../../../../../packages/state-api/src/meta/meta-store-property-enhancements.ts?raw'
import metaStoreModelEnhancements from '../../../../../packages/state-api/src/meta/meta-store-model-enhancements.ts?raw'
import metaStoreSchemaEnhancements from '../../../../../packages/state-api/src/meta/meta-store-schema-enhancements.ts?raw'
import metaStoreRootEnhancements from '../../../../../packages/state-api/src/meta/meta-store-root-enhancements.ts?raw'
import bootstrap from '../../../../../packages/state-api/src/meta/bootstrap.ts?raw'
import runtimeStoreCache from '../../../../../packages/state-api/src/meta/runtime-store-cache.ts?raw'
import metaHelpers from '../../../../../packages/state-api/src/meta/meta-helpers.ts?raw'
import viewExecutor from '../../../../../packages/state-api/src/meta/view-executor.ts?raw'

// Core Layer (only kept files after audit - shed legacy code)
import coreTypes from '../../../../../packages/state-api/src/core/types.ts?raw'
import coreArktype from '../../../../../packages/state-api/src/core/arktype.ts?raw'
import coreEnvironment from '../../../../../packages/state-api/src/core/environment.ts?raw'
import coreIndex from '../../../../../packages/state-api/src/core/index.ts?raw'

// Utils Layer
import stringUtils from '../../../../../packages/state-api/src/utils/string.ts?raw'
import templateUtils from '../../../../../packages/state-api/src/utils/template.ts?raw'
import utilsIndex from '../../../../../packages/state-api/src/utils/index.ts?raw'

// Persistence Layer
import persistenceIndex from '../../../../../packages/state-api/src/persistence/index.ts?raw'
import persistenceTypes from '../../../../../packages/state-api/src/persistence/types.ts?raw'
import persistenceIo from '../../../../../packages/state-api/src/persistence/io.ts?raw'
import persistenceSchemaIo from '../../../../../packages/state-api/src/persistence/schema-io.ts?raw'
import persistenceDataIo from '../../../../../packages/state-api/src/persistence/data-io.ts?raw'
import persistenceFilesystem from '../../../../../packages/state-api/src/persistence/filesystem.ts?raw'
import persistenceNull from '../../../../../packages/state-api/src/persistence/null.ts?raw'

// MCP Layer (types only) - now in @shogo/mcp package
import mcpState from '../../../../../packages/mcp/src/state.ts?raw'

// Environment Layer
import environmentIndex from '../../../../../packages/state-api/src/environment/index.ts?raw'
import environmentTypes from '../../../../../packages/state-api/src/environment/types.ts?raw'

// Composition Layer
import compositionIndex from '../../../../../packages/state-api/src/composition/index.ts?raw'
import compositionPersistable from '../../../../../packages/state-api/src/composition/persistable.ts?raw'

// Main Entry
import wavesmithIndex from '../../../../../packages/state-api/src/index.ts?raw'

// ===========================
// Client Core (Isomorphic - works in React AND Sandpack)
// ===========================

import wavesmithStoreContext from '../../contexts/WavesmithStoreContext.tsx?raw'
import entityList from '../../components/EntityList.tsx?raw'

// ===========================
// Client Persistence & Services (NEW for dynamic meta-store pattern)
// ===========================

import wavesmithMetaStoreContext from '../../contexts/WavesmithMetaStoreContext.tsx?raw'
import mcpPersistence from '../../persistence/MCPPersistence.ts?raw'
import mcpService from '../../services/mcpService.ts?raw'

// ===========================
// Demo Application Files
// ===========================

import indexTsx from './sandpack-files/index.tsx?raw'
import appTsx from './sandpack-files/App-HostDemo.tsx?raw'

// Import workspace schemas from backend-generated index
import { workspaceSchemas } from '../../../../../.schemas/index'

/**
 * Transform @shogo/state-api imports to /src paths for Sandpack virtual filesystem.
 *
 * Sandpack doesn't have npm package resolution for workspace packages.
 * The @shogo/state-api source is already loaded at /src/... paths.
 */
function transformForSandpack(content: string): string {
  return content
    // Transform: import { X } from '@shogo/state-api' → import { X } from '/src'
    .replace(/from ['"]@shogo\/state-api['"]/g, "from '/src'")
    // Transform: import type { X } from '@shogo/state-api/subpath' → import type { X } from '/src/subpath'
    .replace(/from ['"]@shogo\/state-api\/([^'"]+)['"]/g, "from '/src/$1'")
}

export function WavesmithMetaDemo() {
  // Callback handler for new schema generation
  const handleSchemaGenerated = useCallback((schemaName: string) => {
    console.log(`✨ Schema generated: ${schemaName}`)
    console.log('✅ Backend updated index.ts - HMR will refresh automatically')
  }, [])

  // Build virtual filesystem
  console.log('📦 Building Sandpack files object...')
  console.log('📦 Workspace schemas count:', Object.keys(workspaceSchemas).length)
  console.log('📦 Workspace schema keys:', Object.keys(workspaceSchemas))

  const files = {
    // Wavesmith source files - mirrors real disk structure at /src/
    '/src/schematic/index.ts': schematicIndex,
    '/src/schematic/types.ts': schematicTypes,
    '/src/schematic/arktype-to-json-schema.ts': arktypeToJsonSchema,
    '/src/schematic/helpers-foundation.ts': helpersFoundation,
    '/src/schematic/helpers-core.ts': helpersCore,
    '/src/schematic/helpers-advanced.ts': helpersAdvanced,
    '/src/schematic/helpers-multidomain.ts': helpersMultidomain,
    '/src/schematic/helpers-type-resolution.ts': helpersTypeResolution,
    '/src/schematic/helpers-model-builder.ts': helpersModelBuilder,
    '/src/schematic/helpers-store.ts': helpersStore,
    '/src/schematic/enhanced-json-schema-to-mst.ts': enhancedJsonSchemaToMst,
    '/src/meta/meta-registry.ts': metaRegistry,
    '/src/meta/meta-store.ts': metaStore,
    '/src/meta/meta-store-property-enhancements.ts': metaStorePropertyEnhancements,
    '/src/meta/meta-store-model-enhancements.ts': metaStoreModelEnhancements,
    '/src/meta/meta-store-schema-enhancements.ts': metaStoreSchemaEnhancements,
    '/src/meta/meta-store-root-enhancements.ts': metaStoreRootEnhancements,
    '/src/meta/bootstrap.ts': bootstrap,
    '/src/meta/runtime-store-cache.ts': runtimeStoreCache,
    '/src/meta/meta-helpers.ts': metaHelpers,
    '/src/meta/view-executor.ts': viewExecutor,
    '/src/meta/index.ts': metaIndex,
    '/src/core/types.ts': coreTypes,
    '/src/core/arktype.ts': coreArktype,
    '/src/core/environment.ts': coreEnvironment,
    '/src/core/index.ts': coreIndex,
    '/src/utils/string.ts': stringUtils,
    '/src/utils/template.ts': templateUtils,
    '/src/utils/index.ts': utilsIndex,
    '/src/persistence/types.ts': persistenceTypes,
    '/src/persistence/io.ts': persistenceIo,
    '/src/persistence/schema-io.ts': persistenceSchemaIo,
    '/src/persistence/data-io.ts': persistenceDataIo,
    '/src/persistence/filesystem.ts': persistenceFilesystem,
    '/src/persistence/null.ts': persistenceNull,
    '/src/persistence/index.ts': persistenceIndex,
    '/src/mcp/state.ts': mcpState,
    '/src/environment/index.ts': environmentIndex,
    '/src/environment/types.ts': environmentTypes,
    '/src/composition/index.ts': compositionIndex,
    '/src/composition/persistable.ts': compositionPersistable,
    '/src/index.ts': wavesmithIndex,

    // Client core - mirrors real disk structure at /client/src/
    // Apply transformForSandpack to resolve @shogo/state-api → /src
    '/client/src/contexts/WavesmithStoreContext.tsx': transformForSandpack(wavesmithStoreContext),
    '/client/src/components/EntityList.tsx': entityList,

    // Client contexts - meta-store (NEW for dynamic schema loading)
    '/client/src/contexts/WavesmithMetaStoreContext.tsx': transformForSandpack(wavesmithMetaStoreContext),

    // Client persistence & services (NEW for MCP bridge)
    '/client/src/persistence/MCPPersistence.ts': transformForSandpack(mcpPersistence),
    '/client/src/services/mcpService.ts': mcpService,

    // Demo application
    '/index.tsx': indexTsx,
    '/App.tsx': appTsx,

    // Workspace schemas - map to /workspace/ prefix for Sandpack
    ...Object.fromEntries(
      Object.entries(workspaceSchemas).map(([path, content]) => [
        `/.schemas/${path}`,  // Maps "task-management/schema.json" to "/workspace/task-management/schema.json"
        content
      ])
    ),
  }

  console.log('📦 Total files in Sandpack:', Object.keys(files).length)

  return (
    <div style={{ margin: '2rem 0' }}>
      <h2>Unit 2: Wavesmith Meta-System in Browser</h2>
      <p>Testing the complete meta-system pipeline: ArkType → Enhanced JSON Schema → MST Models → Runtime Store</p>

      {/* AI Schema Generator */}
      <SchemaIntentInput onSchemaGenerated={handleSchemaGenerated} />

      <div style={{
        padding: '0.75rem',
        background: '#dbeafe',
        border: '2px solid #3b82f6',
        borderRadius: '4px',
        marginBottom: '1rem',
        fontSize: '0.9rem',
        color: '#1e40af'
      }}>
        <strong>📋 System Architecture:</strong> 32 TypeScript files loaded from source:
        <ul style={{ margin: '0.5rem 0 0 0', paddingLeft: '1.5rem' }}>
          <li>Schematic Layer (3 files): arkType → JSON Schema → MST transformation</li>
          <li>Meta Layer (9 files): Registry, Store (split into 5 files for esbuild wasm), Bootstrap, Cache, Helpers, View Executor</li>
          <li>Core Layer (8 files): Types, ArkType utils, Base models, Environment, Cross-refs, JSON→MST, Typed MST</li>
          <li>Utils Layer (3 files): String utils, Templates, Index</li>
          <li>Environment Layer (2 files): Environment injection patterns</li>
          <li>Composition Layer (2 files): MST mixins for persistence</li>
          <li>Persistence Layer (1 file): Interfaces only (browser-compatible)</li>
          <li>MCP Layer (1 file): State type definitions</li>
          <li>Main Entry (1 file): Package exports</li>
          <li><strong>Client Layer (3 files - NEW):</strong> Meta-store provider, MCP persistence bridge, MCP service</li>
        </ul>
      </div>

      <SandpackProvider
        template="vite-react-ts"
        customSetup={{
          dependencies: {
            'arktype': '^2.0.0-beta.7',
            'mobx': '^6.13.5',
            'mobx-state-tree': '^6.0.1',
            'mobx-react-lite': '^4.0.0',
            'uuid': '^13.0.0',
            'jsondiffpatch': '^0.6.0',
            'nunjucks': '^3.2.4'
          }
        }}
        files={files}
        options={{
          autorun: true,
          autoReload: true,
        }}
      >
        <SandpackLayout>
          <SandpackFileExplorer style={{ height: '600px' }} />
          <SandpackCodeEditor
            showLineNumbers
            showTabs
            style={{ height: '600px' }}
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
                Preview (React Demo)
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
                Console (Pipeline Logs)
              </div>
              <SandpackConsole
                showHeader
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
          <li><strong>Dynamic Schema Loading:</strong> Load minimal-cms schema from MCP server at runtime</li>
          <li><strong>Meta-Store Pattern:</strong> Schema entities managing runtime stores with bootstrap cache</li>
          <li><strong>Isomorphic Persistence:</strong> MCPPersistence (browser) → MCP Server → FileSystemPersistence</li>
          <li><strong>Full CRUD with Auto-Save:</strong> Changes persist immediately to server via MCP HTTP</li>
          <li><strong>Observer Reactivity:</strong> MobX auto-updates UI on MST state changes</li>
          <li><strong>Server Sync:</strong> Explicit load/save operations via MCP tools</li>
        </ul>
        <p style={{ margin: '0.5rem 0 0 0', fontStyle: 'italic', color: '#666' }}>
          ✅ All source files loaded from <code>/src</code> - no inline strings, zero escaping issues!
        </p>
      </div>
    </div>
  )
}
