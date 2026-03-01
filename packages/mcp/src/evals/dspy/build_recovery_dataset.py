"""
Build Failure Recovery Dataset for DSPy Optimization

Tests the agent's ability to:
1. Detect build failures
2. Read and analyze build logs
3. Identify missing files/directories
4. Fix structural issues
5. Self-recover without user intervention
"""

import dspy
from typing import List, Tuple


# ============================================================
# Build Failure Scenarios (from E2E test)
# ============================================================

# Format: (scenario_name, build_error, build_log_excerpt, expected_fix, reasoning)
BUILD_FAILURE_SCENARIOS = [
    # Scenario 1: Missing routes directory (from E2E test)
    (
        "missing_routes_directory",
        "ENOENT: no such file or directory, scandir '/app/project/src/routes'",
        """[07:29:55] [error] error: ENOENT: no such file or directory, scandir '/app/project/src/routes'
at <anonymous> (/app/project/node_modules/@tanstack/router-generator/dist/esm/generator.js:153:23)
[07:29:55] rolldown-vite v7.3.1 building client environment for production...
[07:29:55] watching for file changes...""",
        ["read_build_log", "check_directory_exists", "create_routes_directory", "create_index_route"],
        "Agent must recognize routes directory is missing, read logs to confirm, then create the directory and at least one route file"
    ),
    
    # Scenario 2: Nitro plugin null error (from E2E test)
    (
        "nitro_plugin_null_error",
        "[nitro] ERROR TypeError: Object.entries requires that input parameter not be null or undefined",
        """[vite] [nitro] ✔ Generated public .output/public
[vite] [nitro] ℹ Building Nitro Server (preset: bun, compatibility date: ``)
[nitro]  ERROR  TypeError: Object.entries requires that input parameter not be null or undefined

error during build:
Error
    at entries (unknown)
    at getModules (/app/project/node_modules/@tanstack/nitro-v2-vite-plugin/dist/esm/index.js:131:46)
    at resolveId (/app/project/node_modules/@tanstack/nitro-v2-vite-plugin/dist/esm/index.js:150:23)
[vite:error] error: "vite" exited with code 1""",
        ["read_build_log", "check_project_structure", "identify_missing_files", "create_missing_structure"],
        "Agent must recognize this is a structural incompleteness issue, check what files exist, and create missing project scaffolding"
    ),
    
    # Scenario 3: Missing router.tsx
    (
        "missing_router_file",
        "Cannot find module './router'",
        """[vite] transforming...
[vite] ✓ 30 modules transformed.
error: Cannot find module './router' from 'src/client.tsx'
    at <anonymous> (src/client.tsx:3:0)
[vite:error] Build failed with errors.""",
        ["read_build_log", "create_router_file", "check_imports"],
        "Agent must create the missing router.tsx file with proper TanStack Router setup"
    ),
    
    # Scenario 4: TypeScript compilation errors
    (
        "typescript_compilation_error",
        "TS2304: Cannot find name 'Recipe'",
        """src/routes/index.tsx:12:15 - error TS2304: Cannot find name 'Recipe'.

12   const recipe: Recipe = {
                 ~~~~~~

src/components/RecipeForm.tsx:8:23 - error TS2339: Property 'ingredients' does not exist on type '{}'.

8   <input value={recipe.ingredients} />
                        ~~~~~~~~~~~

Found 2 errors in 2 files.""",
        ["read_build_log", "run_tsc", "import_missing_types", "fix_type_errors"],
        "Agent must run tsc to see all errors, import the Recipe type from generated files, and fix type issues"
    ),
    
    # Scenario 5: Missing Prisma client
    (
        "missing_prisma_client",
        "Cannot find module '@prisma/client'",
        """error: Cannot find module '@prisma/client'
Require stack:
- /app/project/src/generated/server-functions.ts
    at Module._resolveFilename (node:internal/modules/cjs/loader:1144:15)
[vite:error] Build failed""",
        ["read_build_log", "run_prisma_generate"],
        "Agent must recognize Prisma client needs to be generated and run `bun run db:generate` or `bun run generate`"
    ),
    
    # Scenario 6: Schema validation errors
    (
        "prisma_schema_validation_error",
        "Prisma schema validation error",
        """Error: Schema validation error
  --> schema.prisma:15
   |
15 |   difficulty Difficulty @default(MEDIUM)
   |
Error: Type "Difficulty" is neither a built-in type, nor refers to another model, custom type, or enum.

Validation failed. 1 error found.""",
        ["read_build_log", "check_schema_file", "add_missing_enum"],
        "Agent must read schema.prisma, identify the missing Difficulty enum, and add it above the model definition"
    ),
    
    # Scenario 7: Missing dependencies
    (
        "missing_npm_dependency",
        "Cannot find module '@tanstack/react-router'",
        """error: Cannot find module '@tanstack/react-router'
This dependency is missing! Try running:
  bun add @tanstack/react-router
[vite:error] Build failed""",
        ["read_build_log", "install_dependency"],
        "Agent must recognize missing dependency and run `bun add @tanstack/react-router`"
    ),
    
    # Scenario 8: Syntax errors in generated code
    (
        "javascript_syntax_error",
        "SyntaxError: Unexpected token",
        """src/routes/recipes/index.tsx:15:5
SyntaxError: Unexpected token '}'
  13 |     <div>
  14 |       <h1>Recipes</h1>
> 15 |     }
     |     ^
  16 |   </div>
  17 | )""",
        ["read_build_log", "locate_syntax_error", "fix_syntax"],
        "Agent must locate the syntax error (extra closing brace), read the file, and fix it"
    ),
    
    # Scenario 9: Missing __root.tsx (TanStack Router requirement)
    (
        "missing_root_route",
        "No root route found",
        """[error] TanStack Router: Root route not found
Expected to find a root route at one of the following locations:
  - src/routes/__root.tsx
  - src/routes/__root.ts

Please create a root route file.""",
        ["read_build_log", "create_root_route"],
        "Agent must understand TanStack Router requires __root.tsx and create it with proper Outlet component"
    ),
    
    # Scenario 10: Build timeout / incomplete generation
    (
        "incomplete_generation_timeout",
        "Build failed: Project structure incomplete",
        """[07:28:48] Starting build...
[07:28:50] Checking project structure...
[07:28:50] ❌ Missing required files:
  - src/routes/ (directory not found)
  - src/router.tsx (not found)
  - src/client.tsx (not found)
[07:28:50] Build aborted due to incomplete structure""",
        ["read_build_log", "check_all_missing_files", "create_minimal_scaffolding", "test_build"],
        "Agent must recognize generation was incomplete, check what's missing, create minimal working structure, and verify build succeeds"
    ),
]


