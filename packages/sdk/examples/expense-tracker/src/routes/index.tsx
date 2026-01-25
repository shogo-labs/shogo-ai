import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { createUser, type UserType } from '../utils/user'
import { getCategories, type CategoryType } from '../utils/categories'
import {
  getTransactions,
  createTransaction,
  deleteTransaction,
  type TransactionType,
} from '../utils/transactions'
import { getSummary, type SummaryType } from '../utils/summary'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    if (!context.user) {
      return {
        categories: [] as CategoryType[],
        transactions: [] as TransactionType[],
        summary: null as SummaryType | null,
      }
    }

    const [categories, transactions, summary] = await Promise.all([
      getCategories({ data: { userId: context.user.id } }),
      getTransactions({ data: { userId: context.user.id } }),
      getSummary({ data: { userId: context.user.id } }),
    ])

    return { categories, transactions, summary }
  },
  component: ExpenseTracker,
})

function ExpenseTracker() {
  const { user } = Route.useRouteContext()
  const { categories, transactions, summary } = Route.useLoaderData()
  const router = useRouter()

  if (!user) {
    return <SetupForm onComplete={() => router.invalidate()} />
  }

  return <Dashboard user={user} categories={categories} transactions={transactions} summary={summary!} />
}

function SetupForm({ onComplete }: { onComplete: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) return

    setLoading(true)
    setError('')

    try {
      await createUser({ data: { email, name: name || undefined } })
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create account')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-md text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Expense Tracker</h1>
        <p className="text-gray-500 mb-6">Track your income and expenses with ease.</p>
        
        <form onSubmit={handleSubmit} className="space-y-3 text-left">
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {loading ? 'Setting up...' : 'Get Started'}
          </button>
        </form>

        <p className="mt-6 text-xs text-gray-400">
          Built with TanStack Start + Prisma
        </p>
      </div>
    </div>
  )
}

