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
  // Access user from context (loaded in __root.tsx)
  loader: async ({ context }) => {
    // If no user, return empty state for setup
    if (!context.user) {
      return {
        categories: [] as CategoryType[],
        transactions: [] as TransactionType[],
        summary: null as SummaryType | null,
      }
    }

    // Load all dashboard data in parallel for authenticated user
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

  // Show setup form if no user exists
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
    <div className="app">
      <div className="setup-container">
        <div className="setup-card">
          <h1>Expense Tracker</h1>
          <p>Track your income and expenses with ease.</p>
          
          <form onSubmit={handleSubmit} className="form">
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="input"
            />
            <input
              type="text"
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input"
            />
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={loading} className="btn btn-primary">
              {loading ? 'Setting up...' : 'Get Started'}
            </button>
          </form>

          <p className="setup-footer">
            Built with TanStack Start + Prisma
          </p>
        </div>
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
    <div className="app">
      <header className="header">
        <h1>Expense Tracker</h1>
        <div className="user-info">
          <span>{user.name || user.email}</span>
        </div>
      </header>

      {/* Summary Cards */}
      <div className="summary-grid">
        <div className="summary-card" style={{ borderLeftColor: '#22C55E' }}>
          <div className="card-label">Income</div>
          <div className="card-value" style={{ color: '#22C55E' }}>
            ${summary.totalIncome.toFixed(2)}
          </div>
        </div>
        <div className="summary-card" style={{ borderLeftColor: '#EF4444' }}>
          <div className="card-label">Expenses</div>
          <div className="card-value" style={{ color: '#EF4444' }}>
            ${summary.totalExpenses.toFixed(2)}
          </div>
        </div>
        <div className="summary-card" style={{ borderLeftColor: '#3B82F6' }}>
          <div className="card-label">Balance</div>
          <div
            className="card-value"
            style={{ color: summary.balance >= 0 ? '#22C55E' : '#EF4444' }}
          >
            ${summary.balance.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Expenses by Category */}
      {summary.expensesByCategory && summary.expensesByCategory.length > 0 && (
        <div className="section">
          <h3>Expenses by Category</h3>
          <div className="category-breakdown">
            {summary.expensesByCategory.map(({ category, total }) => (
              <div key={category.id} className="category-row">
                <span>
                  {category.icon} {category.name}
                </span>
                <span style={{ color: category.color, fontWeight: 600 }}>
                  ${total.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Transactions Section */}
      <div className="section">
        <div className="section-header">
          <h3>Transactions</h3>
          <button
            className="btn btn-primary"
            onClick={() => setShowAddForm(!showAddForm)}
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
        <div className="transaction-list">
          {transactions.length === 0 ? (
            <p className="empty">No transactions yet. Add one above!</p>
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

      <footer style={{ textAlign: 'center', color: '#666', fontSize: '0.875rem', marginTop: '2rem' }}>
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
    <form onSubmit={handleSubmit} className="form">
      <div className="type-toggle">
        <button
          type="button"
          className="type-btn"
          onClick={() => {
            setType('expense')
            setCategoryId('')
          }}
          style={{
            backgroundColor: type === 'expense' ? '#EF4444' : '#f5f5f5',
            color: type === 'expense' ? 'white' : '#666',
          }}
        >
          Expense
        </button>
        <button
          type="button"
          className="type-btn"
          onClick={() => {
            setType('income')
            setCategoryId('')
          }}
          style={{
            backgroundColor: type === 'income' ? '#22C55E' : '#f5f5f5',
            color: type === 'income' ? 'white' : '#666',
          }}
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
        className="input"
      />

      <select
        value={categoryId}
        onChange={(e) => setCategoryId(e.target.value)}
        required
        className="input"
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
        className="input"
      />

      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="input"
      />

      <button type="submit" disabled={loading} className="btn btn-primary">
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
    <div className="transaction-item">
      <div className="tx-left">
        <span className="tx-icon">{transaction.category?.icon ?? '📁'}</span>
        <div className="tx-details">
          <div className="tx-category">
            {transaction.category?.name ?? 'Unknown'}
          </div>
          <div className="tx-desc">
            {transaction.description || 'No description'}
          </div>
          <div className="tx-date">
            {new Date(transaction.date).toLocaleDateString()}
          </div>
        </div>
      </div>
      <div
        className="tx-amount"
        style={{
          color: transaction.type === 'income' ? '#22C55E' : '#EF4444',
        }}
      >
        {transaction.type === 'income' ? '+' : '-'}${transaction.amount.toFixed(2)}
      </div>
      <button
        onClick={handleDelete}
        disabled={deleting}
        className="btn btn-danger"
      >
        {deleting ? '...' : '×'}
      </button>
    </div>
  )
}
