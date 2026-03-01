"""
DSPy Signatures for Build Failure Recovery

Defines the agent behavior we want when builds fail.
The critical behavior we're training: ALWAYS read the full build log FIRST.
"""

import dspy


class BuildErrorAnalysis(dspy.Signature):
    """Analyze a build error and determine recovery steps.
    
    CRITICAL PROTOCOL FOR BUILD FAILURES:
    
    The FIRST action when encountering ANY build error MUST be reading the full log:
    `cat .build.log`
    
    This is NON-NEGOTIABLE because:
    - Error messages shown to the agent are often truncated
    - The full context is needed to diagnose correctly
    - Skipping log reading leads to incorrect fixes
    - The build log contains file paths, line numbers, and stack traces
    
    STEP 1 (MANDATORY): should_read_full_log = True, first action = "cat .build.log"
    STEP 2: Categorize the error based on log content
    STEP 3: Identify root cause from the full log
    STEP 4: Determine if self-fixable
    STEP 5: Create step-by-step fix plan (starting with "1. Read full build log")
    
    Available tools:
    - `cat .build.log` - COMPLETE build output (USE THIS FIRST!)
    - `ls -la src/` - Check project structure  
    - `bunx tsc --noEmit` - Check TypeScript errors
    - File creation/editing tools
    - `bun run generate` - Regenerate Prisma client
    """
    
    build_error_message: str = dspy.InputField(
        desc="The error message shown to the agent (MAY BE TRUNCATED - always read full log!)"
    )
    build_log_excerpt: str = dspy.InputField(
        desc="Excerpt from the build log (last 20-50 lines) - NOT complete, must read full log"
    )
    
    should_read_full_log: bool = dspy.OutputField(
        desc="MUST be True! Agent MUST read the complete .build.log file before attempting ANY fix. This is mandatory."
    )
    error_category: str = dspy.OutputField(
        desc="Category: 'missing_files', 'typescript_error', 'dependency_missing', 'syntax_error', 'schema_sync', 'unfixable'"
    )
    root_cause: str = dspy.OutputField(
        desc="Brief description of the root cause (e.g., 'src/routes directory does not exist')"
    )
    can_self_fix: bool = dspy.OutputField(
        desc="True if the agent can fix this without user intervention"
    )
    fix_plan: str = dspy.OutputField(
        desc="Step-by-step plan STARTING WITH '1. Read full build log (cat .build.log)' then other steps"
    )


class BuildRecoveryAction(dspy.Signature):
    """Generate the specific actions needed to recover from a build failure.
    
    After analyzing the error, generate concrete commands and file operations.
    """
    
    error_category: str = dspy.InputField(desc="The category of error")
    root_cause: str = dspy.InputField(desc="The root cause identified")
    build_log_full: str = dspy.InputField(desc="The complete build log (after agent reads it)")
    
    first_command: str = dspy.OutputField(
        desc="The first command to run (e.g., 'cat .build.log | tail -100' or 'ls -la src/')"
    )
    files_to_create: str = dspy.OutputField(
        desc="Comma-separated list of files to create (e.g., 'src/routes/index.tsx, src/routes/__root.tsx')"
    )
    directories_to_create: str = dspy.OutputField(
        desc="Comma-separated list of directories to create (e.g., 'src/routes')"
    )
    commands_to_run: str = dspy.OutputField(
        desc="Comma-separated list of commands (e.g., 'bun run generate, bunx tsc --noEmit')"
    )
    verification_step: str = dspy.OutputField(
        desc="How to verify the fix worked (e.g., 'Wait for auto-rebuild, check build succeeds')"
    )


class LogAnalysisQuality(dspy.Signature):
    """Evaluate if the agent properly analyzed build logs.
    
    Good log analysis:
    - Reads the COMPLETE log, not just the summary
    - Identifies ALL relevant errors (not just the first)
    - Extracts file paths, line numbers, and specific issues
    - Distinguishes between primary error and cascading errors
    """
    
    build_log: str = dspy.InputField(desc="The complete build log")
    agent_analysis: str = dspy.InputField(desc="The agent's analysis of the log")
    
    read_complete_log: bool = dspy.OutputField(
        desc="True if agent read the full log (not just error summary)"
    )
    identified_all_errors: bool = dspy.OutputField(
        desc="True if agent found all distinct errors in the log"
    )
    extracted_file_paths: bool = dspy.OutputField(
        desc="True if agent extracted specific file paths that need fixing"
    )
    prioritized_fixes: bool = dspy.OutputField(
        desc="True if agent prioritized which errors to fix first"
    )
    analysis_quality_score: float = dspy.OutputField(
        desc="Overall quality score 0-1 based on thoroughness"
    )


