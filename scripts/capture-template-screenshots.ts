#!/usr/bin/env bun
/**
 * capture-template-screenshots.ts
 * 
 * Captures screenshots of all SDK example templates for use in the template gallery.
 * 
 * Usage:
 *   bun run scripts/capture-template-screenshots.ts
 * 
 * Prerequisites:
 *   - PostgreSQL running (Docker: shogo-ai-postgres-1)
 *   - Playwright installed: bunx playwright install chromium
 * 
 * The script will:
 *   1. Create a database for each template
 *   2. Install dependencies and push schema
 *   3. Start the dev server
 *   4. Navigate, create a demo user, and capture screenshots
 *   5. Save to apps/web/public/templates/
 */

import { chromium, type Browser, type Page } from "playwright"
import { spawn, type Subprocess } from "bun"
import { existsSync, mkdirSync, readdirSync } from "fs"
import { join, resolve } from "path"

// Configuration
const TEMPLATES_DIR = resolve(import.meta.dir, "../packages/sdk/examples")
const OUTPUT_DIR = resolve(import.meta.dir, "../apps/web/public/templates")
const BASE_PORT = 4100
const DATABASE_HOST = process.env.DATABASE_HOST || "localhost"
const DATABASE_USER = process.env.DATABASE_USER || "shogo"
const DATABASE_PASSWORD = process.env.DATABASE_PASSWORD || "shogo_dev"

interface TemplateConfig {
  name: string
  path: string
  port: number
  databaseUrl: string
  setupSteps?: (page: Page) => Promise<void>
}

/**
 * Default setup: fill email/name form and click Get Started
 */
async function defaultSetup(page: Page): Promise<void> {
  // Wait for form to load
  await page.waitForSelector('input[type="email"], input[placeholder*="email" i], input[placeholder*="Email" i]', { timeout: 10000 })
  
  // Fill email field
  const emailInput = await page.$('input[type="email"], input[placeholder*="email" i], input[placeholder*="Email" i]')
  if (emailInput) {
    await emailInput.fill("demo@example.com")
  }
  
  // Fill name field if exists
  const nameInput = await page.$('input[placeholder*="name" i]:not([type="email"])')
  if (nameInput) {
    await nameInput.fill("Demo User")
  }
  
  // Click submit button
  const submitButton = await page.$('button[type="submit"], button:has-text("Get Started"), button:has-text("Continue"), button:has-text("Create")')
  if (submitButton) {
    await submitButton.click()
    await page.waitForTimeout(2000) // Wait for navigation/state update
  }
}

/**
 * Setup for Kanban: create a board and add some cards
 */
async function kanbanSetup(page: Page): Promise<void> {
  await defaultSetup(page)
  
  // Create a board
  const createBoardButton = await page.$('text="+ Create new board"')
  if (createBoardButton) {
    await createBoardButton.click()
    await page.waitForTimeout(500)
    
    const boardNameInput = await page.$('input[placeholder*="Board name" i]')
    if (boardNameInput) {
      await boardNameInput.fill("Project Tasks")
      const createButton = await page.$('button:has-text("Create")')
      if (createButton) {
        await createButton.click()
        await page.waitForTimeout(1000)
      }
    }
    
    // Add cards to columns
    const addCardButtons = await page.$$('button:has-text("+ Add a card")')
    const cardTitles = ["Design homepage mockup", "Build user authentication", "Setup project structure"]
    
    for (let i = 0; i < Math.min(addCardButtons.length, cardTitles.length); i++) {
      await addCardButtons[i].click()
      await page.waitForTimeout(300)
      
      const titleInput = await page.$('input[placeholder*="title" i], textarea[placeholder*="title" i]')
      if (titleInput) {
        await titleInput.fill(cardTitles[i])
        const addButton = await page.$('button:has-text("Add Card")')
        if (addButton) {
          await addButton.click()
          await page.waitForTimeout(500)
        }
      }
    }
  }
}

/**
 * Setup for Todo: add some todos
 */
async function todoSetup(page: Page): Promise<void> {
  await defaultSetup(page)
  
  const todos = ["Build an awesome app", "Learn the Shogo SDK", "Deploy to production"]
  
  for (const todo of todos) {
    const todoInput = await page.$('input[placeholder*="done" i], input[placeholder*="todo" i]')
    if (todoInput) {
      await todoInput.fill(todo)
      await page.keyboard.press("Enter")
      await page.waitForTimeout(300)
    }
  }
  
  // Check one item
  const checkbox = await page.$('input[type="checkbox"]')
  if (checkbox) {
    await checkbox.click()
    await page.waitForTimeout(300)
  }
}

/**
 * Get list of templates from the examples directory
 */
