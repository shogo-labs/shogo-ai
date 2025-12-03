/**
 * Low-level file I/O helpers for persistence layer
 */

import * as fs from 'fs/promises'

/**
 * Ensures a directory exists, creating it if necessary
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true })
}

/**
 * Reads and parses a JSON file
 */
export async function readJson(filePath: string): Promise<any> {
  const content = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(content)
}

/**
 * Writes data to a JSON file with pretty formatting
 */
export async function writeJson(filePath: string, data: any): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * Checks if a file or directory exists
 */
export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Lists all directories in a given path
 */
export async function listDirs(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
}

/**
 * Lists all files in a given path
 */
export async function listFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  return entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
}
