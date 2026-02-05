#!/usr/bin/env python3
"""
DSPy Build Recovery Optimization Script

Tests and optimizes the agent's ability to handle build failures and self-recover.

Usage:
    # Run evaluation only with Haiku
    python -m packages.mcp.src.evals.dspy.optimize_build_recovery --eval-only --model claude-3-5-haiku-20241022
    
    # Run optimization with MIPRO
    python -m packages.mcp.src.evals.dspy.optimize_build_recovery --strategy mipro --model claude-3-5-haiku-20241022
    
    # Compare multiple models
    python -m packages.mcp.src.evals.dspy.optimize_build_recovery --compare-models
"""

import argparse
import json
import os
from datetime import datetime
from pathlib import Path

import dspy
from dspy.evaluate import Evaluate

from build_recovery_signatures import (
    BuildRecoveryAgent,
    BuildErrorAnalyzer,
    BuildRecoveryResponseGenerator,
)
from build_recovery_dataset import (
    create_build_recovery_trainset,
    create_build_recovery_testset,
    create_proactive_detection_trainset,
    print_dataset_stats,
)
from build_recovery_metrics import (
    combined_recovery_metric,
    BuildRecoveryMetrics,
    compare_models,
    print_model_comparison,
    critical_success_factors,
    print_critical_factors,
)


