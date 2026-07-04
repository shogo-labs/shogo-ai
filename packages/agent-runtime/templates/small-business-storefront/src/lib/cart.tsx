// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Product } from '@/data/store-content'

export interface CartLine {
  id: string
  name: string
  priceMinor: number
  image?: string
  quantity: number
}

interface CartValue {
  lines: CartLine[]
  count: number
  subtotalMinor: number
  add: (product: Product, quantity?: number) => void
  setQuantity: (id: string, quantity: number) => void
  remove: (id: string) => void
  clear: () => void
}

const STORAGE_KEY = 'storefront.cart.v1'
const CartContext = createContext<CartValue | null>(null)

function loadInitial(): CartLine[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as CartLine[]) : []
  } catch {
    return []
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(loadInitial)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lines))
    } catch {
      // Storage full or blocked (private mode) — cart still works in-memory.
    }
  }, [lines])

  const value = useMemo<CartValue>(() => {
    const add: CartValue['add'] = (product, quantity = 1) => {
      setLines((prev) => {
        const existing = prev.find((l) => l.id === product.id)
        if (existing) {
          return prev.map((l) =>
            l.id === product.id ? { ...l, quantity: l.quantity + quantity } : l,
          )
        }
        return [
          ...prev,
          {
            id: product.id,
            name: product.name,
            priceMinor: product.priceMinor,
            image: product.image,
            quantity,
          },
        ]
      })
    }

    const setQuantity: CartValue['setQuantity'] = (id, quantity) => {
      setLines((prev) =>
        quantity <= 0
          ? prev.filter((l) => l.id !== id)
          : prev.map((l) => (l.id === id ? { ...l, quantity } : l)),
      )
    }

    const remove: CartValue['remove'] = (id) =>
      setLines((prev) => prev.filter((l) => l.id !== id))

    const clear: CartValue['clear'] = () => setLines([])

    const count = lines.reduce((n, l) => n + l.quantity, 0)
    const subtotalMinor = lines.reduce((n, l) => n + l.priceMinor * l.quantity, 0)

    return { lines, count, subtotalMinor, add, setQuantity, remove, clear }
  }, [lines])

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart(): CartValue {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used within <CartProvider>')
  return ctx
}
