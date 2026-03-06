/**
 * useApiDataSource
 *
 * React hook that manages API data fetching for dynamic app surfaces.
 * Components with { api: "/api/todos" } bindings register their endpoints
 * here, and this hook handles fetching, caching, polling, and mutations.
 *
 * Platform-agnostic: uses standard fetch API.
 */

import { useState, useEffect, useRef, useCallback } from 'react'

export interface ApiBinding {
  api: string
  params?: Record<string, unknown>
  refreshInterval?: number
}

interface ApiDataState {
  data: unknown
  loading: boolean
  error: string | null
  fetchedAt: number
}

export interface ApiDataSourceResult {
  getData: (endpoint: string) => unknown
  isLoading: (endpoint: string) => boolean
  refetch: (endpoint?: string) => void
  mutate: (endpoint: string, method: string, body?: unknown) => Promise<{ ok: boolean; item?: unknown; error?: string }>
  registerBinding: (key: string, binding: ApiBinding) => void
  unregisterBinding: (key: string) => void
}

export interface ApiDataSourceOptions {
  headers?: () => Record<string, string>
}

export function useApiDataSource(
  agentUrl: string | null,
  surfaceId: string,
  options?: ApiDataSourceOptions,
): ApiDataSourceResult {
  const [cache, setCache] = useState<Map<string, ApiDataState>>(new Map())
  const bindingsRef = useRef<Map<string, ApiBinding>>(new Map())
  const intervalsRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map())
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const interval of intervalsRef.current.values()) {
        clearInterval(interval)
      }
      intervalsRef.current.clear()
    }
  }, [])

  const buildUrl = useCallback((api: string, params?: Record<string, unknown>): string => {
    if (!agentUrl) return ''
    const base = `${agentUrl}/agent/dynamic-app/api/${surfaceId}${api}`
    if (!params || Object.keys(params).length === 0) return base
    const searchParams = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) searchParams.set(k, String(v))
    }
    return `${base}?${searchParams.toString()}`
  }, [agentUrl, surfaceId])

  const fetchEndpoint = useCallback(async (api: string, params?: Record<string, unknown>) => {
    const url = buildUrl(api, params)
    if (!url) return

    setCache(prev => {
      const next = new Map(prev)
      const existing = next.get(api)
      next.set(api, { data: existing?.data ?? null, loading: true, error: null, fetchedAt: existing?.fetchedAt ?? 0 })
      return next
    })

    try {
      const res = await fetch(url, { headers: options?.headers?.() })
      const json = await res.json()
      if (!mountedRef.current) return

      setCache(prev => {
        const next = new Map(prev)
        next.set(api, {
          data: json.items ?? json.item ?? json,
          loading: false,
          error: json.ok === false ? json.error : null,
          fetchedAt: Date.now(),
        })
        return next
      })
    } catch (err: any) {
      if (!mountedRef.current) return
      setCache(prev => {
        const next = new Map(prev)
        next.set(api, { data: null, loading: false, error: err.message, fetchedAt: Date.now() })
        return next
      })
    }
  }, [buildUrl])

  const registerBinding = useCallback((key: string, binding: ApiBinding) => {
    const existing = bindingsRef.current.get(key)
    if (existing && existing.api === binding.api && JSON.stringify(existing.params) === JSON.stringify(binding.params)) {
      return
    }

    bindingsRef.current.set(key, binding)
    fetchEndpoint(binding.api, binding.params)

    if (binding.refreshInterval && binding.refreshInterval > 0) {
      const existingInterval = intervalsRef.current.get(key)
      if (existingInterval) clearInterval(existingInterval)

      const interval = setInterval(() => {
        fetchEndpoint(binding.api, binding.params)
      }, binding.refreshInterval * 1000)
      intervalsRef.current.set(key, interval)
    }
  }, [fetchEndpoint])

  const unregisterBinding = useCallback((key: string) => {
    bindingsRef.current.delete(key)
    const interval = intervalsRef.current.get(key)
    if (interval) {
      clearInterval(interval)
      intervalsRef.current.delete(key)
    }
  }, [])

  const getData = useCallback((endpoint: string): unknown => {
    return cache.get(endpoint)?.data ?? null
  }, [cache])

  const isLoading = useCallback((endpoint: string): boolean => {
    return cache.get(endpoint)?.loading ?? false
  }, [cache])

  const refetch = useCallback((endpoint?: string) => {
    if (endpoint) {
      const binding = [...bindingsRef.current.values()].find(b => b.api === endpoint)
      fetchEndpoint(endpoint, binding?.params)
    } else {
      for (const binding of bindingsRef.current.values()) {
        fetchEndpoint(binding.api, binding.params)
      }
    }
  }, [fetchEndpoint])

  const mutate = useCallback(async (
    endpoint: string,
    method: string,
    body?: unknown,
  ): Promise<{ ok: boolean; item?: unknown; error?: string }> => {
    if (!agentUrl) return { ok: false, error: 'No agent URL' }

    const url = `${agentUrl}/agent/dynamic-app/api/${surfaceId}${endpoint}`
    try {
      const extraHeaders = options?.headers?.()
      const res = await fetch(url, {
        method: method.toUpperCase(),
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: body ? JSON.stringify(body) : undefined,
      })
      const json = await res.json()

      const basePath = endpoint.replace(/\/[^/]+$/, '')
      for (const binding of bindingsRef.current.values()) {
        if (binding.api === basePath || binding.api.startsWith(basePath)) {
          fetchEndpoint(binding.api, binding.params)
        }
      }

      return json
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  }, [agentUrl, surfaceId, fetchEndpoint])

  return { getData, isLoading, refetch, mutate, registerBinding, unregisterBinding }
}