# Hard recovery scenarios - multiple issues
COMPLEX_RECOVERY_SCENARIOS = [
    # Multiple missing files
    (
        "multiple_missing_files",
        "Multiple errors found",
        """[vite:error] Cannot find module './router' from 'src/client.tsx'
[vite:error] Cannot find module './routes/__root' from 'src/router.tsx'
[vite:error] ENOENT: no such file or directory, scandir '/app/project/src/routes'
Build failed with 3 errors.""",
        ["read_build_log", "identify_all_missing", "create_router", "create_root_route", "create_routes_dir", "test_build"],
        "Agent must handle cascading errors, create multiple missing files in correct order"
    ),
    
    # Schema + code mismatch
    (
        "schema_code_mismatch",
        "Type error: Property 'ingredients' does not exist",
        """TS2339: Property 'ingredients' does not exist on type 'Recipe'

Generated types show Recipe does not have 'ingredients' field, but code tries to use it.
This happens when schema.prisma was updated but `bun run generate` wasn't run.""",
        ["read_build_log", "check_schema_vs_types", "run_generate_command", "wait_for_rebuild"],
        "Agent must recognize schema/types are out of sync and run `bun run generate` to regenerate types"
    ),
    
    # Circular dependency
    (
        "circular_import_error",
        "Circular dependency detected",
        """error: Circular dependency detected:
  src/components/RecipeList.tsx
  → src/components/RecipeCard.tsx  
  → src/components/RecipeList.tsx
[vite:error] Build failed""",
        ["read_build_log", "analyze_imports", "refactor_to_break_cycle"],
        "Agent must detect circular imports and refactor to break the cycle (extract shared interface or rearrange)"
    ),
]


# Edge cases - should NOT fix (user action required)
UNFIXABLE_SCENARIOS = [
    # Database connection failure (infrastructure issue)
    (
        "database_connection_failed",
        "Error: Can't reach database server",
        """prisma:error Error: Can't reach database server at `localhost:5432`
Please make sure your database server is running at `localhost:5432`.
[prisma] Connection refused""",
        ["read_error", "explain_infrastructure_issue", "tell_user_to_check_db"],
        "Agent should recognize this is infrastructure issue, not code issue, and ask user to check database"
    ),
    
    # Out of memory (resource constraint)
    (
        "out_of_memory_error",
        "JavaScript heap out of memory",
        """<--- Last few GCs --->
[12345:0x5555]  Fatal Error: Reached heap limit Allocation failed - JavaScript heap out of memory
[vite:error] Process terminated: Out of memory""",
        ["read_error", "explain_resource_constraint", "suggest_reduce_complexity"],
        "Agent should explain memory constraint and suggest simplifying the project or increasing resources"
    ),
]


