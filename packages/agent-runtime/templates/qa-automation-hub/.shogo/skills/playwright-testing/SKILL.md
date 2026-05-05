---
name: playwright-testing
version: 1.0.0
description: Browser automation and E2E testing with Playwright — write, execute, and report test scripts
trigger: "test|e2e|playwright|browser test|automation|check page|verify|test this|run test|test the"
tools: [browser_navigate, browser_screenshot, shell_exec, memory_read, memory_write]
---

# Playwright Testing

General-purpose browser automation for testing and validation. Any browser automation task — write custom Playwright code for the specific request.

## Critical Workflow

**Always follow this order:**

1. **Detect dev servers FIRST** — Run `detectDevServers()` or check common ports (3000, 3001, 5173, 8080, 8000). Never hardcode a URL.
2. **Write scripts to `/tmp/`** — All generated test scripts go to `/tmp/playwright-test-{feature}-{timestamp}.js`. Never pollute the user's project.
3. **Visible browser by default** — Launch with `headless: false` so the user sees the browser in real time. Only go headless if user explicitly requests it.
4. **Parameterize URLs** — Every script starts with `const TARGET_URL = 'http://localhost:XXXX';` using the detected/provided URL.
5. **Wait strategies** — Use `waitForSelector`, `waitForURL`, `waitForLoadState('networkidle')`. Never use `waitForTimeout` unless debugging.
6. **Report with screenshots** — Capture screenshots at assertion points. Save to `/tmp/screenshot-{name}-{viewport}-{timestamp}.png`.

## Common Patterns

### Test a Page (Multiple Viewports)
```javascript
const { chromium } = require('playwright');

const TARGET_URL = 'http://localhost:3000';
const VIEWPORTS = [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 667 },
];

(async () => {
  const browser = await chromium.launch({ headless: false });
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();
    await page.goto(TARGET_URL);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `/tmp/screenshot-homepage-${vp.name}-${Date.now()}.png`, fullPage: true });
    console.log(`✓ ${vp.name} (${vp.width}x${vp.height}) — page loaded`);
    await context.close();
  }
  await browser.close();
})();
```

### Test Login Flow
```javascript
const page = await context.newPage();
await page.goto(`${TARGET_URL}/login`);
await page.waitForSelector('input[type="email"], input[name="email"], #email');
await safeType(page, 'input[type="email"]', 'test@example.com');
await safeType(page, 'input[type="password"]', 'testpassword');
await safeClick(page, 'button[type="submit"]');
await page.waitForURL('**/dashboard**', { timeout: 10000 });
await page.screenshot({ path: `/tmp/screenshot-login-success-${Date.now()}.png` });
```

### Fill and Submit Form
```javascript
await page.goto(`${TARGET_URL}/form`);
await page.waitForSelector('form');
await safeType(page, '#name', 'Test User');
await safeType(page, '#email', 'test@example.com');
await page.selectOption('#role', 'admin');
await safeClick(page, 'button[type="submit"]');
await page.waitForSelector('.success-message, .toast, [role="alert"]');
await page.screenshot({ path: `/tmp/screenshot-form-submitted-${Date.now()}.png` });
```

### Check Broken Links
```javascript
const links = await page.$$eval('a[href]', els => els.map(a => a.href));
const uniqueLinks = [...new Set(links)].filter(l => l.startsWith('http'));
for (const link of uniqueLinks) {
  try {
    const response = await page.request.get(link);
    if (response.status() >= 400) {
      console.log(`✗ BROKEN: ${link} → ${response.status()}`);
    } else {
      console.log(`✓ OK: ${link} → ${response.status()}`);
    }
  } catch (e) {
    console.log(`✗ ERROR: ${link} → ${e.message}`);
  }
}
```

### Take Screenshots with Error Handling
```javascript
async function takeScreenshot(page, name, viewport) {
  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForLoadState('networkidle');
    const path = `/tmp/screenshot-${name}-${viewport.name}-${Date.now()}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(`✓ Screenshot saved: ${path}`);
    return path;
  } catch (e) {
    console.log(`✗ Screenshot failed for ${name}@${viewport.name}: ${e.message}`);
    return null;
  }
}
```

## Helper Functions

These helpers are available in all generated scripts:

- **`detectDevServers()`** — Scans common ports (3000, 3001, 5173, 8080, 8000, 4200, 8888) and returns running server URLs
- **`safeClick(page, selector)`** — Waits for element, scrolls into view, then clicks. Handles overlays and cookie banners.
- **`safeType(page, selector, text)`** — Waits for input, clears existing value, then types. Handles focus issues.
- **`takeScreenshot(page, name, viewport)`** — Captures screenshot with error handling, returns file path.
- **`handleCookieBanner(page)`** — Detects and dismisses common cookie consent banners.
- **`extractTableData(page, selector)`** — Extracts table data as an array of objects using header row as keys.

## Execution Pattern

1. Detect servers → determine `TARGET_URL`
2. Write script to `/tmp/playwright-test-{feature}-{timestamp}.js`
3. Execute via shell: `node /tmp/playwright-test-{feature}-{timestamp}.js`
4. Parse stdout for pass/fail results
5. Collect screenshot paths from stdout
6. Report: structured results with inline screenshots

## Inline Execution

For quick tasks (single screenshot, element check, simple assertion), skip writing a file — execute directly via `browser_navigate` and `browser_screenshot` tools:

1. Navigate to the URL
2. Take screenshot
3. Report what you see

Only write a full script when the task involves multiple steps, loops, or data extraction.