function getTemplates(): TemplateConfig[] {
  const templates: TemplateConfig[] = []
  const dirs = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => existsSync(join(TEMPLATES_DIR, d.name, "template.json")))
  
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]
    const port = BASE_PORT + i
    const dbName = `template_screenshot_${dir.name.replace(/-/g, "_")}`
    
    const config: TemplateConfig = {
      name: dir.name,
      path: join(TEMPLATES_DIR, dir.name),
      port,
      databaseUrl: `postgres://${DATABASE_USER}:${DATABASE_PASSWORD}@${DATABASE_HOST}:5432/${dbName}`,
    }
    
    // Add custom setup steps for specific templates
    if (dir.name === "kanban") {
      config.setupSteps = kanbanSetup
    } else if (dir.name === "todo-app") {
      config.setupSteps = todoSetup
    }
    
    templates.push(config)
  }
  
  return templates
}

/**
 * Create database if it doesn't exist
 */
async function createDatabase(dbName: string): Promise<void> {
  const proc = spawn([
    "docker", "exec", "shogo-ai-postgres-1",
    "psql", "-U", DATABASE_USER, "-d", "shogo",
    "-c", `CREATE DATABASE ${dbName}`
  ], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await proc.exited
}

/**
 * Setup template: install deps and push schema
 */
async function setupTemplate(config: TemplateConfig): Promise<void> {
  console.log(`  Setting up ${config.name}...`)
  
  // Create database
  const dbName = config.databaseUrl.split("/").pop()!
  await createDatabase(dbName)
  
  // Install dependencies
  const installProc = spawn(["bun", "install"], {
    cwd: config.path,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DATABASE_URL: config.databaseUrl },
  })
  await installProc.exited
  
  // Push schema
  const pushProc = spawn(["bunx", "prisma", "db", "push", "--accept-data-loss"], {
    cwd: config.path,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DATABASE_URL: config.databaseUrl },
  })
  await pushProc.exited
}

/**
 * Start the dev server for a template
 */
function startServer(config: TemplateConfig): Subprocess {
  console.log(`  Starting server on port ${config.port}...`)
  
  return spawn(["bun", "run", "dev", "--port", String(config.port)], {
    cwd: config.path,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DATABASE_URL: config.databaseUrl },
  })
}

/**
 * Wait for server to be ready
 */
async function waitForServer(port: number, timeout = 30000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`http://localhost:${port}`)
      if (response.ok) {
        return true
      }
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

/**
 * Capture screenshot of a template
 */
async function captureScreenshot(
  browser: Browser,
  config: TemplateConfig
): Promise<void> {
  console.log(`  Capturing screenshot...`)
  
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  })
  
  try {
    await page.goto(`http://localhost:${config.port}`, { waitUntil: "networkidle" })
    await page.waitForTimeout(1000)
    
    // Run setup steps (sign up, add data, etc.)
    const setupFn = config.setupSteps || defaultSetup
    await setupFn(page)
    
    // Wait for any animations/transitions
    await page.waitForTimeout(1000)
    
    // Take screenshot
    const outputPath = join(OUTPUT_DIR, `${config.name}.png`)
    await page.screenshot({ path: outputPath })
    console.log(`  Saved: ${outputPath}`)
  } finally {
    await page.close()
  }
}

/**
 * Main function
 */
async function main() {
  console.log("🖼️  Template Screenshot Capture\n")
  
  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true })
  }
  
  // Get templates
  const templates = getTemplates()
  console.log(`Found ${templates.length} templates:\n`)
  templates.forEach(t => console.log(`  - ${t.name}`))
  console.log()
  
  // Launch browser
  console.log("Launching browser...")
  const browser = await chromium.launch({ headless: true })
  
  const servers: Subprocess[] = []
  
  try {
    for (const template of templates) {
      console.log(`\n📦 Processing: ${template.name}`)
      
      // Setup template
      await setupTemplate(template)
      
      // Start server
      const server = startServer(template)
      servers.push(server)
      
      // Wait for server
      const ready = await waitForServer(template.port)
      if (!ready) {
        console.log(`  ⚠️  Server failed to start, skipping...`)
        server.kill()
        continue
      }
      
      // Capture screenshot
      await captureScreenshot(browser, template)
      
      // Stop server
      server.kill()
      
      console.log(`  ✅ Done`)
    }
  } finally {
    // Cleanup
    console.log("\nCleaning up...")
    for (const server of servers) {
      try {
        server.kill()
      } catch {
        // Ignore
      }
    }
    await browser.close()
  }
  
  console.log("\n✨ All screenshots captured!")
  console.log(`Output directory: ${OUTPUT_DIR}`)
}

// Run
main().catch(console.error)
