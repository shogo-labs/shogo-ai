export interface DatasetType {
  id: string
  name: string
  description?: string
  source?: string
  rowCount: number
  columns: string
  userId: string
  createdAt: Date
  updatedAt: Date
}

export interface DatasetCreateInput {
  name: string
  description?: string
  source?: string
  rowCount?: number
  columns?: string
  userId: string
}

export interface DatasetUpdateInput {
  name?: string
  description?: string
  source?: string
  rowCount?: number
  columns?: string
}
