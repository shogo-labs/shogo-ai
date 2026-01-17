# E2E Test Suite

This document lists all E2E tests created for the Shogo AI application.

## Test Organization

Tests are organized by feature area in subdirectories under `src/__tests__/`.

## Test Files Created

### Authentication Tests (`auth/`)
- ✅ `signin.test.ts` - Sign in flow and invalid credentials
- ✅ `signout.test.ts` - Sign out flow and protected route access
- ✅ `signup-e2e.test.ts` - Sign up flow (already existed)

### Project Tests (`project/`)
- ✅ `create-from-prompt.test.ts` - Create project from home page chat input
- ✅ `rename-project.test.ts` - Rename project functionality

### Workspace Tests (`workspace/`)
- ✅ `switch-workspace.test.ts` - Switch workspace and create new workspace

### Navigation Tests (`navigation/`)
- ✅ `all-projects.test.ts` - All projects page, search, filters, grid/list view
- ✅ `starred-projects.test.ts` - Starred projects page and functionality
- ✅ `shared-with-me.test.ts` - Shared projects page

### Chat Tests (`chat/`)
- ✅ `send-message.test.ts` - Send chat messages and use suggestion buttons

### Search Tests (`search/`)
- ✅ `command-palette-open.test.ts` - Command palette (⌘K) functionality

### Sharing Tests (`sharing/`)
- ✅ `share-dropdown.test.ts` - Share dropdown and project access settings

### Publish Tests (`publish/`)
- ✅ `publish-dropdown.test.ts` - Publish dropdown and configuration

### Billing Tests (`billing/`)
- ✅ `view-plans.test.ts` - Billing page, plans, pricing toggle, credit tiers

### Settings Tests (`settings/`)
- ✅ `workspace-settings.test.ts` - Workspace settings and rename
- ✅ `invite-member.test.ts` - Invite members functionality

### Editor Tests (`editor/`)
- ✅ `preview-modes.test.ts` - Preview mode toggles (Mobile/Tablet/Desktop/Wide)

## Helper Utilities

- ✅ `helpers/test-helpers.ts` - Common test utilities (sign up, sign in, wait helpers)

## Running Tests

```bash
# Run all E2E tests
bun run test:e2e

# Run tests with UI
bun run test:e2e:ui

# Run tests in headed mode
bun run test:e2e:headed

# Run specific test file
npx playwright test auth/signin.test.ts

# Run tests in a directory
npx playwright test auth/
```

## Test Statistics

- **Total Test Files**: 16
- **Test Categories**: 10
- **Helper Files**: 1

## Test Coverage Areas

✅ Authentication (signup, signin, signout)
✅ Project creation and management
✅ Workspace switching
✅ Navigation (all projects, starred, shared)
✅ Chat functionality
✅ Search/command palette
✅ Sharing and collaboration
✅ Publishing
✅ Billing and plans
✅ Settings (workspace, members)
✅ Editor preview modes

## Future Tests to Add

### Medium Priority
- [ ] Folder creation and management
- [ ] Project deletion
- [ ] Project move to folder
- [ ] GitHub connection
- [ ] Labs features toggle
- [ ] Appearance/theme settings
- [ ] Profile page tests

### Lower Priority
- [ ] Phase-specific tests (Discovery, Analysis, Design, Spec, Implementation, Testing, Complete)
- [ ] Error handling tests
- [ ] Network failure handling
- [ ] Session persistence tests
- [ ] Google OAuth tests
