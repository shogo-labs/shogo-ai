"""
Evaluation Metrics for Build Failure Recovery

Measures how well the agent handles build failures and recovers.
"""

import dspy


def reads_logs_metric(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """
    Measure if agent correctly identifies that it should read the build log.
    
    Returns:
        1.0 if agent says it should read logs when it should
        0.0 if agent doesn't read logs when it should
    """
    should_read = getattr(example, 'should_read_logs', True)
    
    # Check multiple possible attribute names for agent's decision
    agent_will_read = getattr(prediction, 'should_read_full_log', None)
    if agent_will_read is None:
        agent_will_read = getattr(prediction, 'should_read_logs', None)
    if agent_will_read is None:
        agent_will_read = getattr(prediction, 'pred_should_read_logs', False)
    
    # Convert to bool if string
    if isinstance(agent_will_read, str):
        agent_will_read = agent_will_read.lower() in ('true', 'yes', '1')
    
    # Also check if the fix_plan mentions reading logs (this is the key indicator)
    fix_plan = getattr(prediction, 'fix_plan', '')
    if fix_plan:
        fix_plan_lower = fix_plan.lower()
        if 'read' in fix_plan_lower and ('log' in fix_plan_lower or '.build.log' in fix_plan_lower):
            agent_will_read = True
        if 'cat .build.log' in fix_plan_lower:
            agent_will_read = True
    
    if should_read and agent_will_read:
        return 1.0
    elif not should_read and not agent_will_read:
        return 1.0
    else:
        return 0.0


def error_categorization_accuracy(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """
    Measure if agent correctly categorized the error type.
    
    Returns:
        1.0 if category matches
        0.5 if category is related (partial credit)
        0.0 if category is wrong
    """
    # Map scenario names to expected categories
    scenario_to_category = {
        # Training scenarios
        "missing_routes_directory": "missing_files",
        "nitro_plugin_null_error": "missing_files",
        "missing_router_file": "missing_files",
        "typescript_compilation_error": "typescript_error",
        "missing_prisma_client": "dependency_missing",
        "prisma_schema_validation_error": "schema_sync",
        "missing_npm_dependency": "dependency_missing",
        "javascript_syntax_error": "syntax_error",
        "missing_root_route": "missing_files",
        "incomplete_generation_timeout": "missing_files",
        "database_connection_failed": "unfixable",
        "out_of_memory_error": "unfixable",
        # Test scenarios
        "routes_empty_not_missing": "missing_files",
        "wrong_file_extension": "missing_files",  # .jsx instead of .tsx
        "wrong_import_path": "missing_files",  # Wrong import depth
        "missing_react_import": "typescript_error",  # React is not defined
        "stale_generated_files": "schema_sync",  # Types out of sync
    }
    
    scenario = getattr(example, 'scenario_name', '')
    expected_category = scenario_to_category.get(scenario, 'unknown')
    predicted_category = getattr(prediction, 'error_category', '').lower()
    
    if predicted_category == expected_category:
        return 1.0
    
    # Partial credit for related categories
    related = {
        "missing_files": {"typescript_error", "syntax_error"},  # These are often related
        "typescript_error": {"missing_files", "syntax_error"},
        "schema_sync": {"typescript_error", "missing_files"},
        "syntax_error": {"typescript_error", "missing_files"},
    }
    
    if expected_category in related and predicted_category in related[expected_category]:
        return 0.5
    
    return 0.0


def self_fix_determination(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """
    Measure if agent correctly determined whether it can self-fix.
    
    Returns:
        1.0 if can_self_fix determination is correct
        0.0 if wrong
    """
    expected = getattr(example, 'can_self_recover', True)
    predicted = getattr(prediction, 'can_self_fix', True)
    
    # Handle different attribute names
    if not hasattr(prediction, 'can_self_fix'):
        predicted = getattr(prediction, 'can_fix', True)
    
    # Convert to bool
    if isinstance(predicted, str):
        predicted = predicted.lower() in ('true', 'yes', '1')
    
    if isinstance(expected, str):
        expected = expected.lower() in ('true', 'yes', '1')
    
    return 1.0 if bool(expected) == bool(predicted) else 0.0


def recovery_plan_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """
    Evaluate the quality of the recovery plan.
    
    Good plan should:
    - Start with reading full logs
    - Include specific file checks (ls -la)
    - Create missing files in correct order
    - Verify the fix worked
    
    Returns score 0-1 based on plan quality.
    """
    fix_plan = getattr(prediction, 'fix_plan', '')
    if not fix_plan:
        return 0.0
    
    fix_plan_lower = fix_plan.lower()
    score = 0.0
    
    # Check for mandatory steps
    mandatory_steps = {
        'read': ['read', 'cat', '.build.log'],  # Must read logs
        'check': ['ls', 'check', 'verify', 'exists'],  # Must check what exists
        'create': ['create', 'mkdir', 'touch'],  # Must create missing things
        'test': ['test', 'verify', 'check', 'build'],  # Must verify fix
    }
    
    for step_name, keywords in mandatory_steps.items():
        if any(keyword in fix_plan_lower for keyword in keywords):
            score += 0.25
    
    # Bonus for mentioning specific files from expected_actions
    expected_actions = getattr(example, 'expected_actions', [])
    if expected_actions:
        mentions_expected = sum(
            1 for action in expected_actions 
            if action.replace('_', ' ') in fix_plan_lower
        )
        if mentions_expected > 0:
            score += min(0.2, mentions_expected * 0.05)
    
    return min(score, 1.0)


def action_correctness(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """
    Measure if the generated actions match expected actions semantically.
    
    Maps conceptual actions to actual commands/keywords that indicate the action.
    Returns proportion of expected actions that are present in the prediction.
    """
    expected = getattr(example, 'expected_actions', [])
    if not expected:
        return 1.0  # No expected actions to check
    
    # Get all text from prediction
    plan = getattr(prediction, 'fix_plan', '').lower()
    actions_text = str(getattr(prediction, 'actions', '')).lower()
    first_cmd = getattr(prediction, 'first_command', '').lower()
    root_cause = getattr(prediction, 'root_cause', '').lower()
    combined = f"{plan} {actions_text} {first_cmd} {root_cause}"
    
    # Map conceptual actions to keywords/commands that indicate the action
    action_indicators = {
        'read_build_log': ['cat .build.log', 'read log', 'read build', 'build.log'],
        'check_directory_exists': ['ls ', 'check', 'verify', 'exists', 'directory'],
        'check_routes_directory_contents': ['ls src/routes', 'check routes', 'routes directory'],
        'create_routes_directory': ['mkdir', 'create', 'src/routes'],
        'create_index_route': ['index.tsx', 'index route', 'create route'],
        'create_missing_structure': ['create', 'mkdir', 'structure'],
        'check_project_structure': ['ls', 'check', 'structure', 'project'],
        'identify_missing_files': ['missing', 'files', 'identify'],
        'create_router_file': ['router.tsx', 'create router'],
        'check_imports': ['import', 'check'],
        'run_tsc': ['tsc', 'typescript', 'bunx tsc'],
        'import_missing_types': ['import', 'type', 'types'],
        'fix_type_errors': ['fix', 'type', 'error'],
        'run_generate': ['bun run generate', 'generate', 'prisma generate'],
        'check_schema': ['schema.prisma', 'check schema'],
        'install_dependency': ['bun add', 'install', 'npm install'],
        'check_package_json': ['package.json'],
        'fix_syntax': ['fix', 'syntax'],
        'fix_import_path': ['import', 'path', 'fix'],
        'check_file_location': ['ls', 'check', 'location', 'file'],
        'add_react_import': ['import react', 'react import', "from 'react'"],
        'identify_wrong_file': ['wrong', 'file', 'identify', '.jsx'],
        'rename_or_recreate': ['rename', 'recreate', 'mv ', '.tsx'],
        'identify_schema_sync_issue': ['schema', 'sync', 'generate', 'prisma'],
        'run_generate_command': ['bun run generate', 'generate'],
    }
    
    matches = 0
    for action in expected:
        # Check if any indicator for this action appears in the output
        indicators = action_indicators.get(action, [action.replace('_', ' ')])
        if any(indicator in combined for indicator in indicators):
            matches += 1
    
    return matches / len(expected) if expected else 1.0


def combined_recovery_metric(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """
    Combined metric for build recovery evaluation.
    
    Weights:
    - Reads logs: 25%
    - Error categorization: 20%
    - Self-fix determination: 15%
    - Recovery plan quality: 25%
    - Action correctness: 15%
    """
    reads = reads_logs_metric(example, prediction, trace)
    category = error_categorization_accuracy(example, prediction, trace)
    self_fix = self_fix_determination(example, prediction, trace)
    plan = recovery_plan_quality(example, prediction, trace)
    actions = action_correctness(example, prediction, trace)
    
    return (reads * 0.25) + (category * 0.20) + (self_fix * 0.15) + (plan * 0.25) + (actions * 0.15)


def strict_recovery_success(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> bool:
    """
    Strict pass/fail: Agent must get ALL core aspects correct.
    
    Pass requires:
    - Says it will read logs
    - Correct error category
    - Correct can_self_fix determination
    - Recovery plan mentions creating files
    """
    reads = reads_logs_metric(example, prediction, trace)
    category = error_categorization_accuracy(example, prediction, trace)
    self_fix = self_fix_determination(example, prediction, trace)
    plan = recovery_plan_quality(example, prediction, trace)
    
    # Must get all core aspects right
    return reads == 1.0 and category >= 0.5 and self_fix == 1.0 and plan >= 0.5


# ============================================================
# Anti-Pattern Detection
# ============================================================

def detects_false_reassurance(prediction: dspy.Prediction) -> bool:
    """
    Check if agent gives false reassurance instead of fixing.
    
    Bad phrases:
    - "build will retry automatically"
    - "just refresh the page"
    - "should fix itself"
    - "try again later"
    
    Returns True if agent avoids these anti-patterns.
    """
    bad_phrases = [
        'will retry automatically',
        'retry automatically',
        'fix itself',
        'refresh the page',
        'try again later',
        'restart the server',
        'should work now',  # Without actually doing anything
    ]
    
    # Check all text fields in prediction
    response = getattr(prediction, 'response_to_user', '')
    fix_plan = getattr(prediction, 'fix_plan', '')
    combined = f"{response} {fix_plan}".lower()
    
    # Return True if NO bad phrases found
    return not any(phrase in combined for phrase in bad_phrases)


def mentions_log_reading(prediction: dspy.Prediction) -> bool:
    """
    Check if agent explicitly mentions reading logs.
    
    Good indicators:
    - "cat .build.log"
    - "read the log"
    - "check the build output"
    - "let me look at the logs"
    
    Returns True if agent mentions reading logs.
    """
    good_phrases = [
        'cat .build.log',
        'read the log',
        'read log',
        'check the build output',
        'look at the log',
        'examine the log',
        'tail -100',
    ]
    
    # Check relevant fields
    first_cmd = getattr(prediction, 'first_command', '').lower()
    fix_plan = getattr(prediction, 'fix_plan', '').lower()
    response = getattr(prediction, 'response_to_user', '').lower()
    combined = f"{first_cmd} {fix_plan} {response}"
    
    return any(phrase in combined for phrase in good_phrases)


def identifies_specific_files(prediction: dspy.Prediction) -> bool:
    """
    Check if agent identifies specific files/directories that need creation.
    
    Good indicators:
    - Mentions specific file paths (src/routes/index.tsx)
    - Mentions specific directories (src/routes)
    - Has concrete files_to_create list
    
    Returns True if agent is specific about what needs to be created.
    """
    root_cause = getattr(prediction, 'root_cause', '').lower()
    fix_plan = getattr(prediction, 'fix_plan', '').lower()
    
    # Check for specific file/directory mentions
    specific_indicators = [
        'src/routes',
        'index.tsx',
        '__root.tsx',
        'router.tsx',
        'client.tsx',
        'schema.prisma',
    ]
    
    combined = f"{root_cause} {fix_plan}"
    mentions_specific = any(indicator in combined for indicator in specific_indicators)
    
    # Also check if files_to_create is populated
    files = getattr(prediction, 'files_to_create', '')
    has_files_list = bool(files and len(str(files)) > 0)
    
    # Check actions object
    actions = getattr(prediction, 'actions', {})
    if isinstance(actions, dict):
        files_in_actions = actions.get('files_to_create', [])
        has_files_list = has_files_list or bool(files_in_actions)
    
    return mentions_specific or has_files_list


# ============================================================
# Aggregate Metrics
# ============================================================

class BuildRecoveryMetrics:
    """Aggregated metrics for tracking build recovery performance."""
    
    def __init__(self):
        self.results = []
    
    def add_result(self, example, prediction):
        self.results.append({
            "scenario": getattr(example, 'scenario_name', 'unknown'),
            "reads_logs": reads_logs_metric(example, prediction),
            "categorization": error_categorization_accuracy(example, prediction),
            "self_fix": self_fix_determination(example, prediction),
            "plan_quality": recovery_plan_quality(example, prediction),
            "action_correctness": action_correctness(example, prediction),
            "combined": combined_recovery_metric(example, prediction),
            "no_false_reassurance": detects_false_reassurance(prediction),
            "mentions_logs": mentions_log_reading(prediction),
            "specific_files": identifies_specific_files(prediction),
        })
    
    def summary(self):
        if not self.results:
            return {}
        
        n = len(self.results)
        return {
            "total": n,
            "perfect_recovery": sum(1 for r in self.results if r["combined"] == 1.0),
            "passing": sum(1 for r in self.results if r["combined"] >= 0.7),
            "avg_reads_logs": sum(r["reads_logs"] for r in self.results) / n,
            "avg_categorization": sum(r["categorization"] for r in self.results) / n,
            "avg_self_fix": sum(r["self_fix"] for r in self.results) / n,
            "avg_plan_quality": sum(r["plan_quality"] for r in self.results) / n,
            "avg_action_correctness": sum(r["action_correctness"] for r in self.results) / n,
            "avg_combined": sum(r["combined"] for r in self.results) / n,
            "no_false_reassurance_rate": sum(1 for r in self.results if r["no_false_reassurance"]) / n,
            "mentions_logs_rate": sum(1 for r in self.results if r["mentions_logs"]) / n,
            "identifies_files_rate": sum(1 for r in self.results if r["specific_files"]) / n,
        }
    
    def print_summary(self):
        s = self.summary()
        if not s:
            print("No results yet")
            return
        
        print(f"\n{'='*60}")
        print("BUILD RECOVERY METRICS")
        print(f"{'='*60}")
        print(f"Total scenarios:           {s['total']}")
        print(f"Perfect recovery (1.0):    {s['perfect_recovery']} ({s['perfect_recovery']/s['total']*100:.1f}%)")
        print(f"Passing (>= 0.7):          {s['passing']} ({s['passing']/s['total']*100:.1f}%)")
        print(f"")
        print(f"Component Scores:")
        print(f"  Reads logs:              {s['avg_reads_logs']:.3f}")
        print(f"  Categorization:          {s['avg_categorization']:.3f}")
        print(f"  Self-fix detection:      {s['avg_self_fix']:.3f}")
        print(f"  Plan quality:            {s['avg_plan_quality']:.3f}")
        print(f"  Action correctness:      {s['avg_action_correctness']:.3f}")
        print(f"")
        print(f"Anti-Pattern Detection:")
        print(f"  No false reassurance:    {s['no_false_reassurance_rate']:.1%}")
        print(f"  Mentions reading logs:   {s['mentions_logs_rate']:.1%}")
        print(f"  Identifies specific files: {s['identifies_files_rate']:.1%}")
        print(f"")
        print(f"COMBINED SCORE:            {s['avg_combined']:.3f}")
        print(f"{'='*60}\n")
    
    def print_detailed_results(self):
        """Print per-scenario breakdown."""
        if not self.results:
            print("No results yet")
            return
        
        print(f"\n{'='*60}")
        print("DETAILED RESULTS BY SCENARIO")
        print(f"{'='*60}\n")
        
        for r in self.results:
            print(f"Scenario: {r['scenario']}")
            print(f"  Combined score:    {r['combined']:.3f}")
            print(f"  Reads logs:        {r['reads_logs']:.2f}")
            print(f"  Categorization:    {r['categorization']:.2f}")
            print(f"  Self-fix:          {r['self_fix']:.2f}")
            print(f"  Plan quality:      {r['plan_quality']:.2f}")
            print(f"  Action correct:    {r['action_correctness']:.2f}")
            print(f"  No false promise:  {'✅' if r['no_false_reassurance'] else '❌'}")
            print(f"  Mentions logs:     {'✅' if r['mentions_logs'] else '❌'}")
            print(f"  Specific files:    {'✅' if r['specific_files'] else '❌'}")
            print()


def recovery_time_estimate(prediction: dspy.Prediction) -> str:
    """
    Estimate how long recovery will take based on the plan.
    
    Returns: "fast" (<1 min), "medium" (1-2 min), "slow" (>2 min), or "unknown"
    """
    actions = getattr(prediction, 'actions', {})
    fix_plan = getattr(prediction, 'fix_plan', '')
    
    if isinstance(actions, dict):
        num_files = len(actions.get('files_to_create', []))
        num_commands = len(actions.get('commands', []))
        
        total_steps = num_files + num_commands
        
        if total_steps <= 2:
            return "fast"
        elif total_steps <= 5:
            return "medium"
        else:
            return "slow"
    
    # Fallback: estimate from fix_plan length
    steps = fix_plan.count('1.') + fix_plan.count('2.') + fix_plan.count('3.')
    if steps <= 3:
        return "fast"
    elif steps <= 6:
        return "medium"
    else:
        return "slow"


# ============================================================
# Critical Success Factors
# ============================================================

def critical_success_factors(prediction: dspy.Prediction) -> dict:
    """
    Check critical factors that determine if recovery will work.
    
    These are the most important things the agent must do.
    """
    return {
        "will_read_logs": reads_logs_metric(None, prediction) == 1.0 or mentions_log_reading(prediction),
        "identifies_root_cause": bool(getattr(prediction, 'root_cause', '')),
        "has_concrete_plan": bool(getattr(prediction, 'fix_plan', '')),
        "creates_files": identifies_specific_files(prediction),
        "no_false_reassurance": detects_false_reassurance(prediction),
    }


def print_critical_factors(prediction: dspy.Prediction):
    """Print critical success factors as checklist."""
    factors = critical_success_factors(prediction)
    
    print("\nCritical Success Factors:")
    for factor, passed in factors.items():
        status = "✅" if passed else "❌"
        print(f"  {status} {factor.replace('_', ' ').title()}")
    
    all_passed = all(factors.values())
    print(f"\n{'✅ ALL CRITICAL FACTORS MET' if all_passed else '❌ MISSING CRITICAL FACTORS'}")


# ============================================================
# Model Comparison Metrics
# ============================================================

def compare_models(results_by_model: dict) -> dict:
    """
    Compare performance across different models (Haiku, Sonnet, Opus).
    
    Args:
        results_by_model: Dict of {model_name: [predictions]}
    
    Returns:
        Comparison dict with scores for each model
    """
    comparison = {}
    
    for model_name, results in results_by_model.items():
        if not results:
            continue
        
        n = len(results)
        comparison[model_name] = {
            "total": n,
            "avg_combined": sum(r.get("combined", 0) for r in results) / n,
            "reads_logs_rate": sum(r.get("reads_logs", 0) for r in results) / n,
            "self_fix_rate": sum(r.get("self_fix", 0) for r in results) / n,
            "no_false_reassurance": sum(1 for r in results if r.get("no_false_reassurance", False)) / n,
        }
    
    return comparison


def print_model_comparison(comparison: dict):
    """Print model comparison table."""
    print(f"\n{'='*70}")
    print("MODEL COMPARISON - Build Recovery Performance")
    print(f"{'='*70}")
    print(f"{'Model':<15} {'Combined':<12} {'Reads Logs':<12} {'Self-Fix':<12} {'No False Promise':<20}")
    print(f"{'-'*70}")
    
    for model, scores in comparison.items():
        print(
            f"{model:<15} "
            f"{scores['avg_combined']:.3f}        "
            f"{scores['reads_logs_rate']:.3f}        "
            f"{scores['self_fix_rate']:.3f}        "
            f"{scores['no_false_reassurance']:.1%}"
        )
    
    print(f"{'='*70}\n")


# For testing
if __name__ == "__main__":
    # Create mock example and prediction
    example = dspy.Example(
        scenario_name="missing_routes_directory",
        build_error_message="ENOENT: scandir src/routes",
        build_log_excerpt="error: ENOENT: no such file or directory",
        should_read_logs=True,
        can_self_recover=True,
        expected_actions=["read_build_log", "create_routes_directory", "create_index_route"]
    )
    
    # Good prediction
    good_pred = dspy.Prediction(
        should_read_full_log=True,
        error_category="missing_files",
        root_cause="src/routes directory does not exist",
        can_self_fix=True,
        fix_plan="1. Read full log: cat .build.log 2. Create routes: mkdir -p src/routes 3. Create index route",
        first_command="cat .build.log | tail -100",
        files_to_create="src/routes/index.tsx",
        directories_to_create="src/routes",
    )
    
    # Bad prediction
    bad_pred = dspy.Prediction(
        should_read_full_log=False,
        error_category="unknown",
        root_cause="build failed",
        can_self_fix=False,
        fix_plan="The build will retry automatically",
        response_to_user="Just refresh the page, it should work"
    )
    
    print("="*60)
    print("GOOD PREDICTION:")
    print("="*60)
    print(f"Reads logs:        {reads_logs_metric(example, good_pred):.2f}")
    print(f"Categorization:    {error_categorization_accuracy(example, good_pred):.2f}")
    print(f"Self-fix:          {self_fix_determination(example, good_pred):.2f}")
    print(f"Plan quality:      {recovery_plan_quality(example, good_pred):.2f}")
    print(f"Action correct:    {action_correctness(example, good_pred):.2f}")
    print(f"Combined:          {combined_recovery_metric(example, good_pred):.2f}")
    print_critical_factors(good_pred)
    
    print("\n" + "="*60)
    print("BAD PREDICTION:")
    print("="*60)
    print(f"Reads logs:        {reads_logs_metric(example, bad_pred):.2f}")
    print(f"Categorization:    {error_categorization_accuracy(example, bad_pred):.2f}")
    print(f"Self-fix:          {self_fix_determination(example, bad_pred):.2f}")
    print(f"Plan quality:      {recovery_plan_quality(example, bad_pred):.2f}")
    print(f"Action correct:    {action_correctness(example, bad_pred):.2f}")
    print(f"Combined:          {combined_recovery_metric(example, bad_pred):.2f}")
    print_critical_factors(bad_pred)
