/**
 * Tests for environment type definitions.
 *
 * These tests verify TypeScript compilation and runtime structure of
 * environment objects. Since these are pure type definitions, tests focus
 * on ensuring valid environment construction works as expected.
 */
import { describe, test, expect } from 'bun:test'
import type { IEnvironment, ISchemaEntity } from '../../src/environment/types'
import { NullPersistence } from '../../src/persistence/null'
import { FileSystemPersistence } from '../../src/persistence/filesystem'

describe('IEnvironment Type', () => {
  test('should compile valid environment with required properties', () => {
    const mockSchema = { id: 'test-123', name: 'TestSchema' }

    const env: IEnvironment = {
      services: {
        persistence: new NullPersistence()
      },
      context: {
        schemaName: mockSchema.name
      }
    }

    expect(env).toBeDefined()
    expect(env.services.persistence).toBeInstanceOf(NullPersistence)
    expect(env.context.schemaName).toBe('TestSchema')
  })

  test('should compile with optional location property', () => {
    const mockSchema = { id: 'test-456', name: 'ProjectSchema' }

    const env: IEnvironment = {
      services: {
        persistence: new FileSystemPersistence()
      },
      context: {
        schemaName: mockSchema.name,
        location: './workspace-a'
      }
    }

    expect(env.context.schemaName).toBe('ProjectSchema')
    expect(env.context.location).toBe('./workspace-a')
  })

  test('should compile without optional location property', () => {
    const mockSchema = { id: 'test-789', name: 'DefaultSchema' }

    const env: IEnvironment = {
      services: {
        persistence: new NullPersistence()
      },
      context: {
        schemaName: mockSchema.name
        // location is optional - not provided
      }
    }

    expect(env.context.schemaName).toBe('DefaultSchema')
    expect(env.context.location).toBeUndefined()
  })

  test('should accept different persistence implementations', () => {
    const mockSchema = { id: 'test-abc', name: 'Schema' }

    const envWithNull: IEnvironment = {
      services: { persistence: new NullPersistence() },
      context: { schemaName: mockSchema.name }
    }

    const envWithFS: IEnvironment = {
      services: { persistence: new FileSystemPersistence() },
      context: { schemaName: mockSchema.name }
    }

    expect(envWithNull.services.persistence).toBeInstanceOf(NullPersistence)
    expect(envWithNull.context.schemaName).toBe('Schema')
    expect(envWithFS.services.persistence).toBeInstanceOf(FileSystemPersistence)
    expect(envWithFS.context.schemaName).toBe('Schema')
  })
})

describe('ISchemaEntity Type', () => {
  test('should accept simple schema objects', () => {
    const simpleSchema: ISchemaEntity = {
      id: 'simple-1',
      name: 'SimpleSchema'
    }

    expect(simpleSchema.id).toBe('simple-1')
    expect(simpleSchema.name).toBe('SimpleSchema')
  })

  test('should accept complex schema objects with additional properties', () => {
    const complexSchema: ISchemaEntity = {
      id: 'complex-1',
      name: 'ComplexSchema',
      format: 'enhanced-json-schema',
      createdAt: Date.now(),
      models: [
        { name: 'Task', properties: [] },
        { name: 'User', properties: [] }
      ],
      views: [
        { name: 'taskView', type: 'query' }
      ]
    }

    expect(complexSchema.id).toBe('complex-1')
    expect(complexSchema.models).toHaveLength(2)
    expect(complexSchema.views).toHaveLength(1)
  })

  test('should accept schema objects with methods', () => {
    const schemaWithMethods: ISchemaEntity = {
      id: 'method-1',
      name: 'MethodSchema',
      toEnhancedJson: () => ({ format: 'enhanced-json-schema' }),
      findModel: (name: string) => ({ name })
    }

    expect(schemaWithMethods.toEnhancedJson()).toEqual({ format: 'enhanced-json-schema' })
    expect(schemaWithMethods.findModel('Task')).toEqual({ name: 'Task' })
  })

  test('should work in environment context', () => {
    const schemas: ISchemaEntity[] = [
      { id: '1', name: 'Schema1' },
      { id: '2', name: 'Schema2', format: 'enhanced-json-schema' },
      { id: '3', name: 'Schema3', toJson: () => ({}) }
    ]

    schemas.forEach(schema => {
      const env: IEnvironment = {
        services: { persistence: new NullPersistence() },
        context: { schemaName: schema.name }
      }

      expect(env.context.schemaName).toBe(schema.name)
      expect(env.context.schemaName).toBeDefined()
    })
  })
})

describe('Environment Usage Patterns', () => {
  test('should support creating multiple isolated environments', () => {
    const schema1 = { id: '1', name: 'Schema1' }
    const schema2 = { id: '2', name: 'Schema2' }

    const env1: IEnvironment = {
      services: { persistence: new NullPersistence() },
      context: { schemaName: schema1.name, location: 'workspace-1' }
    }

    const env2: IEnvironment = {
      services: { persistence: new NullPersistence() },
      context: { schemaName: schema2.name, location: 'workspace-2' }
    }

    expect(env1.context.schemaName).toBe('Schema1')
    expect(env2.context.schemaName).toBe('Schema2')
    expect(env1.context.schemaName).not.toBe(env2.context.schemaName)
    expect(env1.context.location).not.toBe(env2.context.location)
  })

  test('should support extracting schema name from environment', () => {
    const mockSchema = { id: 'extract-1', name: 'ExtractSchema' }

    const env: IEnvironment = {
      services: { persistence: new NullPersistence() },
      context: { schemaName: mockSchema.name }
    }

    const extractedSchemaName: string = env.context.schemaName

    expect(extractedSchemaName).toBe('ExtractSchema')
  })

  test('should support conditional location access', () => {
    const envWithLocation: IEnvironment = {
      services: { persistence: new NullPersistence() },
      context: { schemaName: 'Test', location: './data' }
    }

    const envWithoutLocation: IEnvironment = {
      services: { persistence: new NullPersistence() },
      context: { schemaName: 'Test' }
    }

    const location1 = envWithLocation.context.location || '.schemas'
    const location2 = envWithoutLocation.context.location || '.schemas'

    expect(envWithLocation.context.schemaName).toBe('Test')
    expect(envWithoutLocation.context.schemaName).toBe('Test')
    expect(location1).toBe('./data')
    expect(location2).toBe('.schemas')
  })
})
