/**
 * Expense Tracker App
 */

import { useState, useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'
import { api, configureApiClient } from './generated/api-client'

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

  const fetchData = useCallback(async () => {
    if (!auth.user) return
    try {
      // Use API client for standard CRUD, raw fetch only for custom endpoints
      const [txRes, catRes, sumRes] = await Promise.all([
        api.transaction.list({ params: { include: 'category' } }),
        api.category.list(),
        fetch(`/api/summary?userId=${auth.user.id}`),
      ])
      if (txRes.ok) { setTransactions((txRes.items || []) as any) }
      if (catRes.ok) { setCategories((catRes.items || []) as any) }
      if (sumRes.ok) setSummary(await sumRes.json())
    } catch (err) { console.error('Failed to fetch:', err) }
    finally { setLoading(false) }
  }, [auth.user])

  useEffect(() => { fetchData() }, [fetchData])

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this transaction?')) return
    await api.transaction.delete(id)
    fetchData()
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center"><p className="text-gray-500">Loading...</p></div>

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">💰 Expense Tracker</h1>
        <div className="flex items-center gap-4">
          <span className="text-gray-500">{auth.user?.name || auth.user?.email}</span>
          <button onClick={() => auth.signOut()} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Sign Out</button>
        </div>
      </header>

      <div className="max-w-4xl mx-auto p-6">
        {/* Summary */}
        {summary && (
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-white rounded-xl p-5 shadow-sm">
              <p className="text-sm text-gray-500 mb-1">Income</p>
              <p className="text-2xl font-bold text-green-600">+${summary.totalIncome.toFixed(2)}</p>
            </div>
            <div className="bg-white rounded-xl p-5 shadow-sm">
              <p className="text-sm text-gray-500 mb-1">Expenses</p>
              <p className="text-2xl font-bold text-red-600">-${summary.totalExpenses.toFixed(2)}</p>
            </div>
            <div className="bg-white rounded-xl p-5 shadow-sm">
              <p className="text-sm text-gray-500 mb-1">Balance</p>
              <p className={`text-2xl font-bold ${summary.balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                ${summary.balance.toFixed(2)}
              </p>
            </div>
          </div>
        )}

        {/* Transactions */}
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold text-gray-900">Transactions</h3>
            <button onClick={() => setShowAddForm(!showAddForm)} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
              {showAddForm ? 'Cancel' : '+ Add Transaction'}
            </button>
          </div>

          {showAddForm && (
            <AddTransactionForm userId={auth.user!.id} categories={categories} onAdd={() => { setShowAddForm(false); fetchData() }} />
          )}

          {transactions.length === 0 ? (
            <p className="text-center text-gray-400 py-8">No transactions yet</p>
          ) : (
            <div className="space-y-2">
              {transactions.slice(0, 20).map(tx => (
                <div key={tx.id} className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <span style={{ backgroundColor: tx.category?.color + '20', color: tx.category?.color, padding: '0.25rem 0.5rem', borderRadius: '0.25rem', fontSize: '0.875rem' }}>
                      {tx.category?.icon} {tx.category?.name}
                    </span>
                    <span className="text-gray-600">{tx.description || 'No description'}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className={`font-semibold ${tx.type === 'income' ? 'text-green-600' : 'text-red-600'}`}>
                      {tx.type === 'income' ? '+' : '-'}${tx.amount.toFixed(2)}
                    </span>
                    <span className="text-gray-400 text-sm">{new Date(tx.date).toLocaleDateString()}</span>
                    <button onClick={() => handleDelete(tx.id)} className="text-red-500 text-sm hover:text-red-700">×</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="text-center text-gray-400 text-sm mt-6">Built with @shogo-ai/sdk + Hono</footer>
      </div>
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
    <form onSubmit={handleSubmit} className="bg-gray-50 rounded-lg p-4 mb-4 space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <select value={type} onChange={(e) => { setType(e.target.value); setCategoryId('') }} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm bg-white">
          <option value="expense">Expense</option>
          <option value="income">Income</option>
        </select>
        <input type="number" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} required min="0" step="0.01" className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm bg-white">
          <option value="">Select category *</option>
          {filteredCategories.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
        </select>
        <input type="text" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <button type="submit" disabled={loading} className="w-full px-4 py-3 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
        {loading ? 'Adding...' : 'Add Transaction'}
      </button>
    </form>
  )
}
