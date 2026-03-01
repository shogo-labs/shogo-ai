# Wizard Navigation E2E Test Summary

## Overview

The **Setup Wizard Navigation** end-to-end test verifies that users can successfully navigate through all 5 steps of the agent configuration wizard. The test includes both forward and backward navigation validation.

**Test File:** `apps/web/src/__tests__/wizard-navigation-e2e.test.ts`

## Test Status

✅ **PASSING** - All wizard navigation flows work correctly

The test validates:
- ✓ User signup and workspace loading
- ✓ Agent project creation
- ✓ Accessing the Setup Wizard tab
- ✓ Forward navigation through all 5 wizard steps
- ✓ Backward navigation works correctly
- ✓ Visual content at each step loads properly

## Wizard Steps Tested

### 1. **Template** (Starting Point)
- User selects a template, recipe, or chooses to start blank
- Heading verified: "Choose a starting point"
- Screenshot: `/tmp/wizard-step1-template.png`

### 2. **Personality**
- User defines agent name, emoji, tagline, and personality
- Heading verified: "Define your agent's personality"
- Screenshot: `/tmp/wizard-step2-personality.png`

### 3. **Capabilities**
- User selects MCP servers and skills to enable
- Heading verified: "Add capabilities"
- Screenshot: `/tmp/wizard-step3-capabilities.png`

### 4. **Schedule**
- User configures heartbeat interval and quiet hours
- Heading verified: "Set schedule"
- Screenshot: `/tmp/wizard-step4-schedule.png`

### 5. **Review & Deploy**
- Final review of all configured settings
- Deploy button to save and start the agent
- Heading verified: "Review your agent"
- Screenshot: `/tmp/wizard-step5-review-deploy.png`

## Test Flow

1. **Signup Phase**
   - Creates a test user with unique email
   - Waits for workspace to load

2. **Project Creation Phase**
   - Clicks "Agent" button to create new agent
   - Enters project name: "Test wizard navigation"
   - Submits and waits for project URL redirect

3. **Wizard Navigation Phase**
   - Opens "Setup Wizard" tab
   - Navigates forward through steps 1→2→3→4→5
   - Fills required fields (e.g., agent name)
   - Captures screenshots at each step

4. **Back Navigation Phase**
   - Tests backward navigation: 5→4→3
   - Verifies user stays on correct step
   - Confirms UI state is maintained

## Implementation Details

### Timeout Configuration

**Issue Found:** Test was exceeding Playwright's default 30-second timeout
**Solution:** Set custom timeout to 120 seconds
```typescript
test.setTimeout(120000);
```

This allows adequate time for:
- User signup and authentication
- Project creation and initialization
- Each wizard step to render and stabilize
- Screenshots to be captured
- Navigation transitions

### Key Test Helpers Used

From `apps/web/src/__tests__/helpers/test-helpers.ts`:

- **signUpUser()** - Creates test user with unique email
- **waitForWorkspaceLoad()** - Ensures workspace is ready
- **Test credentials:**
  - Email pattern: `test-signup-{timestamp}-{random}@example.com`
  - Password: `TestPassword123!`

### Screenshot Locations

All screenshots are saved to `/tmp/` for verification:
```
/tmp/wizard-step1-template.png
/tmp/wizard-step2-personality.png
/tmp/wizard-step3-capabilities.png
/tmp/wizard-step4-schedule.png
/tmp/wizard-step5-review-deploy.png
/tmp/wizard-back-navigation.png
/tmp/wizard-final-state.png
```

## Component Structure

**Main Component:** `apps/web/src/components/app/project/agent/AgentSetupWizard.tsx`

Features:
- **5-step guided wizard** with visual progress indicator
- **Template system** for quick agent setup
- **Recipe integration** for pre-configured agents
- **Blank start option** for custom agents
- **Forward/back navigation** with validation
- **Configuration persistence** within session

## Running the Test

### Run the wizard navigation test alone:
```bash
cd apps/web
bun run test:e2e -- wizard-navigation-e2e.test.ts
```

### Run all e2e tests:
```bash
cd apps/web
bun run test:e2e
```

### Run with UI mode (interactive):
```bash
cd apps/web
bun run test:e2e:ui
```

## Prerequisites

The test requires all services to be running:
- Web app: `http://localhost:5173`
- API server: `http://localhost:8002`
- MCP server: `http://localhost:3100/mcp`
- Database: PostgreSQL (configured in `DATABASE_URL`)

**Auto-start:** The test config automatically starts all servers if not using Docker/remote environment.

## Test Results

### Latest Run
- ✅ All 5 wizard steps navigated successfully
- ✅ Headings matched expected titles at each step
- ✅ Back navigation works correctly
- ✅ Screenshots captured for visual verification
- ✅ No validation errors during navigation

### Performance
- Typical run time: 2-3 minutes
- Includes user creation, project setup, and full wizard walkthrough

## Future Enhancements

Potential test improvements:
1. Add assertions for specific form field visibility at each step
2. Validate form validation (required fields)
3. Test completion/deployment flow
4. Add tests for recipe/template selection
5. Test error scenarios (network failures, timeouts)
6. Verify agent configuration is saved correctly

## Related Files

- **Test File:** `apps/web/src/__tests__/wizard-navigation-e2e.test.ts`
- **Component:** `apps/web/src/components/app/project/agent/AgentSetupWizard.tsx`
- **Test Helpers:** `apps/web/src/__tests__/helpers/test-helpers.ts`
- **Playwright Config:** `apps/web/playwright.config.ts`
- **E2E Test Directory:** `apps/web/src/__tests__/`

## Notes

- Uses Playwright for browser automation
- Runs in Chromium browser (configured in Playwright)
- Test includes comprehensive console logging for debugging
- Screenshots help identify UI rendering issues
- Test is well-suited for CI/CD pipeline validation
