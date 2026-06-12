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
    if (trimmed === '@installed') return this.listInstalled().map(extensionToSearchResult)
    if (trimmed === '@disabled') return this.listInstalled().filter((ext) => !ext.enabled).map(extensionToSearchResult)
    if (trimmed === '@enabled') return this.listInstalled().filter((ext) => ext.enabled).map(extensionToSearchResult)
    if (trimmed === '@updates') return []

    const params = new URLSearchParams({ query: trimmed, size: String(options?.size ?? 20) })
    const res = await fetch(`https://open-vsx.org/api/-/search?${params.toString()}`)
    if (!res.ok) throw new Error(`Open VSX search failed (${res.status})`)
    const body = await res.json() as { extensions?: Array<Record<string, unknown>> }
    return (body.extensions ?? []).map((item) => ({
      id: String(item.namespace ?? item.publisher ?? 'unknown').toLowerCase() + '.' + String(item.name ?? 'unknown').toLowerCase(),
      name: String(item.name ?? ''),
      publisher: String(item.namespace ?? item.publisher ?? ''),
      displayName: String(item.displayName ?? item.name ?? ''),
      description: String(item.description ?? ''),
      version: String(item.version ?? ''),
      iconUrl: typeof item.iconUrl === 'string' ? item.iconUrl : undefined,
      downloads: typeof item.downloadCount === 'number' ? item.downloadCount : undefined,
      rating: typeof item.averageRating === 'number' ? item.averageRating : undefined,
      verified: Boolean(item.verified),
      preRelease: Boolean(item.preRelease),
      source: 'open-vsx',
      categories: Array.isArray(item.categories) ? item.categories.filter((x): x is string => typeof x === 'string') : [],
      tags: Array.isArray(item.tags) ? item.tags.filter((x): x is string => typeof x === 'string') : [],
    }))
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
