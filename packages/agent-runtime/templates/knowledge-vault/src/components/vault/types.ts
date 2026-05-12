export interface Citation {
  id: string
  source: string
  url: string
  date: string
  confidence: 'high' | 'medium' | 'low'
  claim: string
}

export interface Note {
  id: string
  title: string
  content: string
  entityType: 'concept' | 'person' | 'company' | 'technology' | 'event' | 'decision' | 'claim'
  source: string
  sourceUrl: string
  confidence: 'high' | 'medium' | 'low'
  lastVerified: string
  entities: string[]
  relatedNotes: string[]
  factTrueFrom: string
  factTrueUntil: string
  vaultLearned: string
  createdAt: string
  updatedAt: string
}

export interface Synthesis {
  id: string
  title: string
  pattern: string
  evidence: string[]
  evidenceCount: number
  confidence: 'high' | 'medium' | 'low'
  patternType: 'theme' | 'trend' | 'tension' | 'gap' | 'convergence'
  timeWindow: string
  createdAt: string
  updatedAt: string
}

export interface Research {
  id: string
  title: string
  query: string
  mode: 'quick' | 'deep'
  findings: string
  citations: Citation[]
  status: 'complete' | 'in_progress' | 'needs_followup'
  confidence: 'high' | 'medium' | 'low'
  gapsFilled: number
  contradictionsFound: number
  notesUpdated: number
  notesCreated: number
  createdAt: string
  updatedAt: string
}

export interface Contradiction {
  id: string
  noteAId: string
  noteBId: string
  claimA: string
  claimB: string
  status: 'unresolved' | 'resolved' | 'superseded'
  resolution: string | null
  createdAt: string
}

export interface VaultMetrics {
  totalNotes: number
  notesThisWeek: number
  orphanCount: number
  contradictionCount: number
  unresolvedContradictions: number
  synthesisCount: number
  staleNotes: number
  averageConfidence: number
  totalSources: number
  lastUpdated: string
}