# ============================================================
# Log Reading Scenarios
# ============================================================

# Test if agent actually READS the logs to get information
LOG_READING_SCENARIOS = [
    # Error message is vague, but log has details
    (
        "vague_error_detailed_log",
        "Build failed with errors",
        """[vite] transforming...
[vite] ✓ 45 modules transformed.
[vite:error] src/routes/recipes/index.tsx:23:15
error TS2305: Module '"../../../generated/domain"' has no exported member 'RecipeStore'.

23   const store = useStore() as RecipeStore;
                   ^^^^^^^^^

Did you mean 'useRecipeStore'?
[vite:error] Build failed with 1 error.""",
        ["read_build_log", "identify_specific_error", "fix_import", "use_correct_hook"],
        "Agent must READ the log to find the specific error (not just the summary), and see the suggested fix"
    ),
    
    # Multiple errors, need to prioritize
    (
        "multiple_errors_prioritize",
        "Build failed with 5 errors",
        """error TS2304: Cannot find name 'Recipe'. [src/components/RecipeCard.tsx:12]
error TS2339: Property 'ingredients' does not exist. [src/components/RecipeForm.tsx:8]
error TS2307: Cannot find module './RecipeList'. [src/routes/recipes/index.tsx:3]
error TS2322: Type 'string' is not assignable to type 'number'. [src/utils/format.ts:5]
error TS2551: Property 'dificulty' does not exist. Did you mean 'difficulty'? [src/components/RecipeCard.tsx:18]

Build failed with 5 errors.""",
        ["read_build_log", "categorize_errors", "fix_typo_first", "fix_imports", "fix_type_error"],
        "Agent must read ALL errors, identify the easy typo fix first (dificulty→difficulty), then fix structural issues"
    ),
]


# ============================================================
# Self-Recovery Success Patterns
# ============================================================

# What "good" recovery looks like - agent follows correct process
GOOD_RECOVERY_PATTERNS = [
    (
        "perfect_recovery_missing_routes",
        "ENOENT: scandir src/routes",
        """[vite:error] ENOENT: no such file or directory, scandir '/app/project/src/routes'""",
        [
            "I see the build failed because src/routes directory is missing",
            "Let me check the build log for details: `cat .build.log | tail -100`",
            "The error confirms routes directory doesn't exist",
            "I'll create the routes directory: `mkdir -p src/routes`",
            "Now I'll create a home route: [creates src/routes/index.tsx]",
            "And create the root route: [creates src/routes/__root.tsx]",
            "The build should automatically retry in a few seconds",
            "[waits for rebuild]",
            "Build succeeded! Your recipe app is now ready."
        ],
        "Agent follows perfect recovery flow: acknowledge error → read logs → understand → fix → verify"
    ),
]


# ============================================================
# Bad Recovery Anti-Patterns
# ============================================================

# What agents SHOULD NOT do
BAD_RECOVERY_PATTERNS = [
    (
        "gives_up_immediately",
        "ENOENT: scandir src/routes",
        """error: ENOENT: no such file or directory""",
        [
            "I apologize, the build failed",
            "Please try again later",
            "You may need to restart the server"
        ],
        "Agent gives up without attempting any fix - BAD"
    ),
    
    (
        "doesnt_read_logs",
        "Build failed",
        """[has detailed error in logs]""",
        [
            "The build failed",
            "I'll try regenerating the files",
            "[regenerates without understanding what's wrong]"
        ],
        "Agent doesn't read logs to understand the actual issue - BAD"
    ),
    
    (
        "false_reassurance",
        "ENOENT: scandir src/routes",
        """error: ENOENT: no such file or directory""",
        [
            "Don't worry, the build will retry automatically",
            "Just refresh the page",
            "This should fix itself"
        ],
        "Agent gives false reassurance instead of fixing - BAD"
    ),
    
    (
        "creates_wrong_fix",
        "ENOENT: scandir src/routes",
        """error: ENOENT: no such file or directory, scandir '/app/project/src/routes'""",
        [
            "I'll create a routes.tsx file",
            "[creates single routes.tsx file instead of routes/ directory]"
        ],
        "Agent misunderstands the error and creates wrong fix - BAD"
    ),
]