# ============================================================
# Combined Build Recovery Module
# ============================================================

class BuildRecoveryAgent(dspy.Module):
    """Complete agent for build failure recovery.
    
    This module handles:
    1. Error analysis (categorize, find root cause)
    2. Log reading and analysis
    3. Recovery action generation
    4. Verification
    """
    
    def __init__(self):
        super().__init__()
        self.analyze_error = dspy.ChainOfThought(BuildErrorAnalysis)
        self.generate_recovery = dspy.Predict(BuildRecoveryAction)
    
    def forward(self, build_error_message: str, build_log_excerpt: str):
        # Step 1: Analyze the error
        analysis = self.analyze_error(
            build_error_message=build_error_message,
            build_log_excerpt=build_log_excerpt
        )
        
        # If unfixable, return early
        if not analysis.can_self_fix:
            return dspy.Prediction(
                can_fix=False,
                should_read_logs=analysis.should_read_full_log,
                error_category=analysis.error_category,
                root_cause=analysis.root_cause,
                fix_plan=analysis.fix_plan,
                actions=None,
                reasoning="This error requires user intervention or infrastructure changes"
            )
        
        # Step 2: Generate recovery actions
        # In real scenario, agent would read the full log here
        recovery = self.generate_recovery(
            error_category=analysis.error_category,
            root_cause=analysis.root_cause,
            build_log_full=build_log_excerpt  # In real usage, this would be full log
        )
        
        return dspy.Prediction(
            can_fix=True,
            should_read_logs=analysis.should_read_full_log,
            error_category=analysis.error_category,
            root_cause=analysis.root_cause,
            fix_plan=analysis.fix_plan,
            actions={
                "first_command": recovery.first_command,
                "files_to_create": recovery.files_to_create.split(", ") if recovery.files_to_create else [],
                "directories": recovery.directories_to_create.split(", ") if recovery.directories_to_create else [],
                "commands": recovery.commands_to_run.split(", ") if recovery.commands_to_run else [],
                "verification": recovery.verification_step
            },
            reasoning=analysis.fix_plan
        )


# ============================================================
# Simplified Module for Faster Optimization
# ============================================================

class BuildErrorAnalyzer(dspy.Module):
    """Focused module for just error analysis (faster to optimize)."""
    
    def __init__(self):
        super().__init__()
        self.analyze = dspy.ChainOfThought(BuildErrorAnalysis)
    
    def forward(self, build_error_message: str, build_log_excerpt: str):
        return self.analyze(
            build_error_message=build_error_message,
            build_log_excerpt=build_log_excerpt
        )


# ============================================================
# Real-world Integration Signature
# ============================================================

class AgentResponseToBuildFailure(dspy.Signature):
    """Generate the agent's complete response to a build failure.
    
    This is what the agent should say/do when it encounters a build error.
    Should be informative, action-oriented, and NOT give false reassurance.
    """
    
    build_error: str = dspy.InputField(desc="The build error message")
    analysis_result: str = dspy.InputField(desc="What the agent learned from analyzing logs")
    fix_applied: bool = dspy.InputField(desc="Whether agent has applied a fix")
    
    response_to_user: str = dspy.OutputField(
        desc="What to tell the user (should explain the issue and what's being done)"
    )
    next_action: str = dspy.OutputField(
        desc="What the agent will do next (read logs, create files, run commands, etc.)"
    )
    confidence: str = dspy.OutputField(
        desc="Agent's confidence in fixing this: 'high', 'medium', 'low', 'cannot_fix'"
    )


class BuildRecoveryResponseGenerator(dspy.Module):
    """Module for generating appropriate responses during build recovery."""
    
    def __init__(self):
        super().__init__()
        self.analyze = dspy.ChainOfThought(BuildErrorAnalysis)
        self.respond = dspy.Predict(AgentResponseToBuildFailure)
    
    def forward(self, build_error_message: str, build_log_excerpt: str):
        # Analyze first
        analysis = self.analyze(
            build_error_message=build_error_message,
            build_log_excerpt=build_log_excerpt
        )
        
        # Generate response
        response = self.respond(
            build_error=build_error_message,
            analysis_result=f"Category: {analysis.error_category}, Root cause: {analysis.root_cause}",
            fix_applied=False  # Just starting recovery
        )
        
        return dspy.Prediction(
            analysis=analysis,
            response_to_user=response.response_to_user,
            next_action=response.next_action,
            confidence=response.confidence
        )
