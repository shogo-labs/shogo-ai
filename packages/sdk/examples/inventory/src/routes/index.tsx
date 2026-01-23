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
  // Access user from context (loaded in __root.tsx)
  loader: async ({ context }) => {
    // If no user, return empty state for setup
    if (!context.user) {
      return {
        categories: [] as CategoryType[],
        suppliers: [] as SupplierType[],
        products: [] as ProductType[],
        movements: [] as StockMovementType[],
        summary: null as SummaryType | null,
      }
    }

    // Load all dashboard data in parallel for authenticated user
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

  // Show setup form if no user exists
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
    <div className="app">
      <div className="setup-container">
        <div className="setup-card">
          <h1>📦 Inventory Manager</h1>
          <p>Track your products, stock levels, and suppliers.</p>
          
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
    <div className="app">
      <header className="header">
        <h1>📦 Inventory Manager</h1>
        <div className="user-info">
          <span>{user.name || user.email}</span>
        </div>
      </header>

      {/* Summary Cards */}
      <div className="summary-grid">
        <div className="summary-card" style={{ borderLeftColor: '#3B82F6' }}>
          <div className="card-label">Total Products</div>
          <div className="card-value" style={{ color: '#3B82F6' }}>
            {summary.totalProducts}
          </div>
        </div>
        <div className="summary-card" style={{ borderLeftColor: '#22C55E' }}>
          <div className="card-label">Inventory Value</div>
          <div className="card-value" style={{ color: '#22C55E' }}>
            ${summary.totalValue.toFixed(2)}
          </div>
        </div>
        <div className="summary-card" style={{ borderLeftColor: '#F59E0B' }}>
          <div className="card-label">Low Stock</div>
          <div className="card-value" style={{ color: '#F59E0B' }}>
            {summary.lowStockCount}
          </div>
        </div>
        <div className="summary-card" style={{ borderLeftColor: '#EF4444' }}>
          <div className="card-label">Out of Stock</div>
          <div className="card-value" style={{ color: '#EF4444' }}>
            {summary.outOfStockCount}
          </div>
        </div>
      </div>

      {/* Low Stock Alert */}
      {summary.lowStockProducts.length > 0 && (
        <div className="section">
          <h3>⚠️ Low Stock Alert</h3>
          <div className="low-stock-list">
            {summary.lowStockProducts.slice(0, 5).map((product) => (
              <div key={product.id} className="low-stock-item">
                <div>
                  <span className="product-name">{product.name}</span>
                  <span className="product-sku"> ({product.sku})</span>
                </div>
                <div>
                  <span style={{ fontWeight: 600, color: product.quantity === 0 ? '#DC2626' : '#D97706' }}>
                    {product.quantity} / {product.minQuantity} min
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Products by Category */}
      {summary.productsByCategory.length > 0 && (
        <div className="section">
          <h3>Products by Category</h3>
          <div className="category-breakdown">
            {summary.productsByCategory.map(({ category, count, value }) => (
              <div key={category.id} className="category-row">
                <span>
                  <span
                    className="category-badge"
                    style={{ backgroundColor: category.color + '20', color: category.color }}
                  >
                    {category.icon} {category.name}
                  </span>
                </span>
                <span>
                  <strong>{count}</strong> items · ${value.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Products Section */}
      <div className="section">
        <div className="section-header">
          <h3>Products</h3>
          <button
            className="btn btn-primary"
            onClick={() => setShowAddForm(!showAddForm)}
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
          <p className="empty">No products yet. Add one above!</p>
        ) : (
          <table className="product-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Price</th>
                <th>Stock</th>
                <th>Actions</th>
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
        )}
      </div>

      {/* Recent Activity */}
      {movements.length > 0 && (
        <div className="section">
          <h3>Recent Stock Movements</h3>
          <div className="category-breakdown">
            {movements.map((movement) => (
              <div key={movement.id} className="category-row">
                <span>
                  {movement.type === 'in' ? '📥' : movement.type === 'out' ? '📤' : '🔄'}{' '}
                  {movement.product?.name ?? 'Unknown'} —{' '}
                  <span style={{ color: movement.type === 'in' ? '#22C55E' : movement.type === 'out' ? '#EF4444' : '#6B7280' }}>
                    {movement.type === 'in' ? '+' : movement.type === 'out' ? '-' : ''}{movement.quantity}
                  </span>
                </span>
                <span style={{ color: '#999', fontSize: '0.875rem' }}>
                  {new Date(movement.createdAt).toLocaleDateString()}
                </span>
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

      <footer style={{ textAlign: 'center', color: '#666', fontSize: '0.875rem', marginTop: '2rem' }}>
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
    <form onSubmit={handleSubmit} className="form">
      <div className="form-row">
        <input
          type="text"
          placeholder="Product name *"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="input"
        />
        <input
          type="text"
          placeholder="SKU *"
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          required
          className="input"
        />
      </div>

      <input
        type="text"
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="input"
      />

      <div className="form-row">
        <input
          type="number"
          placeholder="Price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          min="0"
          step="0.01"
          className="input"
        />
        <input
          type="number"
          placeholder="Cost"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          min="0"
          step="0.01"
          className="input"
        />
      </div>

      <div className="form-row">
        <input
          type="number"
          placeholder="Initial quantity"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          min="0"
          className="input"
        />
        <input
          type="number"
          placeholder="Min quantity (low stock)"
          value={minQuantity}
          onChange={(e) => setMinQuantity(e.target.value)}
          min="0"
          className="input"
        />
      </div>

      <div className="form-row">
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          required
          className="input"
        >
          <option value="">Select category *</option>
          {categories.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.icon} {cat.name}
            </option>
          ))}
        </select>

        <select
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          className="input"
        >
          <option value="">Select supplier (optional)</option>
          {suppliers.map((sup) => (
            <option key={sup.id} value={sup.id}>
              {sup.name}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error">{error}</p>}

      <button type="submit" disabled={loading} className="btn btn-primary">
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
    if (product.quantity === 0) return { class: 'stock-out', label: 'Out of Stock' }
    if (product.quantity < product.minQuantity) return { class: 'stock-low', label: 'Low Stock' }
    return { class: 'stock-ok', label: 'In Stock' }
  }

  const status = getStockStatus()

  return (
    <tr>
      <td>
        <div className="product-name">{product.name}</div>
        <div className="product-sku">{product.sku}</div>
      </td>
      <td>
        {product.category && (
          <span
            className="category-badge"
            style={{ backgroundColor: product.category.color + '20', color: product.category.color }}
          >
            {product.category.icon} {product.category.name}
          </span>
        )}
      </td>
      <td>${product.price.toFixed(2)}</td>
      <td>
        <span className={`stock-badge ${status.class}`}>
          {product.quantity} ({status.label})
        </span>
      </td>
      <td>
        <div className="actions">
          <button className="btn btn-success btn-sm" onClick={() => onStock('add')}>
            +
          </button>
          <button
            className="btn btn-warning btn-sm"
            onClick={() => onStock('remove')}
            disabled={product.quantity === 0}
          >
            -
          </button>
          <button onClick={handleDelete} disabled={deleting} className="btn btn-danger">
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{action === 'add' ? '📥 Add Stock' : '📤 Remove Stock'}</h3>
        <p style={{ color: '#666', marginBottom: 16 }}>
          {product.name} — Current: {product.quantity} units
        </p>

        <form onSubmit={handleSubmit} className="form" style={{ background: 'transparent', padding: 0 }}>
          <input
            type="number"
            placeholder="Quantity"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            required
            min="1"
            max={action === 'remove' ? product.quantity : undefined}
            className="input"
            autoFocus
          />
          <input
            type="text"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="input"
          />
          {error && <p className="error">{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} className="btn btn-secondary" style={{ flex: 1 }}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className={`btn ${action === 'add' ? 'btn-success' : 'btn-warning'}`}
              style={{ flex: 1 }}
            >
              {loading ? 'Updating...' : action === 'add' ? 'Add Stock' : 'Remove Stock'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
