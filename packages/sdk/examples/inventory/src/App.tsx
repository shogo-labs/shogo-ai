/**
 * Inventory Manager App
 * 
 * Uses Hono API routes and MobX for state management.
 * Full inventory management with products, categories, suppliers, and stock tracking.
 */

import { useState, useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'

// Types
interface CategoryType {
  id: string
  name: string
  icon: string
  color: string
  userId: string
}

interface SupplierType {
  id: string
  name: string
  email: string | null
  phone: string | null
  address: string | null
  userId: string
}

interface ProductType {
  id: string
  name: string
  sku: string
  description: string | null
  price: number
  cost: number
  quantity: number
  minQuantity: number
  categoryId: string
  supplierId: string | null
  userId: string
  category?: CategoryType
  supplier?: SupplierType
}

interface StockMovementType {
  id: string
  type: string
  quantity: number
  reason: string | null
  productId: string
  userId: string
  createdAt: string
  product?: ProductType
}

interface SummaryType {
  totalProducts: number
  totalValue: number
  lowStockCount: number
  outOfStockCount: number
  lowStockProducts: ProductType[]
  productsByCategory: { category: CategoryType; count: number; value: number }[]
}

export default function App() {
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  )
}

// =============================================================================
// Dashboard
// =============================================================================

const Dashboard = observer(function Dashboard() {
  const { auth } = useStores()
  const [categories, setCategories] = useState<CategoryType[]>([])
  const [suppliers, setSuppliers] = useState<SupplierType[]>([])
  const [products, setProducts] = useState<ProductType[]>([])
  const [movements, setMovements] = useState<StockMovementType[]>([])
  const [summary, setSummary] = useState<SummaryType | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [stockModal, setStockModal] = useState<{ product: ProductType; action: 'add' | 'remove' } | null>(null)

  const fetchData = useCallback(async () => {
    if (!auth.user) return

    try {
      const [catsRes, supsRes, prodsRes, movsRes, summaryRes] = await Promise.all([
        fetch(`/api/categories?userId=${auth.user.id}`),
        fetch(`/api/suppliers?userId=${auth.user.id}`),
        fetch(`/api/products?userId=${auth.user.id}&include=category,supplier`),
        fetch(`/api/stockmovements?userId=${auth.user.id}&limit=10&include=product`),
        fetch(`/api/summary?userId=${auth.user.id}`),
      ])

      if (catsRes.ok) {
        const data = await catsRes.json()
        setCategories(data.items || [])
      }
      if (supsRes.ok) {
        const data = await supsRes.json()
        setSuppliers(data.items || [])
      }
      if (prodsRes.ok) {
        const data = await prodsRes.json()
        setProducts(data.items || [])
      }
      if (movsRes.ok) {
        const data = await movsRes.json()
        setMovements(data.items || [])
      }
      if (summaryRes.ok) {
        setSummary(await summaryRes.json())
      }
    } catch (err) {
      console.error('Failed to fetch data:', err)
    } finally {
      setLoading(false)
    }
  }, [auth.user])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleDeleteProduct = async (productId: string) => {
    if (!confirm('Delete this product?')) return
    await fetch(`/api/products/${productId}`, { method: 'DELETE' })
    fetchData()
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <header className="flex justify-between items-center mb-6 pb-4 border-b border-gray-200">
        <h1 className="text-2xl font-bold text-gray-900">📦 Inventory Manager</h1>
        <div className="flex items-center gap-4">
          <span className="text-gray-500">{auth.user?.name || auth.user?.email}</span>
          <button
            onClick={() => auth.signOut()}
            className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-xl p-5 shadow-sm border-l-4 border-blue-500">
            <p className="text-sm text-gray-500 mb-1">Total Products</p>
            <p className="text-2xl font-bold text-blue-600">{summary.totalProducts}</p>
          </div>
          <div className="bg-white rounded-xl p-5 shadow-sm border-l-4 border-green-500">
            <p className="text-sm text-gray-500 mb-1">Inventory Value</p>
            <p className="text-2xl font-bold text-green-600">${summary.totalValue.toFixed(2)}</p>
          </div>
          <div className="bg-white rounded-xl p-5 shadow-sm border-l-4 border-yellow-500">
            <p className="text-sm text-gray-500 mb-1">Low Stock</p>
            <p className="text-2xl font-bold text-yellow-600">{summary.lowStockCount}</p>
          </div>
          <div className="bg-white rounded-xl p-5 shadow-sm border-l-4 border-red-500">
            <p className="text-sm text-gray-500 mb-1">Out of Stock</p>
            <p className="text-2xl font-bold text-red-600">{summary.outOfStockCount}</p>
          </div>
        </div>
      )}

      {/* Low Stock Alert */}
      {summary && summary.lowStockProducts.length > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm mb-6">
          <h3 className="font-semibold text-gray-900 mb-4">⚠️ Low Stock Alert</h3>
          <div className="space-y-2">
            {summary.lowStockProducts.slice(0, 5).map((product) => (
              <div key={product.id} className="flex justify-between items-center p-3 bg-yellow-50 rounded-lg">
                <div>
                  <span className="font-medium text-gray-900">{product.name}</span>
                  <span className="text-gray-500 text-sm ml-2">({product.sku})</span>
                </div>
                <span className={`font-semibold ${product.quantity === 0 ? 'text-red-600' : 'text-yellow-600'}`}>
                  {product.quantity} / {product.minQuantity} min
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Products by Category */}
      {summary && summary.productsByCategory.length > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm mb-6">
          <h3 className="font-semibold text-gray-900 mb-4">Products by Category</h3>
          <div className="space-y-2">
            {summary.productsByCategory.map(({ category, count, value }) => (
              <div key={category.id} className="flex justify-between py-2 border-b border-gray-50 last:border-0">
                <span
                  className="inline-flex items-center gap-2 px-2 py-1 rounded text-sm"
                  style={{ backgroundColor: category.color + '20', color: category.color }}
                >
                  {category.icon} {category.name}
                </span>
                <span className="text-gray-600">
                  <strong>{count}</strong> items · ${value.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Products Section */}
      <div className="bg-white rounded-xl p-5 shadow-sm mb-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-900">Products</h3>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            {showAddForm ? 'Cancel' : '+ Add Product'}
          </button>
        </div>

        {showAddForm && (
          <AddProductForm
            userId={auth.user!.id}
            categories={categories}
            suppliers={suppliers}
            onAdd={() => {
              setShowAddForm(false)
              fetchData()
            }}
          />
        )}

        {/* Product Table */}
        {products.length === 0 ? (
          <p className="text-center text-gray-400 py-8">No products yet. Add one above!</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-sm text-gray-500 border-b border-gray-100">
                  <th className="py-3 px-2 font-medium">Product</th>
                  <th className="py-3 px-2 font-medium">Category</th>
                  <th className="py-3 px-2 font-medium">Price</th>
                  <th className="py-3 px-2 font-medium">Stock</th>
                  <th className="py-3 px-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    onDelete={() => handleDeleteProduct(product.id)}
                    onStock={(action) => setStockModal({ product, action })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent Activity */}
      {movements.length > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <h3 className="font-semibold text-gray-900 mb-4">Recent Stock Movements</h3>
          <div className="space-y-2">
            {movements.map((movement) => (
              <div key={movement.id} className="flex justify-between py-2 border-b border-gray-50 last:border-0">
                <span className="text-gray-600">
                  {movement.type === 'in' ? '📥' : movement.type === 'out' ? '📤' : '🔄'}{' '}
                  {movement.product?.name ?? 'Unknown'} —{' '}
                  <span className={movement.type === 'in' ? 'text-green-600' : movement.type === 'out' ? 'text-red-600' : 'text-gray-500'}>
                    {movement.type === 'in' ? '+' : movement.type === 'out' ? '-' : ''}{movement.quantity}
                  </span>
                </span>
                <span className="text-gray-400 text-sm">{new Date(movement.createdAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stock Modal */}
      {stockModal && (
        <StockModal
          product={stockModal.product}
          action={stockModal.action}
          userId={auth.user!.id}
          onClose={() => setStockModal(null)}
          onComplete={() => {
            setStockModal(null)
            fetchData()
          }}
        />
      )}

      <footer className="text-center text-gray-400 text-sm mt-8">
        <p>Built with @shogo-ai/sdk + Hono</p>
      </footer>
    </div>
  )
})

// =============================================================================
// Add Product Form
// =============================================================================

function AddProductForm({
  userId,
  categories,
  suppliers,
  onAdd,
}: {
  userId: string
  categories: CategoryType[]
  suppliers: SupplierType[]
  onAdd: () => void
}) {
  const [name, setName] = useState('')
  const [sku, setSku] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [cost, setCost] = useState('')
  const [quantity, setQuantity] = useState('')
  const [minQuantity, setMinQuantity] = useState('10')
  const [categoryId, setCategoryId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || !sku || !categoryId) return

    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          sku,
          description: description || null,
          price: price ? parseFloat(price) : 0,
          cost: cost ? parseFloat(cost) : 0,
          quantity: quantity ? parseInt(quantity) : 0,
          minQuantity: minQuantity ? parseInt(minQuantity) : 10,
          categoryId,
          supplierId: supplierId || null,
          userId,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error?.message || 'Failed to create product')
      }

      onAdd()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create product')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-gray-50 rounded-lg p-4 mb-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <input
          type="text"
          placeholder="Product name *"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="text"
          placeholder="SKU *"
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          required
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <input
        type="text"
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      <div className="grid grid-cols-2 gap-3">
        <input
          type="number"
          placeholder="Price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          min="0"
          step="0.01"
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="number"
          placeholder="Cost"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          min="0"
          step="0.01"
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <input
          type="number"
          placeholder="Initial quantity"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          min="0"
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="number"
          placeholder="Min quantity (low stock)"
          value={minQuantity}
          onChange={(e) => setMinQuantity(e.target.value)}
          min="0"
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          required
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        >
          <option value="">Select category *</option>
          {categories.map((cat) => (
            <option key={cat.id} value={cat.id}>{cat.icon} {cat.name}</option>
          ))}
        </select>

        <select
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        >
          <option value="">Select supplier (optional)</option>
          {suppliers.map((sup) => (
            <option key={sup.id} value={sup.id}>{sup.name}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
      >
        {loading ? 'Adding...' : 'Add Product'}
      </button>
    </form>
  )
}

// =============================================================================
// Product Row
// =============================================================================

function ProductRow({
  product,
  onDelete,
  onStock,
}: {
  product: ProductType
  onDelete: () => void
  onStock: (action: 'add' | 'remove') => void
}) {
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async () => {
    setDeleting(true)
    await onDelete()
  }

  const getStockStatus = () => {
    if (product.quantity === 0) return { className: 'bg-red-100 text-red-700', label: 'Out of Stock' }
    if (product.quantity < product.minQuantity) return { className: 'bg-yellow-100 text-yellow-700', label: 'Low Stock' }
    return { className: 'bg-green-100 text-green-700', label: 'In Stock' }
  }

  const status = getStockStatus()

  return (
    <tr className="border-b border-gray-50 hover:bg-gray-50">
      <td className="py-3 px-2">
        <div className="font-medium text-gray-900">{product.name}</div>
        <div className="text-xs text-gray-400">{product.sku}</div>
      </td>
      <td className="py-3 px-2">
        {product.category && (
          <span
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs"
            style={{ backgroundColor: product.category.color + '20', color: product.category.color }}
          >
            {product.category.icon} {product.category.name}
          </span>
        )}
      </td>
      <td className="py-3 px-2 text-gray-900">${product.price.toFixed(2)}</td>
      <td className="py-3 px-2">
        <span className={`px-2 py-1 rounded text-xs font-medium ${status.className}`}>
          {product.quantity} ({status.label})
        </span>
      </td>
      <td className="py-3 px-2">
        <div className="flex gap-1">
          <button
            onClick={() => onStock('add')}
            className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
          >
            +
          </button>
          <button
            onClick={() => onStock('remove')}
            disabled={product.quantity === 0}
            className="px-2 py-1 text-xs bg-yellow-500 text-white rounded hover:bg-yellow-600 disabled:opacity-50"
          >
            -
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-2 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50 disabled:opacity-50"
          >
            {deleting ? '...' : '×'}
          </button>
        </div>
      </td>
    </tr>
  )
}

// =============================================================================
// Stock Modal
// =============================================================================

function StockModal({
  product,
  action,
  userId,
  onClose,
  onComplete,
}: {
  product: ProductType
  action: 'add' | 'remove'
  userId: string
  onClose: () => void
  onComplete: () => void
}) {
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!quantity) return

    const qty = parseInt(quantity)
    if (qty <= 0) {
      setError('Quantity must be positive')
      return
    }

    if (action === 'remove' && qty > product.quantity) {
      setError('Cannot remove more than available stock')
      return
    }

    setLoading(true)
    setError('')

    try {
      const endpoint = action === 'add' ? '/api/stock/add' : '/api/stock/remove'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: product.id,
          quantity: qty,
          reason: reason || null,
          userId,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to update stock')
      }

      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update stock')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">
          {action === 'add' ? '📥 Add Stock' : '📤 Remove Stock'}
        </h3>
        <p className="text-gray-500 mb-4">
          {product.name} — Current: {product.quantity} units
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="number"
            placeholder="Quantity"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            required
            min="1"
            max={action === 'remove' ? product.quantity : undefined}
            autoFocus
            className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="text"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-3 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className={`flex-1 px-4 py-3 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                action === 'add' ? 'bg-green-600 hover:bg-green-700' : 'bg-yellow-500 hover:bg-yellow-600'
              }`}
            >
              {loading ? 'Updating...' : action === 'add' ? 'Add Stock' : 'Remove Stock'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
