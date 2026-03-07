// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Expense Tracker App
 */

import { useState, useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'
import { api, configureApiClient } from './generated/api-client'
import { cn } from '@/lib/utils'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Plus,
  Trash2,
  LogOut,
  Loader2,
  Receipt,
} from 'lucide-react'

interface CategoryType {
  id: string
  name: string
  icon: string
  color: string
  type: string
}

interface TransactionType {
  id: string
  amount: number
  description: string | null
  date: string
  type: string
  categoryId: string
  category?: CategoryType
}

interface SummaryType {
  totalIncome: number
  totalExpenses: number
  balance: number
  byCategory: { category: CategoryType; amount: number }[]
}

export default function App() {
  return <AuthGate><Dashboard /></AuthGate>
}

const Dashboard = observer(function Dashboard() {
  const { auth } = useStores()
  const [transactions, setTransactions] = useState<TransactionType[]>([])
  const [categories, setCategories] = useState<CategoryType[]>([])
  const [summary, setSummary] = useState<SummaryType | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)

  // Configure API client with user context
  useEffect(() => {
    if (auth.user) {
      configureApiClient({ userId: auth.user.id })
    }
  }, [auth.user?.id])

  const seedDefaultCategories = useCallback(async () => {
    const defaults = [
      { name: 'Food & Dining', icon: '🍔', color: '#EF4444', type: 'expense' },
      { name: 'Transportation', icon: '🚗', color: '#F59E0B', type: 'expense' },
      { name: 'Shopping', icon: '🛍️', color: '#8B5CF6', type: 'expense' },
      { name: 'Entertainment', icon: '🎬', color: '#EC4899', type: 'expense' },
      { name: 'Bills & Utilities', icon: '💡', color: '#6366F1', type: 'expense' },
      { name: 'Health', icon: '🏥', color: '#14B8A6', type: 'expense' },
      { name: 'Housing', icon: '🏠', color: '#F97316', type: 'expense' },
      { name: 'Other', icon: '📦', color: '#6B7280', type: 'expense' },
      { name: 'Salary', icon: '💰', color: '#10B981', type: 'income' },
      { name: 'Freelance', icon: '💻', color: '#3B82F6', type: 'income' },
      { name: 'Investments', icon: '📈', color: '#22C55E', type: 'income' },
      { name: 'Other Income', icon: '💵', color: '#06B6D4', type: 'income' },
    ]
    const created: CategoryType[] = []
    for (const cat of defaults) {
      try {
        const res = await api.category.create(cat as any)
        if (res.ok && res.data) created.push(res.data as any)
      } catch { /* skip duplicates */ }
    }
    return created
  }, [])

  const fetchData = useCallback(async () => {
    if (!auth.user) return
    try {
      const [txRes, catRes, sumRes] = await Promise.all([
        api.transaction.list({ params: { include: 'category' } }),
        api.category.list(),
        fetch(`/api/summary?userId=${auth.user.id}`),
      ])
      if (txRes.ok) { setTransactions((txRes.items || []) as any) }
      if (sumRes.ok) setSummary(await sumRes.json())

      let cats = (catRes.ok ? catRes.items || [] : []) as CategoryType[]
      if (cats.length === 0) {
        cats = await seedDefaultCategories()
      }
      setCategories(cats)
    } catch (err) { console.error('Failed to fetch:', err) }
    finally { setLoading(false) }
  }, [auth.user, seedDefaultCategories])

  useEffect(() => { fetchData() }, [fetchData])

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this transaction?')) return
    await api.transaction.delete(id)
    fetchData()
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading expenses...</p>
        </div>
      </div>
    )
  }

  const formatCurrency = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

  const formatDate = (d: string) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(d))

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            <h1 className="text-lg font-semibold">Expense Tracker</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{auth.user?.name || auth.user?.email}</span>
            <Button variant="ghost" size="sm" onClick={() => auth.signOut()}>
              <LogOut className="h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 space-y-8">
        {/* Summary Cards */}
        {summary && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardDescription>Income</CardDescription>
                <TrendingUp className="h-4 w-4 text-emerald-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-emerald-600">+{formatCurrency(summary.totalIncome)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardDescription>Expenses</CardDescription>
                <TrendingDown className="h-4 w-4 text-red-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-600">-{formatCurrency(summary.totalExpenses)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardDescription>Balance</CardDescription>
                <DollarSign className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className={cn('text-2xl font-bold', summary.balance >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                  {formatCurrency(summary.balance)}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Transactions */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Transactions</CardTitle>
                <CardDescription>{transactions.length} total</CardDescription>
              </div>
              <Button onClick={() => setShowAddForm(!showAddForm)} size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white">
                {showAddForm ? 'Cancel' : <><Plus className="h-4 w-4" />Add Transaction</>}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {showAddForm && (
              <AddTransactionForm
                userId={auth.user!.id}
                categories={categories}
                onAdd={() => { setShowAddForm(false); fetchData() }}
              />
            )}

            {transactions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Receipt className="h-12 w-12 text-muted-foreground/40 mb-4" />
                <p className="text-sm text-muted-foreground">No transactions yet</p>
                <p className="text-xs text-muted-foreground mt-1">Add your first transaction to get started</p>
              </div>
            ) : (
              <div className="space-y-2">
                {transactions.slice(0, 20).map(tx => (
                  <div key={tx.id} className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50">
                    <div className="flex items-center gap-3">
                      {tx.category && (
                        <span
                          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
                          style={{ backgroundColor: tx.category.color + '18', color: tx.category.color }}
                        >
                          {tx.category.icon} {tx.category.name}
                        </span>
                      )}
                      <span className="text-sm text-muted-foreground">{tx.description || 'No description'}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className={cn('text-sm font-semibold', tx.type === 'income' ? 'text-emerald-600' : 'text-red-600')}>
                        {tx.type === 'income' ? '+' : '-'}{formatCurrency(tx.amount)}
                      </span>
                      <span className="text-xs text-muted-foreground">{formatDate(tx.date)}</span>
                      <Button variant="ghost" size="icon-xs" onClick={() => handleDelete(tx.id)} className="text-destructive hover:text-destructive hover:bg-destructive/10">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <footer className="pb-8 pt-4 text-center">
          <p className="text-xs text-muted-foreground">Built with @shogo-ai/sdk + Hono</p>
        </footer>
      </main>
    </div>
  )
})

function AddTransactionForm({ userId, categories, onAdd }: { userId: string; categories: CategoryType[]; onAdd: () => void }) {
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState('expense')
  const [categoryId, setCategoryId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const filteredCategories = categories.filter(c => c.type === type)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!amount || !categoryId) return
    setLoading(true); setError('')
    try {
      const result = await api.transaction.create({ amount: parseFloat(amount), description: description || null, type, categoryId, userId, date: new Date().toISOString() } as any)
      if (!result.ok) { throw new Error(result.error?.message || 'Failed') }
      onAdd()
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed') }
    finally { setLoading(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="mb-6 rounded-lg border bg-muted/30 p-4 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Type</Label>
          <Select value={type} onValueChange={(v) => { setType(v); setCategoryId('') }}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="expense">Expense</SelectItem>
              <SelectItem value="income">Income</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="amount">Amount</Label>
          <Input id="amount" type="number" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} required min="0" step="0.01" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Category *</Label>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select category" />
            </SelectTrigger>
            <SelectContent>
              {filteredCategories.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.icon} {c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="desc">Description</Label>
          <Input id="desc" placeholder="Optional" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={loading} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white">
        {loading ? <><Loader2 className="h-4 w-4 animate-spin" />Adding...</> : <><Plus className="h-4 w-4" />Add Transaction</>}
      </Button>
    </form>
  )
}
