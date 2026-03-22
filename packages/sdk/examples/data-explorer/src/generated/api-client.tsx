import type { UserType, UserCreateInput, UserUpdateInput } from './user.types'
import type { DatasetType, DatasetCreateInput, DatasetUpdateInput } from './dataset.types'
import type { SavedQueryType, SavedQueryCreateInput, SavedQueryUpdateInput } from './savedquery.types'

export interface ApiResponse<T> { ok: boolean; data?: T; error?: { code: string; message: string } }
export interface ApiListResponse<T> { ok: boolean; items?: T[]; error?: { code: string; message: string } }
export interface ApiClientConfig { baseUrl: string; token?: string; userId?: string }

let config: ApiClientConfig = { baseUrl: '/api' }

export function configureApiClient(newConfig: Partial<ApiClientConfig>) { config = { ...config, ...newConfig } }
export function getApiConfig(): ApiClientConfig { return { ...config } }

async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.token) headers['Authorization'] = `Bearer ${config.token}`
  try {
    const response = await fetch(`${config.baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
    const data = await response.json()
    if (!response.ok) return { ok: false, error: data.error || { code: 'request_failed', message: `HTTP ${response.status}` } }
    return data
  } catch (error) {
    return { ok: false, error: { code: 'network_error', message: error instanceof Error ? error.message : 'Network error' } }
  }
}

function buildListFn<T>(basePath: string) {
  return async (options?: { where?: Record<string, unknown>; limit?: number; offset?: number; params?: Record<string, string | number | boolean> }): Promise<ApiListResponse<T>> => {
    const params = new URLSearchParams()
    if (options?.where) for (const [k, v] of Object.entries(options.where)) { if (v !== undefined && v !== null) params.set(k, String(v)) }
    if (options?.params) for (const [k, v] of Object.entries(options.params)) { if (v !== undefined && v !== null) params.set(k, String(v)) }
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.offset) params.set('offset', String(options.offset))
    if (config.userId) params.set('userId', config.userId)
    const query = params.toString() ? `?${params.toString()}` : ''
    return request<T>('GET', `${basePath}${query}`) as Promise<ApiListResponse<T>>
  }
}

export const userApi = {
  list: buildListFn<UserType>('/users'),
  async get(id: string) { return request<UserType>('GET', `/users/${id}`) },
  async create(input: UserCreateInput) { return request<UserType>('POST', `/users`, config.userId ? { ...input, userId: config.userId } : input) },
  async update(id: string, input: UserUpdateInput) { return request<UserType>('PATCH', `/users/${id}`, input) },
  async delete(id: string) { return request<void>('DELETE', `/users/${id}`) },
}

export const datasetApi = {
  list: buildListFn<DatasetType>('/datasets'),
  async get(id: string) { return request<DatasetType>('GET', `/datasets/${id}`) },
  async create(input: DatasetCreateInput) { return request<DatasetType>('POST', `/datasets`, config.userId ? { ...input, userId: config.userId } : input) },
  async update(id: string, input: DatasetUpdateInput) { return request<DatasetType>('PATCH', `/datasets/${id}`, input) },
  async delete(id: string) { return request<void>('DELETE', `/datasets/${id}`) },
}

export const savedQueryApi = {
  list: buildListFn<SavedQueryType>('/saved-queries'),
  async get(id: string) { return request<SavedQueryType>('GET', `/saved-queries/${id}`) },
  async create(input: SavedQueryCreateInput) { return request<SavedQueryType>('POST', `/saved-queries`, config.userId ? { ...input, userId: config.userId } : input) },
  async update(id: string, input: SavedQueryUpdateInput) { return request<SavedQueryType>('PATCH', `/saved-queries/${id}`, input) },
  async delete(id: string) { return request<void>('DELETE', `/saved-queries/${id}`) },
}

export const api = {
  user: userApi,
  dataset: datasetApi,
  savedQuery: savedQueryApi,
}

export default api
