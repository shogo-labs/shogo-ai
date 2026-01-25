import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { createUser, type UserType } from '../utils/user'
import { getCategories, type CategoryType } from '../utils/categories'
import { getSuppliers, type SupplierType } from '../utils/suppliers'
import {
  getProducts,
  createProduct,
  deleteProduct,
  type ProductType,
} from '../utils/products'
import { addStock, removeStock, getStockMovements, type StockMovementType } from '../utils/stock'
import { getSummary, type SummaryType } from '../utils/summary'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    if (!context.user) {
      return {
        categories: [] as CategoryType[],
        suppliers: [] as SupplierType[],
        products: [] as ProductType[],
        movements: [] as StockMovementType[],
        summary: null as SummaryType | null,
      }
    }

    const [categories, suppliers, products, movements, summary] = await Promise.all([
      getCategories({ data: { userId: context.user.id } }),
      getSuppliers({ data: { userId: context.user.id } }),
      getProducts({ data: { userId: context.user.id } }),
      getStockMovements({ data: { userId: context.user.id, limit: 10 } }),
      getSummary({ data: { userId: context.user.id } }),
    ])

    return { categories, suppliers, products, movements, summary }
  },
  component: InventoryManager,
})

function InventoryManager() {
  const { user } = Route.useRouteContext()
  const { categories, suppliers, products, movements, summary } = Route.useLoaderData()
  const router = useRouter()

  if (!user) {
    return <SetupForm onComplete={() => router.invalidate()} />
  }

  return (
    <Dashboard
      user={user}
      categories={categories}
      suppliers={suppliers}
      products={products}
      movements={movements}
      summary={summary!}
    />
  )
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
        <h1 className="text-2xl font-bold text-gray-900 mb-2">📦 Inventory Manager</h1>
        <p className="text-gray-500 mb-6">Track your products, stock levels, and suppliers.</p>
        
        <form onSubmit={handleSubmit} className="space-y-3 text-left">
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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

        <p className="mt-6 text-xs text-gray-400">Built with TanStack Start + Prisma</p>
      </div>
    </div>
  )
}

function Dashboard({
  user,
  categories,
  suppliers,
  products,
  movements,
  summary,
}: {
  user: UserType
  categories: CategoryType[]
  suppliers: SupplierType[]
  products: ProductType[]
  movements: StockMovementType[]
  summary: SummaryType
}) {
  const router = useRouter()
  const [showAddForm, setShowAddForm] = useState(false)
  const [stockModal, setStockModal] = useState<{ product: ProductType; action: 'add' | 'remove' } | null>(null)

  return (
    <div className="max-w-5xl mx-auto p-6">
      <header className="flex justify-between items-center mb-6 pb-4 border-b border-gray-200">
        <h1 className="text-2xl font-bold text-gray-900">📦 Inventory Manager</h1>
        <span className="text-gray-500">{user.name || user.email}</span>
      </header>

      {/* Summary Cards */}
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

      {/* Low Stock Alert */}
      {summary.lowStockProducts.length > 0 && (
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
      {summary.productsByCategory.length > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm mb-6">
          <h3 className="font-semibold text-gray-900 mb-4">Products by Category</h3>
          <div className="space-y-2">
            {summary.productsByCategory.map(({ category, count, value }) => (
              <div key={category.id} className="flex justify-between py-2 border-b border-gray-50 last:border-0">
                <span className="inline-flex items-center gap-2 px-2 py-1 rounded text-sm" style={{ backgroundColor: category.color + '20', color: category.color }}>
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
            userId={user.id}
            categories={categories}
            suppliers={suppliers}
            onAdd={() => {
              setShowAddForm(false)
              router.invalidate()
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
                    onDelete={async () => {
                      await deleteProduct({ data: { id: product.id, userId: user.id } })
                      router.invalidate()
                    }}
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
          userId={user.id}
          onClose={() => setStockModal(null)}
          onComplete={() => {
            setStockModal(null)
            router.invalidate()
          }}
        />
      )}

      <footer className="text-center text-gray-400 text-sm mt-8">
        <p>Built with TanStack Start + Prisma Server Functions</p>
      </footer>
    </div>
  )
}

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
      await createProduct({
        data: {
          name,
          sku,
          description: description || undefined,
          price: price ? parseFloat(price) : 0,
          cost: cost ? parseFloat(cost) : 0,
          quantity: quantity ? parseInt(quantity) : 0,
          minQuantity: minQuantity ? parseInt(minQuantity) : 10,
          categoryId,
          supplierId: supplierId || undefined,
          userId,
        },
      })
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
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs" style={{ backgroundColor: product.category.color + '20', color: product.category.color }}>
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
      if (action === 'add') {
        await addStock({ data: { productId: product.id, quantity: qty, reason: reason || undefined, userId } })
      } else {
        await removeStock({ data: { productId: product.id, quantity: qty, reason: reason || undefined, userId } })
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