def create_build_recovery_trainset() -> List[dspy.Example]:
    """Create training dataset for build failure recovery."""
    examples = []
    
    # Individual failure scenarios
    for (scenario, error_msg, log_excerpt, expected_actions, reasoning) in BUILD_FAILURE_SCENARIOS:
        examples.append(dspy.Example(
            scenario_name=scenario,
            build_error_message=error_msg,
            build_log_excerpt=log_excerpt,
            should_read_logs=True,
            can_self_recover=True,
            expected_actions=expected_actions,
            reasoning=reasoning
        ).with_inputs("build_error_message", "build_log_excerpt"))
    
    # Complex scenarios
    for (scenario, error_msg, log_excerpt, expected_actions, reasoning) in COMPLEX_RECOVERY_SCENARIOS:
        examples.append(dspy.Example(
            scenario_name=scenario,
            build_error_message=error_msg,
            build_log_excerpt=log_excerpt,
            should_read_logs=True,
            can_self_recover=True,
            expected_actions=expected_actions,
            reasoning=reasoning
        ).with_inputs("build_error_message", "build_log_excerpt"))
    
    # Log reading scenarios
    for (scenario, error_msg, log_excerpt, expected_actions, reasoning) in LOG_READING_SCENARIOS:
        examples.append(dspy.Example(
            scenario_name=scenario,
            build_error_message=error_msg,
            build_log_excerpt=log_excerpt,
            should_read_logs=True,
            can_self_recover=True,
            expected_actions=expected_actions,
            reasoning=reasoning
        ).with_inputs("build_error_message", "build_log_excerpt"))
    
    # Unfixable scenarios (should NOT try to fix)
    for (scenario, error_msg, log_excerpt, expected_actions, reasoning) in UNFIXABLE_SCENARIOS:
        examples.append(dspy.Example(
            scenario_name=scenario,
            build_error_message=error_msg,
            build_log_excerpt=log_excerpt,
            should_read_logs=True,
            can_self_recover=False,  # Different!
            expected_actions=expected_actions,
            reasoning=reasoning
        ).with_inputs("build_error_message", "build_log_excerpt"))
    
    return examples


def create_build_recovery_testset() -> List[dspy.Example]:
    """Create challenging test dataset for build recovery."""
    test_scenarios = [
        # Variations of common errors
        (
            "routes_empty_not_missing",
            "No route files found in src/routes",
            """[TanStack Router] No route files found in directory: src/routes/
Expected at least one route file with .tsx or .ts extension.
[vite:error] Build failed""",
            ["read_build_log", "check_routes_directory_contents", "create_index_route"],
            "Directory exists but is empty - different fix than missing directory"
        ),
        
        (
            "wrong_file_extension",
            "Invalid route file extension",
            """[TanStack Router] Found invalid route file: src/routes/index.jsx
Only .tsx and .ts extensions are supported for route files.
Please rename index.jsx to index.tsx""",
            ["read_build_log", "identify_wrong_file", "rename_or_recreate"],
            "File exists but has wrong extension"
        ),
        
        # New: import path errors
        (
            "wrong_import_path",
            "Module not found: Can't resolve '../generated/types'",
            """Module not found: Error: Can't resolve '../generated/types' in 'src/routes/index.tsx'
Did you mean '../../generated/types'? (wrong relative path depth)
[vite:error] Build failed""",
            ["read_build_log", "check_file_location", "fix_import_path"],
            "Import path has wrong depth, needs to be corrected"
        ),
        
        # React-specific errors
        (
            "missing_react_import",
            "ReferenceError: React is not defined",
            """src/components/RecipeCard.tsx:10:3
error: 'React' is not defined
  10 |   <div className="recipe-card">
     |   ^
JSX requires React to be in scope.""",
            ["read_build_log", "add_react_import"],
            "Missing `import React from 'react'` in component file"
        ),
        
        # Schema-code sync issues
        (
            "stale_generated_files",
            "Type mismatch after schema change",
            """TS2322: Type '{ name: string; ingredients: string[] }' is not assignable to type 'Recipe'
  Property 'cookingTime' is missing in type but required in type 'Recipe'.

Note: This usually means the generated types are out of sync with schema.prisma""",
            ["read_build_log", "identify_schema_sync_issue", "run_generate_command"],
            "Agent added field to schema but didn't run `bun run generate`, so types are stale"
        ),
    ]
    
    examples = []
    for (scenario, error_msg, log_excerpt, expected_actions, reasoning) in test_scenarios:
        examples.append(dspy.Example(
            scenario_name=scenario,
            build_error_message=error_msg,
            build_log_excerpt=log_excerpt,
            should_read_logs=True,
            can_self_recover=True,
            expected_actions=expected_actions,
            reasoning=reasoning
        ).with_inputs("build_error_message", "build_log_excerpt"))
    
    return examples