function Dashboard({
  user,
  categories,
  transactions,
  summary,
}: {
  user: UserType
  categories: CategoryType[]
  transactions: TransactionType[]
  summary: SummaryType
}) {
  const router = useRouter()
  const [showAddForm, setShowAddForm] = useState(false)

  return (
    <div className="max-w-4xl mx-auto p-6">
      <header className="flex justify-between items-center mb-6 pb-4 border-b border-gray-200">
        <h1 className="text-2xl font-bold text-gray-900">Expense Tracker</h1>
        <span className="text-gray-500">{user.name || user.email}</span>
      </header>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl p-5 shadow-sm border-l-4 border-green-500">
          <p className="text-sm text-gray-500 mb-1">Income</p>
          <p className="text-2xl font-bold text-green-600">${summary.totalIncome.toFixed(2)}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-sm border-l-4 border-red-500">
          <p className="text-sm text-gray-500 mb-1">Expenses</p>
          <p className="text-2xl font-bold text-red-600">${summary.totalExpenses.toFixed(2)}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-sm border-l-4 border-blue-500">
          <p className="text-sm text-gray-500 mb-1">Balance</p>
          <p className={`text-2xl font-bold ${summary.balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            ${summary.balance.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Expenses by Category */}
      {summary.expensesByCategory && summary.expensesByCategory.length > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm mb-6">
          <h3 className="font-semibold text-gray-900 mb-4">Expenses by Category</h3>
          <div className="space-y-2">
            {summary.expensesByCategory.map(({ category, total }) => (
              <div key={category.id} className="flex justify-between py-2 border-b border-gray-50 last:border-0">
                <span className="text-gray-600">{category.icon} {category.name}</span>
                <span className="font-semibold" style={{ color: category.color }}>
                  ${total.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Transactions Section */}
      <div className="bg-white rounded-xl p-5 shadow-sm">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-900">Transactions</h3>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            {showAddForm ? 'Cancel' : '+ Add Transaction'}
          </button>
        </div>

        {showAddForm && (
          <AddTransactionForm
            userId={user.id}
            categories={categories}
            onAdd={() => {
              setShowAddForm(false)
              router.invalidate()
            }}
          />
        )}

        {/* Transaction List */}
        <div>
          {transactions.length === 0 ? (
            <p className="text-center text-gray-400 py-8">No transactions yet. Add one above!</p>
          ) : (
            transactions.map((tx) => (
              <TransactionItem
                key={tx.id}
                transaction={tx}
                onDelete={async () => {
                  await deleteTransaction({ data: { id: tx.id, userId: user.id } })
                  router.invalidate()
                }}
              />
            ))
          )}
        </div>
      </div>

      <footer className="text-center text-gray-400 text-sm mt-8">
        <p>Built with TanStack Start + Prisma Server Functions</p>
      </footer>
    </div>
  )
}

function AddTransactionForm({
  userId,
  categories,
  onAdd,
}: {
  userId: string
  categories: CategoryType[]
  onAdd: () => void
}) {
  const [type, setType] = useState<'expense' | 'income'>('expense')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [loading, setLoading] = useState(false)

  const filteredCategories = categories.filter((c) => c.type === type)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!amount || !categoryId) return

    setLoading(true)
    try {
      await createTransaction({
        data: {
          amount: parseFloat(amount),
          description: description || undefined,
          date,
          type,
          categoryId,
          userId,
        },
      })
      onAdd()
    } catch (err) {
      console.error('Failed to create transaction:', err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-gray-50 rounded-lg p-4 mb-4 space-y-3">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => { setType('expense'); setCategoryId('') }}
          className={`flex-1 py-2 rounded-lg font-semibold transition-colors ${
            type === 'expense' ? 'bg-red-500 text-white' : 'bg-gray-100 text-gray-600'
          }`}
        >
          Expense
        </button>
        <button
          type="button"
          onClick={() => { setType('income'); setCategoryId('') }}
          className={`flex-1 py-2 rounded-lg font-semibold transition-colors ${
            type === 'income' ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-600'
          }`}
        >
          Income
        </button>
      </div>

      <input
        type="number"
        placeholder="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        required
        min="0.01"
        step="0.01"
        className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      <select
        value={categoryId}
        onChange={(e) => setCategoryId(e.target.value)}
        required
        className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
      >
        <option value="">Select category</option>
        {filteredCategories.map((cat) => (
          <option key={cat.id} value={cat.id}>
            {cat.icon} {cat.name}
          </option>
        ))}
      </select>

      <input
        type="text"
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      <button
        type="submit"
        disabled={loading}
        className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
      >
        {loading ? 'Adding...' : 'Add Transaction'}
      </button>
    </form>
  )
}

function TransactionItem({
  transaction,
  onDelete,
}: {
  transaction: TransactionType
  onDelete: () => void
}) {
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async () => {
    setDeleting(true)
    await onDelete()
  }

  return (
    <div className="flex items-center py-3 border-b border-gray-50 last:border-0 gap-3">
      <span className="text-2xl">{transaction.category?.icon ?? '📁'}</span>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-gray-900">{transaction.category?.name ?? 'Unknown'}</p>
        <p className="text-sm text-gray-500 truncate">{transaction.description || 'No description'}</p>
        <p className="text-xs text-gray-400">{new Date(transaction.date).toLocaleDateString()}</p>
      </div>
      <p className={`text-lg font-bold ${transaction.type === 'income' ? 'text-green-600' : 'text-red-600'}`}>
        {transaction.type === 'income' ? '+' : '-'}${transaction.amount.toFixed(2)}
      </p>
      <button
        onClick={handleDelete}
        disabled={deleting}
        className="px-2 py-1 text-gray-400 border border-gray-200 rounded hover:bg-gray-50 transition-colors disabled:opacity-50"
      >
        {deleting ? '...' : '×'}
      </button>
    </div>
  )
}
