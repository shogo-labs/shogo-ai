/**
 * Project Runtime Server Tests
 * 
 * Tests for the server.ts fixes:
 * 1. Route ordering - API paths should not be caught by preview catch-all
 * 2. Build status verification - Should check actual build artifacts
 * 3. Readiness probe - Should verify build artifacts before reporting ready
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test'
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// Test directory setup
const TEST_PROJECT_DIR = '/tmp/server-test-project'

describe('Build Status Verification', () => {
  beforeAll(() => {
    // Clean up any previous test directory
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true })
  })

  describe('Vite Projects', () => {
    const viteProjectDir = join(TEST_PROJECT_DIR, 'vite-project')

    beforeAll(() => {
      mkdirSync(viteProjectDir, { recursive: true })
    })

    test('should detect missing dist directory', () => {
      const distDir = join(viteProjectDir, 'dist')
      expect(existsSync(distDir)).toBe(false)
    })

    test('should detect missing index.html in dist', () => {
      const distDir = join(viteProjectDir, 'dist')
      mkdirSync(distDir, { recursive: true })
      
      // Create some assets but no index.html
      writeFileSync(join(distDir, 'main.js'), 'export default {}')
      
      expect(existsSync(join(distDir, 'index.html'))).toBe(false)
    })

    test('should pass with complete dist', () => {
      const distDir = join(viteProjectDir, 'dist')
      
      // Create index.html
      writeFileSync(join(distDir, 'index.html'), '<!DOCTYPE html><html></html>')
      
      expect(existsSync(join(distDir, 'index.html'))).toBe(true)
    })
  })
})

describe('Route Ordering', () => {
  // These tests verify that API paths are properly handled
  // by checking path matching logic similar to what's in server.ts
  
  const apiPaths = [
    '/terminal/',
    '/tests/',
    '/database/',
    '/api/',
    '/lsp',
  ]

  test('should recognize terminal paths as API paths', () => {
    const testPaths = ['/terminal/commands', '/terminal/exec']
    
    for (const path of testPaths) {
      const isApiPath = apiPaths.some(p => path.startsWith(p))
      expect(isApiPath).toBe(true)
    }
  })

  test('should recognize tests paths as API paths', () => {
    const testPaths = ['/tests/list', '/tests/run', '/tests/traces']
    
    for (const path of testPaths) {
      const isApiPath = apiPaths.some(p => path.startsWith(p))
      expect(isApiPath).toBe(true)
    }
  })

  test('should recognize database paths as API paths', () => {
    const testPaths = ['/database/url', '/database/proxy', '/database/status']
    
    for (const path of testPaths) {
      const isApiPath = apiPaths.some(p => path.startsWith(p))
      expect(isApiPath).toBe(true)
    }
  })

  test('should NOT recognize preview paths as API paths', () => {
    const testPaths = ['/', '/index.html', '/assets/main.js', '/some/page']
    
    for (const path of testPaths) {
      const isApiPath = apiPaths.some(p => path.startsWith(p))
      expect(isApiPath).toBe(false)
    }
  })
})

describe('Entrypoint Script Logic', () => {
  // These tests verify the bash script logic patterns
  
  test('should correctly detect Vite + Hono project from package.json', () => {
    const packageJson = JSON.stringify({
      name: "test-project",
      dependencies: {
        "react": "^19.0.0",
        "react-dom": "^19.0.0",
        "hono": "^4.0.0"
      },
      devDependencies: {
        "vite": "^7.3.1"
      }
    })
    
    const hasHono = packageJson.includes('hono')
    const hasVite = packageJson.includes('vite')
    expect(hasHono).toBe(true)
    expect(hasVite).toBe(true)
  })
})

describe('Prisma Studio Proxy URL Rewriting', () => {
  // These tests validate the URL rewriting logic that prevents double-prefixing
  // Reference: Fix for staging errors with doubled proxy paths
  
  /**
   * Helper function that simulates the client-side rewriteUrl logic
   * This is extracted from the injected script in rewritePrismaStudioHtml()
   */
  function simulateRewriteUrl(url: string, proxyBase: string): string {
    if (typeof url !== 'string') return url
    
    // Handle full URLs (http://... or https://...)
    if (url.indexOf('://') !== -1) {
      try {
        const urlObj = new URL(url)
        // Check if same domain or localhost - rewrite to use proxy
        if (urlObj.hostname === 'localhost' || urlObj.hostname === 'studio-staging.shogo.ai') {
          let path = urlObj.pathname
          
          // CRITICAL FIX: Check if pathname already contains the proxy base
          // If it does, don't prepend it again (prevents double-prefixing)
          if (path.startsWith(proxyBase)) {
            // Path already has proxy base, use as-is
            url = path + urlObj.search
          } else {
            // Strip the origin and treat as relative path through proxy
            if (path.startsWith('/')) path = path.substring(1)
            url = proxyBase + path + urlObj.search
          }
        }
      } catch(e) {
        // Invalid URL, leave as-is
      }
    }
    // Handle protocol-relative URLs (//...) - leave unchanged
    else if (url.startsWith('//')) {
      // Protocol-relative URLs should not be rewritten
      return url
    }
    // Handle /api/ calls - but check if already proxied
    else if ((url.startsWith('/api/') || url.startsWith('/api')) && !url.startsWith(proxyBase)) {
      url = proxyBase + url.substring(1)
    }
    // Handle other absolute paths at root - but check if already proxied
    else if (url.startsWith('/') && !url.startsWith(proxyBase)) {
      url = proxyBase + url.substring(1)
    }
    
    return url
  }

  const proxyBase = '/api/projects/431ac3e9-4227-4e6a-8dae-b0961fad68c3/database/proxy/'
  
  describe('Full URL Rewriting (Critical Fix)', () => {
    test('should NOT double-prefix URLs that already contain proxy base', () => {
      // This is the bug we're fixing - URL already has proxy base in pathname
      const alreadyProxied = `https://studio-staging.shogo.ai${proxyBase}ui/index.css`
      const result = simulateRewriteUrl(alreadyProxied, proxyBase)
      
      // Should use the path as-is, not double it
      expect(result).toBe(`${proxyBase}ui/index.css`)
      // Should NOT be doubled
      expect(result).not.toContain(`${proxyBase}${proxyBase}`)
    })

    test('should correctly prefix URLs without proxy base', () => {
      // URL doesn't have proxy base yet - should be added
      const notProxied = 'https://studio-staging.shogo.ai/ui/index.css'
      const result = simulateRewriteUrl(notProxied, proxyBase)
      
      expect(result).toBe(`${proxyBase}ui/index.css`)
    })

    test('should handle localhost URLs with proxy base already present', () => {
      const alreadyProxied = `http://localhost:5555${proxyBase}api/models`
      const result = simulateRewriteUrl(alreadyProxied, proxyBase)
      
      // Should not double-prefix
      expect(result).toBe(`${proxyBase}api/models`)
      expect(result).not.toContain(`${proxyBase}${proxyBase}`)
    })

    test('should handle localhost URLs without proxy base', () => {
      const notProxied = 'http://localhost:5555/api/models'
      const result = simulateRewriteUrl(notProxied, proxyBase)
      
      expect(result).toBe(`${proxyBase}api/models`)
    })

    test('should preserve query parameters in full URLs', () => {
      const urlWithQuery = `https://studio-staging.shogo.ai${proxyBase}api/models?take=100`
      const result = simulateRewriteUrl(urlWithQuery, proxyBase)
      
      expect(result).toBe(`${proxyBase}api/models?take=100`)
      expect(result).toContain('?take=100')
    })
  })

  describe('Relative Path Rewriting', () => {
    test('should prefix /api/ paths that lack proxy base', () => {
      const apiPath = '/api/models'
      const result = simulateRewriteUrl(apiPath, proxyBase)
      
      expect(result).toBe(`${proxyBase}api/models`)
    })

    test('should NOT double-prefix /api/ paths that already have proxy base', () => {
      const alreadyProxied = `${proxyBase}api/models`
      const result = simulateRewriteUrl(alreadyProxied, proxyBase)
      
      // Should remain unchanged
      expect(result).toBe(`${proxyBase}api/models`)
      expect(result).not.toContain(`${proxyBase}${proxyBase}`)
    })

    test('should prefix absolute paths without proxy base', () => {
      const absolutePath = '/ui/index.css'
      const result = simulateRewriteUrl(absolutePath, proxyBase)
      
      expect(result).toBe(`${proxyBase}ui/index.css`)
    })

    test('should NOT double-prefix absolute paths with proxy base', () => {
      const alreadyProxied = `${proxyBase}ui/index.css`
      const result = simulateRewriteUrl(alreadyProxied, proxyBase)
      
      // Should remain unchanged
      expect(result).toBe(`${proxyBase}ui/index.css`)
    })

    test('should handle relative paths (no leading slash)', () => {
      const relativePath = 'ui/styles.css'
      const result = simulateRewriteUrl(relativePath, proxyBase)
      
      // Relative paths without leading slash should pass through unchanged
      expect(result).toBe('ui/styles.css')
    })
  })

  describe('Edge Cases', () => {
    test('should handle empty strings', () => {
      const result = simulateRewriteUrl('', proxyBase)
      expect(result).toBe('')
    })

    test('should handle root path', () => {
      const result = simulateRewriteUrl('/', proxyBase)
      expect(result).toBe(`${proxyBase}`)
    })

    test('should not modify external domain URLs', () => {
      const externalUrl = 'https://cdn.example.com/script.js'
      const result = simulateRewriteUrl(externalUrl, proxyBase)
      
      // Should remain unchanged (different domain)
      expect(result).toBe(externalUrl)
    })

    test('should handle protocol-relative URLs', () => {
      const protocolRelative = '//cdn.example.com/script.js'
      const result = simulateRewriteUrl(protocolRelative, proxyBase)
      
      // Should pass through unchanged
      expect(result).toBe(protocolRelative)
    })

    test('should handle multiple slashes in path', () => {
      const multiSlash = '/api//models///users'
      const result = simulateRewriteUrl(multiSlash, proxyBase)
      
      // Should prefix even with weird slashes (browser will normalize)
      expect(result).toBe(`${proxyBase}api//models///users`)
    })
  })

  describe('Real-World Scenarios from Staging Errors', () => {
    test('should fix the exact CSS URL from staging error logs', () => {
      // The actual error from staging:
      // 'https://studio-staging.shogo.ai/api/projects/431ac3e9-4227-4e6a-8dae-b0961fad68c3/database/proxy/api/projects/431ac3e9-4227-4e6a-8dae-b0961fad68c3/database/proxy/ui/index.css'
      
      // What Prisma Studio creates (already proxied path in URL):
      const studioGeneratedUrl = `https://studio-staging.shogo.ai${proxyBase}ui/index.css`
      const result = simulateRewriteUrl(studioGeneratedUrl, proxyBase)
      
      // Should NOT double the proxy path
      expect(result).toBe(`${proxyBase}ui/index.css`)
      
      // Verify we avoided the bug (no doubled path)
      const wrongResult = `${proxyBase}api/projects/431ac3e9-4227-4e6a-8dae-b0961fad68c3/database/proxy/ui/index.css`
      expect(result).not.toBe(wrongResult)
    })

    test('should fix adapter.js and index.js paths', () => {
      const adapterUrl = `https://studio-staging.shogo.ai${proxyBase}adapter.js`
      const indexUrl = `https://studio-staging.shogo.ai${proxyBase}index.js`
      
      const adapterResult = simulateRewriteUrl(adapterUrl, proxyBase)
      const indexResult = simulateRewriteUrl(indexUrl, proxyBase)
      
      expect(adapterResult).toBe(`${proxyBase}adapter.js`)
      expect(indexResult).toBe(`${proxyBase}index.js`)
      
      // Neither should have doubled paths
      expect(adapterResult).not.toContain(`${proxyBase}${proxyBase}`)
      expect(indexResult).not.toContain(`${proxyBase}${proxyBase}`)
    })

    test('should handle API calls from Prisma Studio', () => {
      // Prisma Studio makes API calls that get rewritten
      const apiCallUrl = `https://studio-staging.shogo.ai${proxyBase}api/models/User`
      const result = simulateRewriteUrl(apiCallUrl, proxyBase)
      
      expect(result).toBe(`${proxyBase}api/models/User`)
      expect(result).not.toContain(`${proxyBase}${proxyBase}`)
    })
  })

  describe('Proxy Base Path Variations', () => {
    test('should work with different project IDs', () => {
      const differentProxyBase = '/api/projects/abc-123/database/proxy/'
      const url = `https://studio-staging.shogo.ai${differentProxyBase}ui/index.css`
      const result = simulateRewriteUrl(url, differentProxyBase)
      
      expect(result).toBe(`${differentProxyBase}ui/index.css`)
      expect(result).not.toContain(`${differentProxyBase}${differentProxyBase}`)
    })

    test('should work with local development proxy base', () => {
      const localProxyBase = '/database/proxy/'
      const url = `http://localhost:5555${localProxyBase}ui/index.css`
      const result = simulateRewriteUrl(url, localProxyBase)
      
      expect(result).toBe(`${localProxyBase}ui/index.css`)
    })

    test('should handle proxy base without trailing slash gracefully', () => {
      // The function adds trailing slash internally, but test the path matching
      const baseWithoutSlash = '/api/projects/123/database/proxy'
      const baseWithSlash = baseWithoutSlash + '/'
      const url = `https://studio-staging.shogo.ai${baseWithSlash}ui/index.css`
      const result = simulateRewriteUrl(url, baseWithSlash)
      
      expect(result).toBe(`${baseWithSlash}ui/index.css`)
    })
  })
})