# ============================================================
# Proactive Detection Scenarios
# ============================================================

# Agent should detect issues BEFORE they cause build failures
PROACTIVE_DETECTION_SCENARIOS = [
    (
        "detect_missing_dir_before_build",
        "About to build, but src/routes missing",
        "",  # No error yet
        ["check_project_structure", "detect_missing_routes", "create_before_build"],
        "Agent should check structure exists before building, catch issues proactively"
    ),
    
    (
        "detect_schema_validation_before_generate",
        "Schema has enum reference but enum not defined",
        "",
        ["run_prisma_validate", "detect_enum_missing", "add_enum_definition"],
        "Agent should run `prisma validate` before `prisma generate` to catch errors early"
    ),
]


def create_proactive_detection_trainset() -> List[dspy.Example]:
    """Training dataset for proactive issue detection."""
    examples = []
    
    for (scenario, context, log, expected_actions, reasoning) in PROACTIVE_DETECTION_SCENARIOS:
        examples.append(dspy.Example(
            scenario_name=scenario,
            context=context,
            build_log_excerpt=log,
            is_proactive=True,
            expected_actions=expected_actions,
            reasoning=reasoning
        ).with_inputs("context"))
    
    return examples


# ============================================================
# Helper Functions
# ============================================================

def get_all_datasets():
    """Get all build recovery datasets for comprehensive testing."""
    return {
        "basic_recovery": create_build_recovery_trainset(),
        "basic_recovery_test": create_build_recovery_testset(),
        "proactive_detection": create_proactive_detection_trainset(),
    }


def print_dataset_stats():
    """Print statistics about the datasets."""
    datasets = get_all_datasets()
    
    print("\n" + "="*60)
    print("BUILD RECOVERY DATASET STATISTICS")
    print("="*60)
    
    for name, dataset in datasets.items():
        print(f"\n{name}:")
        print(f"  Total examples: {len(dataset)}")
        
        # Count by scenario type
        can_recover = sum(1 for ex in dataset if getattr(ex, 'can_self_recover', True))
        must_read_logs = sum(1 for ex in dataset if getattr(ex, 'should_read_logs', False))
        
        print(f"  Can self-recover: {can_recover}")
        print(f"  Must read logs: {must_read_logs}")
    
    print("="*60 + "\n")


# ============================================================
# Example Scenarios with Full Conversation Context
# ============================================================

FULL_CONVERSATION_SCENARIOS = [
    {
        "name": "e2e_recipe_app_failure",
        "description": "Exact scenario from E2E test - Recipe app generation fails",
        "conversation": [
            {
                "role": "user",
                "content": "Create a recipe book app with a Recipe model that has fields: name (string), ingredients (text array), instructions (text), cookingTime (number in minutes), and difficulty (enum: easy, medium, hard). Include a list view and form to add/edit recipes."
            },
            {
                "role": "assistant",
                "content": "[Generates Prisma schema correctly]",
                "files_created": ["prisma/schema.prisma"],
                "files_missing": ["src/routes/", "src/router.tsx", "src/client.tsx"]
            },
            {
                "role": "system",
                "content": "Build failed: ENOENT: no such file or directory, scandir '/app/project/src/routes'"
            },
        ],
        "expected_recovery": [
            "read_build_log",
            "identify_missing_routes",
            "create_routes_directory",
            "create_index_route",
            "create_root_route",
            "wait_for_rebuild",
            "verify_success"
        ],
        "success_criteria": {
            "reads_logs": True,
            "creates_missing_files": True,
            "verifies_fix": True,
            "time_to_recovery": "< 120 seconds"
        }
    },
]


if __name__ == "__main__":
    print_dataset_stats()
    
    # Show example
    trainset = create_build_recovery_trainset()
    if trainset:
        print("\nSample build recovery example:")
        print(f"Scenario: {trainset[0].scenario_name}")
        print(f"Error: {trainset[0].build_error_message}")
        print(f"Can recover: {trainset[0].can_self_recover}")
        print(f"Expected actions: {trainset[0].expected_actions}")
