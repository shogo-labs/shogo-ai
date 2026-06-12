// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { ExtensionInstallService, type ExtensionListItem } from './install-service'

export interface ExtensionSearchResult {
  id: string
  name: string
  publisher: string
  displayName: string
  description: string
  version: string
  iconUrl?: string
  downloads?: number
  rating?: number
  verified?: boolean
  preRelease?: boolean
  source: 'open-vsx' | 'private' | 'local-vsix'
  categories: string[]
  tags: string[]
}

const RECOMMENDED_QUERIES = [
  'git graph',
  'python',
  'markdownlint',
  'dev containers',
  'debugger firefox',
  'edge tools',
  'npm intellisense',
  'eslint',
]

export class ExtensionRegistryService {
  constructor(private readonly installService = new ExtensionInstallService()) {}

  listInstalled(workspaceRoot?: string): ExtensionListItem[] {
    return this.installService.listInstalled(workspaceRoot)
  }

  getContributions(workspaceRoot?: string): ReturnType<ExtensionInstallService['getContributions']> {
    return this.installService.getContributions(workspaceRoot)
  }

  async search(query: string, options?: { size?: number }): Promise<ExtensionSearchResult[]> {
    const trimmed = query.trim()
    if (!trimmed) return []
    if (trimmed === '@recommended') return this.recommended(options?.size ?? 8)
    if (trimmed === '@installed') return this.listInstalled().map(extensionToSearchResult)
    if (trimmed === '@disabled') return this.listInstalled().filter((ext) => !ext.enabled).map(extensionToSearchResult)
    if (trimmed === '@enabled') return this.listInstalled().filter((ext) => ext.enabled).map(extensionToSearchResult)
    if (trimmed === '@updates') return []

    return this.openVsxSearch(trimmed, options?.size ?? 20)
  }

  private async recommended(size: number): Promise<ExtensionSearchResult[]> {
    const seen = new Set(this.listInstalled().map((ext) => ext.id))
    const results: ExtensionSearchResult[] = []
    for (const query of RECOMMENDED_QUERIES) {
      try {
        const [first] = await this.openVsxSearch(query, 1)
        if (!first || seen.has(first.id)) continue
        seen.add(first.id)
        results.push(first)
        if (results.length >= size) break
      } catch {
        // Recommendations are best-effort; direct search should surface errors.
      }
    }
    return results
  }

  private async openVsxSearch(query: string, size: number): Promise<ExtensionSearchResult[]> {
    const params = new URLSearchParams({ query, size: String(size) })
    const res = await fetch(`https://open-vsx.org/api/-/search?${params.toString()}`)
    if (!res.ok) throw new Error(`Open VSX search failed (${res.status})`)
    const body = await res.json() as { extensions?: Array<Record<string, unknown>> }
    return (body.extensions ?? []).map(openVsxItemToSearchResult)
  }
}

function openVsxItemToSearchResult(item: Record<string, unknown>): ExtensionSearchResult {
  const files = item.files && typeof item.files === 'object' ? item.files as Record<string, unknown> : {}
  const namespace = String(item.namespace ?? item.publisher ?? '')
  const name = String(item.name ?? '')
  return {
    id: `${namespace}.${name}`.toLowerCase(),
    name,
    publisher: namespace,
    displayName: String(item.displayName ?? name),
    description: String(item.description ?? ''),
    version: String(item.version ?? ''),
    iconUrl: typeof item.iconUrl === 'string' ? item.iconUrl : typeof files.icon === 'string' ? files.icon : undefined,
    downloads: typeof item.downloadCount === 'number' ? item.downloadCount : undefined,
    rating: typeof item.averageRating === 'number' ? item.averageRating : undefined,
    verified: Boolean(item.verified),
    preRelease: Boolean(item.preRelease),
    source: 'open-vsx',
    categories: Array.isArray(item.categories) ? item.categories.filter((x): x is string => typeof x === 'string') : [],
    tags: Array.isArray(item.tags) ? item.tags.filter((x): x is string => typeof x === 'string') : [],
  }
}

function extensionToSearchResult(ext: ExtensionListItem): ExtensionSearchResult {
  return {
    id: ext.id,
    name: ext.name,
    publisher: ext.publisher,
    displayName: ext.displayName ?? ext.name,
    description: ext.description ?? '',
    version: ext.version,
    source: ext.source === 'vsix' ? 'local-vsix' : ext.source,
    categories: ext.manifest.categories ?? [],
    tags: [],
  }
}
