---
name: visual-regression
version: 1.0.0
description: Screenshot comparison and visual regression detection across viewports
trigger: "visual regression|screenshot comparison|baseline|visual diff|pixel diff|compare screenshots|visual test|ui changed"
tools: [browser_navigate, browser_screenshot, shell_exec, memory_read, memory_write]
---

# Visual Regression Testing

Detect unintended visual changes by comparing screenshots against stored baselines.

## Workflow

### 1. Capture Baselines
First run establishes the "known good" state:

1. Navigate to each critical page at all 3 viewports
2. Wait for `networkidle` to ensure all assets loaded
3. Take full-page screenshots
4. Store baseline metadata in memory:
   ```json
   {
     "page": "/dashboard",
     "viewport": "desktop",
     "path": "/tmp/baseline-dashboard-desktop-1700000000.png",
     "commitHash": "abc123",
     "timestamp": "2024-01-15T10:30:00Z",
     "url": "http://localhost:3000/dashboard"
   }
   ```

### 2. Comparison Run
On subsequent runs:

1. Take new screenshots at the same pages and viewports
2. Compare against stored baselines pixel-by-pixel
3. Calculate the percentage of changed pixels
4. Flag pages that exceed the threshold

### 3. Diff Analysis

**Threshold configuration:**
- Default: flag differences > 0.1% pixel change
- Strict mode: flag > 0.01% (for pixel-perfect designs)
- Relaxed mode: flag > 1.0% (for content-heavy pages with dynamic data)

The user can adjust per-page if needed.

### 4. Report Results
Present findings with:
- Before (baseline) and After (current) screenshots side by side
- Percentage of pixels changed
- Classification: **intentional** (user confirms) vs **regression** (unexpected)
- If intentional: update baseline in memory
- If regression: flag for investigation

## Viewport Matrix

| Viewport | Width | Height | Use Case |
|----------|-------|--------|----------|
| Desktop  | 1920  | 1080   | Primary layout, full navigation |
| Tablet   | 768   | 1024   | Responsive breakpoint, touch layout |
| Mobile   | 375   | 667    | Mobile-first, hamburger menu, stacked layout |

## Baseline Management

- Store baselines with commit hash so you can correlate visual changes with code changes
- When user approves a visual change, update the baseline in memory
- Keep the last 3 baselines per page/viewport for rollback comparison
- Prune baselines older than 30 days unless user marks them as "pinned"

## Comparison Script Template
```javascript
const { chromium } = require('playwright');
const fs = require('fs');

const TARGET_URL = 'http://localhost:3000';
const PAGES = ['/', '/dashboard', '/settings', '/profile'];
const VIEWPORTS = [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 667 },
];

(async () => {
  const browser = await chromium.launch({ headless: false });
  const results = [];

  for (const pagePath of PAGES) {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height }
      });
      const page = await context.newPage();
      await page.goto(`${TARGET_URL}${pagePath}`);
      await page.waitForLoadState('networkidle');

      const screenshotPath = `/tmp/vr-${pagePath.replace(/\//g, '-')}-${vp.name}-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });

      results.push({
        page: pagePath,
        viewport: vp.name,
        screenshot: screenshotPath,
        timestamp: new Date().toISOString()
      });

      console.log(`✓ Captured ${pagePath} @ ${vp.name}`);
      await context.close();
    }
  }

  console.log(JSON.stringify(results, null, 2));
  await browser.close();
})();
```

## Edge Cases to Handle
- **Dynamic content** (timestamps, random avatars, ads) — mask known dynamic regions before comparison
- **Font loading** — wait for fonts to load before capture (`document.fonts.ready`)
- **Animations** — disable CSS animations before capture (`* { animation: none !important; }`)
- **Lazy-loaded images** — scroll to bottom and back before capture to trigger all lazy loads
- **Dark mode** — if the app supports it, capture both light and dark mode baselines
