export interface SavedQueryType {
  id: string
  name: string
  description?: string
  query: string
  datasetId: string
  userId: string
  createdAt: Date
  updatedAt: Date
}

export interface SavedQueryCreateInput {
  name: string
  description?: string
  query: string
  datasetId: string
  userId: string
}

export interface SavedQueryUpdateInput {
  name?: string
  description?: string
  query?: string
}
