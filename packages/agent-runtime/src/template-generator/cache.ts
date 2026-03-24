// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Template Generator Cache
 *
 * SQLite cache that tracks which bundled skills have been processed
 * and assigned to which template, preventing redundant LLM calls.
 */

import { Database } from 'bun:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const CACHE_DB_PATH = join(__dirname, '..', '..', 'templates', '.cache.db')

export interface ProcessedSkill {
  name: string
  contentHash: string
  templateId: string
  processedAt: string
}

export class TemplateCache {
  private db: Database

  constructor(dbPath: string = CACHE_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_skills (
        name TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        template_id TEXT NOT NULL,
        processed_at TEXT NOT NULL
      )
    `)
  }

  getProcessedSkills(): ProcessedSkill[] {
    return this.db
      .query('SELECT name, content_hash as contentHash, template_id as templateId, processed_at as processedAt FROM processed_skills')
      .all() as ProcessedSkill[]
  }

  getSkillTemplateId(skillName: string): string | null {
    const row = this.db
      .query('SELECT template_id FROM processed_skills WHERE name = ?')
      .get(skillName) as { template_id: string } | null
    return row?.template_id ?? null
  }

  markProcessed(name: string, contentHash: string, templateId: string): void {
    this.db
      .query(`
        INSERT OR REPLACE INTO processed_skills (name, content_hash, template_id, processed_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(name, contentHash, templateId, new Date().toISOString())
  }

  /**
   * Given a list of skills with their hashes, return those that are
   * new (not in cache) or changed (hash differs).
   */
  getNewOrChanged(skills: Array<{ name: string; contentHash: string }>): Array<{ name: string; contentHash: string }> {
    const cached = new Map(
      this.getProcessedSkills().map(s => [s.name, s.contentHash])
    )
    return skills.filter(s => {
      const existing = cached.get(s.name)
      return !existing || existing !== s.contentHash
    })
  }

  clear(): void {
    this.db.exec('DELETE FROM processed_skills')
  }

  close(): void {
    this.db.close()
  }
}