def setup_dspy(model: str = "claude-3-5-haiku-20241022"):
    """Configure DSPy with the specified model."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY environment variable not set")
    
    lm = dspy.LM(
        model=f"anthropic/{model}",
        api_key=api_key,
        max_tokens=2000,  # Longer for build recovery reasoning
    )
    dspy.configure(lm=lm)
    return lm


def evaluate_baseline(agent, testset, verbose: bool = True):
    """Evaluate the agent before optimization."""
    if verbose:
        print("\n" + "="*60)
        print("BASELINE EVALUATION - Build Recovery")
        print("="*60)
    
    evaluator = Evaluate(
        devset=testset,
        metric=combined_recovery_metric,
        num_threads=4,
        display_progress=verbose,
        display_table=5 if verbose else 0,
    )
    
    result = evaluator(agent)
    score = float(result.score) if hasattr(result, 'score') else float(result)
    
    if verbose:
        print(f"\nBaseline combined score: {score:.3f}")
    
    # Detailed metrics
    metrics = BuildRecoveryMetrics()
    for example in testset:
        pred = agent(
            build_error_message=example.build_error_message,
            build_log_excerpt=example.build_log_excerpt
        )
        metrics.add_result(example, pred)
    
    if verbose:
        metrics.print_summary()
        metrics.print_detailed_results()
    
    return score, metrics.summary()


def test_single_scenario(agent, scenario_name: str = "missing_routes_directory"):
    """Test a single scenario in detail."""
    from build_recovery_dataset import BUILD_FAILURE_SCENARIOS
    
    # Find the scenario
    scenario = None
    for s in BUILD_FAILURE_SCENARIOS:
        if s[0] == scenario_name:
            scenario = s
            break
    
    if not scenario:
        print(f"Scenario '{scenario_name}' not found")
        return
    
    name, error_msg, log_excerpt, expected_actions, reasoning = scenario
    
    print(f"\n{'='*70}")
    print(f"TESTING SCENARIO: {name}")
    print(f"{'='*70}")
    print(f"\nError message: {error_msg}")
    print(f"\nBuild log excerpt:")
    print(log_excerpt)
    print(f"\nExpected actions: {', '.join(expected_actions)}")
    print(f"\nReasoning: {reasoning}")
    
    print(f"\n{'-'*70}")
    print("AGENT RESPONSE:")
    print(f"{'-'*70}")
    
    # Run the agent
    prediction = agent(
        build_error_message=error_msg,
        build_log_excerpt=log_excerpt
    )
    
    # Print prediction details
    print(f"\nShould read logs: {getattr(prediction, 'should_read_full_log', 'N/A')}")
    print(f"Error category: {getattr(prediction, 'error_category', 'N/A')}")
    print(f"Root cause: {getattr(prediction, 'root_cause', 'N/A')}")
    print(f"Can self-fix: {getattr(prediction, 'can_self_fix', 'N/A')}")
    print(f"\nFix plan:")
    print(getattr(prediction, 'fix_plan', 'N/A'))
    
    actions = getattr(prediction, 'actions', None)
    if actions:
        print(f"\nActions:")
        print(f"  First command: {actions.get('first_command', 'N/A')}")
        print(f"  Directories: {', '.join(actions.get('directories', []))}")
        print(f"  Files to create: {', '.join(actions.get('files_to_create', []))}")
        print(f"  Commands: {', '.join(actions.get('commands', []))}")
        print(f"  Verification: {actions.get('verification', 'N/A')}")
    
    # Evaluate
    import dspy
    example = dspy.Example(
        scenario_name=name,
        build_error_message=error_msg,
        build_log_excerpt=log_excerpt,
        should_read_logs=True,
        can_self_recover=True,
        expected_actions=expected_actions,
        reasoning=reasoning
    ).with_inputs("build_error_message", "build_log_excerpt")
    
    score = combined_recovery_metric(example, prediction)
    
    print(f"\n{'-'*70}")
    print(f"EVALUATION:")
    print(f"{'-'*70}")
    print(f"Combined score: {score:.3f}")
    print_critical_factors(prediction)
    print(f"{'='*70}\n")


def compare_all_models(testset):
    """Compare Haiku, Sonnet, and Opus on build recovery."""
    models = {
        "Haiku": "claude-3-5-haiku-20241022",
        "Sonnet 3.5": "claude-3-5-sonnet-20241022",
        "Sonnet 4": "claude-sonnet-4-20250514",
    }
    
    print("\n" + "="*70)
    print("MODEL COMPARISON - Build Recovery")
    print("="*70)
    print("\nTesting models:", ", ".join(models.keys()))
    print(f"Test set size: {len(testset)} scenarios\n")
    
    all_results = {}
    
    for model_name, model_id in models.items():
        print(f"\n{'-'*70}")
        print(f"Testing {model_name} ({model_id})...")
        print(f"{'-'*70}")
        
        try:
            # Setup model
            setup_dspy(model_id)
            
            # Create agent
            agent = BuildRecoveryAgent()
            
            # Evaluate
            score, metrics = evaluate_baseline(agent, testset, verbose=False)
            
            print(f"✅ {model_name} completed:")
            print(f"   Combined score: {score:.3f}")
            print(f"   Passing rate: {metrics.get('passing', 0)}/{metrics.get('total', 0)}")
            
            all_results[model_name] = {
                "model_id": model_id,
                "score": score,
                "metrics": metrics,
            }
            
        except Exception as e:
            print(f"❌ {model_name} failed: {str(e)}")
            all_results[model_name] = {
                "model_id": model_id,
                "error": str(e)
            }
    
    # Print comparison
    print("\n" + "="*70)
    print("FINAL COMPARISON")
    print("="*70)
    
    comparison_table = {}
    for model_name, result in all_results.items():
        if "error" not in result:
            comparison_table[model_name] = {
                "avg_combined": result["score"],
                "reads_logs_rate": result["metrics"].get("avg_reads_logs", 0),
                "self_fix_rate": result["metrics"].get("avg_self_fix", 0),
                "no_false_reassurance": result["metrics"].get("no_false_reassurance_rate", 0),
            }
    
    print_model_comparison(comparison_table)
    
    # Save results
    output_dir = Path("packages/mcp/src/evals/dspy/results")
    output_dir.mkdir(parents=True, exist_ok=True)
    
    results_file = output_dir / f"model_comparison_build_recovery_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(results_file, "w") as f:
        json.dump(all_results, f, indent=2)
    
    print(f"\nResults saved to: {results_file}")
    
    return all_results


def optimize_with_mipro(agent, trainset, num_trials: int = 25):
    """Optimize using MIPRO."""
    print("\n" + "="*60)
    print("MIPRO OPTIMIZATION - Build Recovery")
    print("="*60)
    
    optimizer = dspy.MIPROv2(
        metric=combined_recovery_metric,
        num_threads=4,
        verbose=True,
        auto="light",
    )
    
    optimized = optimizer.compile(
        agent,
        trainset=trainset,
    )
    
    return optimized


def save_results(output_dir: Path, baseline: dict, optimized_score: float,
                 optimized_metrics: dict, strategy: str, model: str):
    """Save optimization results."""
    output_dir.mkdir(parents=True, exist_ok=True)
    
    timestamp = datetime.now().isoformat()
    
    results = {
        "timestamp": timestamp,
        "model": model,
        "strategy": strategy,
        "baseline": baseline,
        "optimized": optimized_metrics,
        "improvement": {
            "combined_score": optimized_metrics.get("avg_combined", 0) - baseline.get("avg_combined", 0),
            "reads_logs": optimized_metrics.get("avg_reads_logs", 0) - baseline.get("avg_reads_logs", 0),
            "plan_quality": optimized_metrics.get("avg_plan_quality", 0) - baseline.get("avg_plan_quality", 0),
        }
    }
    
    results_file = output_dir / f"build_recovery_{strategy}_{model.replace('/', '_')}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(results_file, "w") as f:
        json.dump(results, f, indent=2)
    
    print(f"\nResults saved to: {results_file}")
    return results


def main():
    parser = argparse.ArgumentParser(description="Optimize build recovery agent with DSPy")
    parser.add_argument("--strategy", choices=["mipro", "bootstrap"], default="mipro",
                        help="Optimization strategy")
    parser.add_argument("--num-trials", type=int, default=25,
                        help="Number of optimization trials")
    parser.add_argument("--output", type=str, default="packages/mcp/src/evals/dspy/results",
                        help="Output directory")
    parser.add_argument("--model", type=str, default="claude-3-5-haiku-20241022",
                        help="Model to use for evaluation")
    parser.add_argument("--eval-only", action="store_true",
                        help="Only evaluate, don't optimize")
    parser.add_argument("--compare-models", action="store_true",
                        help="Compare Haiku, Sonnet, and Opus")
    parser.add_argument("--test-scenario", type=str,
                        help="Test a single scenario in detail")
    
    args = parser.parse_args()
    
    # Print dataset stats
    print_dataset_stats()
    
    # Setup output directory
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Load datasets
    trainset = create_build_recovery_trainset()
    testset = create_build_recovery_testset()
    
    print(f"\nDataset sizes:")
    print(f"  Training: {len(trainset)} scenarios")
    print(f"  Test: {len(testset)} scenarios")
    
    # Model comparison mode
    if args.compare_models:
        compare_all_models(testset)
        return
    
    # Setup model
    print(f"\nUsing model: {args.model}")
    setup_dspy(args.model)
    
    # Create agent
    agent = BuildRecoveryAgent()
    
    # Test single scenario mode
    if args.test_scenario:
        test_single_scenario(agent, args.test_scenario)
        return
    
    # Baseline evaluation
    print("\n" + "="*70)
    print("STEP 1: Baseline Evaluation")
    print("="*70)
    
    baseline_score, baseline_metrics = evaluate_baseline(agent, testset)
    
    # Evaluation only mode
    if args.eval_only:
        print("\n" + "="*70)
        print("EVALUATION COMPLETE (no optimization)")
        print("="*70)
        print(f"Model: {args.model}")
        print(f"Combined score: {baseline_score:.3f}")
        print(f"Passing (>= 0.7): {baseline_metrics.get('passing', 0)}/{baseline_metrics.get('total', 0)}")
        
        # Save eval results
        eval_results = {
            "timestamp": datetime.now().isoformat(),
            "model": args.model,
            "mode": "eval_only",
            "metrics": baseline_metrics,
        }
        
        results_file = output_dir / f"build_recovery_eval_{args.model.replace('/', '_')}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(results_file, "w") as f:
            json.dump(eval_results, f, indent=2)
        
        print(f"\nResults saved to: {results_file}")
        return
    
    # Optimization
    print("\n" + "="*70)
    print("STEP 2: Optimization")
    print("="*70)
    
    if args.strategy == "mipro":
        optimized_agent = optimize_with_mipro(agent, trainset, args.num_trials)
    else:
        print("Bootstrap not yet implemented for build recovery")
        return
    
    # Evaluate optimized agent
    print("\n" + "="*70)
    print("STEP 3: Post-Optimization Evaluation")
    print("="*70)
    
    optimized_score, optimized_metrics = evaluate_baseline(optimized_agent, testset)
    
    # Print improvement
    print("\n" + "="*70)
    print("OPTIMIZATION RESULTS")
    print("="*70)
    print(f"Baseline:  {baseline_score:.3f}")
    print(f"Optimized: {optimized_score:.3f}")
    print(f"Improvement: {optimized_score - baseline_score:+.3f}")
    
    improvement_pct = ((optimized_score - baseline_score) / baseline_score * 100) if baseline_score > 0 else 0
    print(f"Relative improvement: {improvement_pct:+.1f}%")
    
    # Save results
    save_results(
        output_dir,
        baseline_metrics,
        optimized_score,
        optimized_metrics,
        args.strategy,
        args.model
    )
    
    print("\n✅ Optimization complete!")


if __name__ == "__main__":
    main()
