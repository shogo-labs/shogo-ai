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
import { api, configureApiClient } from './generated/api-client'
import { cn, formatCurrency, formatDate } from '@/lib/utils'

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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Package,
  DollarSign,
  AlertTriangle,
  XCircle,
  Plus,
  Minus,
  Trash2,
  ArrowDownToLine,
  ArrowUpFromLine,
  RefreshCw,
  LogOut,
  Loader2,
} from 'lucide-react'

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
      const [catsRes, supsRes, prodsRes, movsRes, summaryRes] = await Promise.all([
        api.category.list(),
        api.supplier.list(),
        api.product.list({ params: { include: 'category,supplier' } }),
        api.stockMovement.list({ limit: 10, params: { include: 'product' } }),
        fetch(`/api/summary?userId=${auth.user.id}`),
      ])

      if (catsRes.ok) {
        setCategories((catsRes.items || []) as any)
      }
      if (supsRes.ok) {
        setSuppliers((supsRes.items || []) as any)
      }
      if (prodsRes.ok) {
        setProducts((prodsRes.items || []) as any)
      }
      if (movsRes.ok) {
        setMovements((movsRes.items || []) as any)
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
    await api.product.delete(productId)
    fetchData()
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading inventory...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            <h1 className="text-lg font-semibold">Inventory Manager</h1>
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

      <main className="mx-auto max-w-6xl px-6 py-8 space-y-8">
        {/* Summary Cards */}
        {summary && (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardDescription>Total Products</CardDescription>
                <Package className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{summary.totalProducts}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardDescription>Inventory Value</CardDescription>
                <DollarSign className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(summary.totalValue)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardDescription>Low Stock</CardDescription>
                <AlertTriangle className="h-4 w-4 text-amber-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-amber-600">{summary.lowStockCount}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardDescription>Out of Stock</CardDescription>
                <XCircle className="h-4 w-4 text-destructive" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-destructive">{summary.outOfStockCount}</div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Low Stock Alert */}
        {summary && summary.lowStockProducts.length > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <CardTitle className="text-base">Low Stock Alerts</CardTitle>
              </div>
              <CardDescription>
                {summary.lowStockProducts.length} product{summary.lowStockProducts.length !== 1 ? 's' : ''} below minimum stock level
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {summary.lowStockProducts.slice(0, 5).map((product) => (
                  <div
                    key={product.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="text-sm font-medium">{product.name}</p>
                        <p className="text-xs text-muted-foreground">{product.sku}</p>
                      </div>
                    </div>
                    <Badge variant={product.quantity === 0 ? 'destructive' : 'secondary'} className={cn(
                      product.quantity === 0
                        ? ''
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                    )}>
                      {product.quantity} / {product.minQuantity} min
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Products by Category */}
        {summary && summary.productsByCategory.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Products by Category</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {summary.productsByCategory.map(({ category, count, value }) => (
                  <div key={category.id} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium"
                        style={{ backgroundColor: category.color + '18', color: category.color }}
                      >
                        {category.icon} {category.name}
                      </span>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">{count}</span> items{' '}
                      <span className="mx-1">·</span> {formatCurrency(value)}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Products Table */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Products</CardTitle>
                <CardDescription>{products.length} total products</CardDescription>
              </div>
              <Button onClick={() => setShowAddForm(!showAddForm)} size="sm">
                {showAddForm ? (
                  <>Cancel</>
                ) : (
                  <>
                    <Plus className="h-4 w-4" />
                    Add Product
                  </>
                )}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
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

            {products.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Package className="h-12 w-12 text-muted-foreground/40 mb-4" />
                <p className="text-sm text-muted-foreground">No products yet</p>
                <p className="text-xs text-muted-foreground mt-1">Add your first product to get started</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Stock</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {products.map((product) => (
                    <ProductRow
                      key={product.id}
                      product={product}
                      onDelete={() => handleDeleteProduct(product.id)}
                      onStock={(action) => setStockModal({ product, action })}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Recent Stock Movements */}
        {movements.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent Stock Movements</CardTitle>
              <CardDescription>Last {movements.length} stock changes</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {movements.map((movement) => (
                  <div key={movement.id} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {movement.type === 'in' ? (
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30">
                          <ArrowDownToLine className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                        </div>
                      ) : movement.type === 'out' ? (
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                          <ArrowUpFromLine className="h-4 w-4 text-red-600 dark:text-red-400" />
                        </div>
                      ) : (
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                          <RefreshCw className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-medium">{movement.product?.name ?? 'Unknown'}</p>
                        <p className="text-xs text-muted-foreground">
                          {movement.reason || (movement.type === 'in' ? 'Stock added' : 'Stock removed')}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <span
                        className={cn(
                          'text-sm font-semibold',
                          movement.type === 'in' && 'text-emerald-600 dark:text-emerald-400',
                          movement.type === 'out' && 'text-red-600 dark:text-red-400'
                        )}
                      >
                        {movement.type === 'in' ? '+' : movement.type === 'out' ? '-' : ''}
                        {movement.quantity}
                      </span>
                      <span className="text-xs text-muted-foreground w-20 text-right">
                        {formatDate(movement.createdAt)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stock Modal */}
        <StockModal
          product={stockModal?.product ?? null}
          action={stockModal?.action ?? 'add'}
          userId={auth.user!.id}
          open={!!stockModal}
          onClose={() => setStockModal(null)}
          onComplete={() => {
            setStockModal(null)
            fetchData()
          }}
        />

        <footer className="pb-8 pt-4 text-center">
          <p className="text-xs text-muted-foreground">Built with @shogo-ai/sdk + Hono</p>
        </footer>
      </main>
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
      const result = await api.product.create({
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
      } as any)

      if (!result.ok) {
        throw new Error(result.error?.message || 'Failed to create product')
      }

      onAdd()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create product')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mb-6 rounded-lg border bg-muted/30 p-4 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="name">Product name *</Label>
          <Input
            id="name"
            placeholder="e.g. Wireless Mouse"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sku">SKU *</Label>
          <Input
            id="sku"
            placeholder="e.g. WM-001"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            required
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Input
          id="description"
          placeholder="Optional product description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="price">Price</Label>
          <Input
            id="price"
            type="number"
            placeholder="0.00"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            min="0"
            step="0.01"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cost">Cost</Label>
          <Input
            id="cost"
            type="number"
            placeholder="0.00"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            min="0"
            step="0.01"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="quantity">Initial quantity</Label>
          <Input
            id="quantity"
            type="number"
            placeholder="0"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            min="0"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="minQuantity">Min quantity (low stock threshold)</Label>
          <Input
            id="minQuantity"
            type="number"
            placeholder="10"
            value={minQuantity}
            onChange={(e) => setMinQuantity(e.target.value)}
            min="0"
          />
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
              {categories.map((cat) => (
                <SelectItem key={cat.id} value={cat.id}>
                  {cat.icon} {cat.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Supplier</Label>
          <Select value={supplierId} onValueChange={setSupplierId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select supplier (optional)" />
            </SelectTrigger>
            <SelectContent>
              {suppliers.map((sup) => (
                <SelectItem key={sup.id} value={sup.id}>
                  {sup.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      <Button type="submit" disabled={loading} className="w-full">
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Adding...
          </>
        ) : (
          <>
            <Plus className="h-4 w-4" />
            Add Product
          </>
        )}
      </Button>
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
    if (product.quantity === 0)
      return { variant: 'destructive' as const, label: 'Out of Stock' }
    if (product.quantity < product.minQuantity)
      return { variant: 'secondary' as const, label: 'Low Stock', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' }
    return { variant: 'secondary' as const, label: 'In Stock', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' }
  }

  const status = getStockStatus()

  return (
    <TableRow>
      <TableCell>
        <div>
          <p className="font-medium">{product.name}</p>
          <p className="text-xs text-muted-foreground">{product.sku}</p>
        </div>
      </TableCell>
      <TableCell>
        {product.category && (
          <span
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
            style={{ backgroundColor: product.category.color + '18', color: product.category.color }}
          >
            {product.category.icon} {product.category.name}
          </span>
        )}
      </TableCell>
      <TableCell className="font-medium">{formatCurrency(product.price)}</TableCell>
      <TableCell>
        <Badge variant={status.variant} className={status.className}>
          {product.quantity} — {status.label}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onStock('add')}
            className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onStock('remove')}
            disabled={product.quantity === 0}
            className="text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-900/30"
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleDelete}
            disabled={deleting}
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

// =============================================================================
// Stock Modal
// =============================================================================

function StockModal({
  product,
  action,
  userId,
  open,
  onClose,
  onComplete,
}: {
  product: ProductType | null
  action: 'add' | 'remove'
  userId: string
  open: boolean
  onClose: () => void
  onComplete: () => void
}) {
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setQuantity('')
      setReason('')
      setError('')
    }
  }, [open])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!quantity || !product) return

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
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {action === 'add' ? (
              <ArrowDownToLine className="h-5 w-5 text-emerald-600" />
            ) : (
              <ArrowUpFromLine className="h-5 w-5 text-amber-600" />
            )}
            {action === 'add' ? 'Add Stock' : 'Remove Stock'}
          </DialogTitle>
          <DialogDescription>
            {product?.name} — Current stock: {product?.quantity} units
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="stock-qty">Quantity</Label>
            <Input
              id="stock-qty"
              type="number"
              placeholder="Enter quantity"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
              min="1"
              max={action === 'remove' && product ? product.quantity : undefined}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="stock-reason">Reason (optional)</Label>
            <Input
              id="stock-reason"
              placeholder="e.g. New shipment arrived"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={loading}
              variant={action === 'add' ? 'default' : 'secondary'}
              className={cn(
                action === 'add' && 'bg-emerald-600 hover:bg-emerald-700 text-white',
                action === 'remove' && 'bg-amber-500 hover:bg-amber-600 text-white'
              )}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : action === 'add' ? (
                'Add Stock'
              ) : (
                'Remove Stock'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
