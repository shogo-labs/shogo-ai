// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { generateModelTypes, generateTypesIndex, generateTypes } from '../types-generator'
import { generateMSTModel } from '../mst-model-generator'
import { generateMSTCollection } from '../mst-collection-generator'
import { generateMSTDomain } from '../mst-domain-generator'
import { generateModelStore, generateStoresIndex } from '../stores-generator'
import { generateServer, generateDbModule } from '../server-generator'
import { generateServerFunctions } from '../server-functions'
import type { PrismaModel } from '../prisma-generator'

const MIT_PREFIX =
  '// SPDX-License-Identifier: MIT\n// Copyright (C) 2026 Shogo Technologies, Inc.\n'

const minimalModel: PrismaModel = {
  name: 'Widget',
  dbName: null,
  fields: [
    {
      name: 'id',
      kind: 'scalar',
      type: 'String',
      isRequired: true,
      isList: false,
      isId: true,
      isUnique: true,
      hasDefaultValue: true,
    },
  ],
}

describe('GENERATED_FILE_LICENSE_HEADER coverage', () => {
  it('types: per-model, index, and monolithic', () => {
    expect(generateModelTypes(minimalModel, [], 'ts').code).toStartWith(MIT_PREFIX)
    expect(generateTypesIndex([minimalModel])).toStartWith(MIT_PREFIX)
    expect(generateTypes([minimalModel], [])).toStartWith(MIT_PREFIX)
  })

  it('MST: model, collection, domain', () => {
    expect(generateMSTModel(minimalModel, [minimalModel], [], new Set(['Widget']), 'ts').code).toStartWith(
      MIT_PREFIX,
    )
    expect(generateMSTCollection(minimalModel, 'ts').code).toStartWith(MIT_PREFIX)
    expect(generateMSTDomain([minimalModel], 'ts').code).toStartWith(MIT_PREFIX)
  })

  it('stores: per-model and index', () => {
    const store = generateModelStore(minimalModel, { fileExtension: 'ts' })
    expect(store).not.toBeNull()
    expect(store!.code).toStartWith(MIT_PREFIX)
    expect(generateStoresIndex([minimalModel], { fileExtension: 'ts' })).toStartWith(MIT_PREFIX)
  })

  it('server and server-functions', () => {
    expect(generateServer({})).toStartWith(MIT_PREFIX)
    expect(generateDbModule()).toStartWith(MIT_PREFIX)
    expect(generateServerFunctions([minimalModel])).toStartWith(MIT_PREFIX)
  })
})
