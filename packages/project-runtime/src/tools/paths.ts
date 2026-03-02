import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

// packages/project-runtime/src/tools/paths.ts -> monorepo root is 4 levels up
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
export const MONOREPO_ROOT = resolve(__dirname, '../../../../')
