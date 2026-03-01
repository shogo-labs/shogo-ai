#!/usr/bin/env python3
"""
DSPy Optimization Script for Shogo Agent

This script runs DSPy optimizers to improve the agent's template selection
and generates optimized prompts that can be exported back to TypeScript.

Usage:
    python -m packages.mcp.src.evals.dspy.optimize [options]

Options:
    --strategy [mipro|bootstrap|combined]  Optimization strategy (default: mipro)
    --num-trials N                         Number of optimization trials (default: 25)
    --output DIR                           Output directory for results
    --model MODEL                          LLM to use (default: claude-3-5-sonnet-20241022)
    --eval-only                            Just evaluate, don't optimize
"""

import argparse
import json
import os
from datetime import datetime
from pathlib import Path

import dspy
from dspy.evaluate import Evaluate

from signatures import (
    TemplateSelector, 
    ShogoTemplateAgent,
    ShogoFullAgent,
    SchemaModifier,
)
from dataset import (
    create_trainset, 
    create_testset, 
    split_dataset,
    create_schema_trainset,
    create_schema_testset,
    create_unsupported_trainset,
)
from metrics import (
    template_accuracy,
    no_unnecessary_clarification,
    combined_metric,
    AgentMetrics,
    schema_change_accuracy,
    combined_schema_metric,
    unsupported_detection_accuracy,
)


def setup_dspy(model: str = "claude-sonnet-4-20250514"):
    """Configure DSPy with the specified model."""
    # Use Anthropic Claude
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY environment variable not set")
    
    lm = dspy.LM(
        model=f"anthropic/{model}",
        api_key=api_key,
        max_tokens=1000,
    )
    dspy.configure(lm=lm)
    return lm


def evaluate_baseline(agent, testset):
    """Evaluate the agent before optimization."""
    print("\n" + "="*60)
    print("BASELINE EVALUATION")
    print("="*60)
    
    evaluator = Evaluate(
        devset=testset,
        metric=combined_metric,
        num_threads=4,
        display_progress=True,
        display_table=5,
    )
    
    result = evaluator(agent)
    # Handle both raw float and EvaluationResult objects
    score = float(result.score) if hasattr(result, 'score') else float(result)
    print(f"\nBaseline combined score: {score:.3f}")
    
    # Detailed metrics
    metrics = AgentMetrics()
    for example in testset:
        pred = agent(user_request=example.user_request)
        metrics.add_result(example, pred)
    
    metrics.print_summary()
    return score, metrics.summary()


def optimize_with_mipro(agent, trainset, num_trials: int = 25):
    """Optimize using MIPRO (instruction optimization)."""
    print("\n" + "="*60)
    print("MIPRO OPTIMIZATION")
    print("="*60)
    
    # Use auto="light" for faster optimization with reasonable quality
    optimizer = dspy.MIPROv2(
        metric=combined_metric,
        num_threads=4,
        verbose=True,
        auto="light",  # Light auto mode balances speed and quality
    )
    
    optimized = optimizer.compile(
        agent,
        trainset=trainset,
    )
    
    return optimized


def optimize_with_bootstrap(agent, trainset, max_demos: int = 3):
    """Optimize using BootstrapFewShot (example selection)."""
    print("\n" + "="*60)
    print("BOOTSTRAP FEW-SHOT OPTIMIZATION")
    print("="*60)
    
    optimizer = dspy.BootstrapFewShot(
        metric=template_accuracy,
        max_bootstrapped_demos=max_demos,
        max_labeled_demos=max_demos,
    )
    
    optimized = optimizer.compile(agent, trainset=trainset)
    return optimized


def optimize_combined(agent, trainset, num_trials: int = 25, max_demos: int = 3):
    """Combine MIPRO and BootstrapFewShot."""
    print("\n" + "="*60)
    print("COMBINED OPTIMIZATION (MIPRO + Bootstrap)")
    print("="*60)
    
    # First, bootstrap few-shot examples
    bootstrap_optimizer = dspy.BootstrapFewShot(
        metric=template_accuracy,
        max_bootstrapped_demos=max_demos,
    )
    bootstrapped = bootstrap_optimizer.compile(agent, trainset=trainset)
    
    # Then, optimize instructions with MIPRO
    mipro_optimizer = dspy.MIPROv2(
        metric=combined_metric,
        num_threads=4,
        auto="light",  # Light auto mode for faster optimization
    )
    optimized = mipro_optimizer.compile(
        bootstrapped,
        trainset=trainset,
    )
    
    return optimized


def save_results(output_dir: Path, baseline: dict, optimized_score: float, 
                 optimized_metrics: dict, strategy: str, agent):
    """Save optimization results to files."""
    output_dir.mkdir(parents=True, exist_ok=True)
    
    timestamp = datetime.now().isoformat()
    
    # Save metrics comparison
    results = {
        "timestamp": timestamp,
        "strategy": strategy,
        "baseline": baseline,
        "optimized": optimized_metrics,
        "improvement": {
            "combined_score": optimized_metrics.get("avg_combined", 0) - baseline.get("avg_combined", 0),
            "accuracy": optimized_metrics.get("avg_accuracy", 0) - baseline.get("avg_accuracy", 0),
        }
    }
    
    results_file = output_dir / f"results_{strategy}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(results_file, "w") as f:
        json.dump(results, f, indent=2)
    
    print(f"\nResults saved to: {results_file}")
    
    # Save the optimized agent (can be loaded later)
    agent_file = output_dir / f"optimized_agent_{strategy}.json"
    agent.save(str(agent_file))
    print(f"Agent saved to: {agent_file}")
    
    return results


def extract_optimized_prompt(agent) -> str:
    """Extract the optimized prompt from the agent for export."""
    # Get the optimized instructions from the agent's predictors
    instructions = []
    
    for name, predictor in agent.named_predictors():
        if hasattr(predictor, 'signature'):
            sig = predictor.signature
            if hasattr(sig, 'instructions') and sig.instructions:
                instructions.append(f"## {name}\n{sig.instructions}")
    
    return "\n\n".join(instructions)


def evaluate_schema_baseline(agent, testset):
    """Evaluate schema modification agent."""
    print("\n" + "="*60)
    print("SCHEMA MODIFICATION BASELINE EVALUATION")
    print("="*60)
    
    evaluator = Evaluate(
        devset=testset,
        metric=combined_schema_metric,
        num_threads=4,
        display_progress=True,
        display_table=5,
    )
    
    result = evaluator(agent)
    score = float(result.score) if hasattr(result, 'score') else float(result)
    print(f"\nBaseline schema accuracy: {score:.3f}")
    
    return score


def optimize_schema_with_mipro(agent, trainset):
    """Optimize schema modification with MIPRO."""
    print("\n" + "="*60)
    print("SCHEMA MIPRO OPTIMIZATION")
    print("="*60)
    
    optimizer = dspy.MIPROv2(
        metric=combined_schema_metric,
        num_threads=4,
        verbose=True,
        auto="light",
    )
    
    optimized = optimizer.compile(
        agent,
        trainset=trainset,
    )
    
    return optimized


def main():
    parser = argparse.ArgumentParser(description="Optimize Shogo agent with DSPy")
    parser.add_argument("--strategy", choices=["mipro", "bootstrap", "combined"], 
                        default="mipro", help="Optimization strategy")
    parser.add_argument("--num-trials", type=int, default=25,
                        help="Number of optimization trials")
    parser.add_argument("--output", type=str, default="./results",
                        help="Output directory")
    parser.add_argument("--model", type=str, default="claude-sonnet-4-20250514",
                        help="Model to use")
    parser.add_argument("--eval-only", action="store_true",
                        help="Only evaluate, don't optimize")
    parser.add_argument("--use-full-agent", action="store_true",
                        help="Use full agent (slower) vs just selector")
    parser.add_argument("--task", choices=["template", "schema", "all"],
                        default="all", help="What to optimize: template selection, schema modification, or all")
    
    args = parser.parse_args()
    
    # Setup
    print("Setting up DSPy...")
    print(f"Model: {args.model}")
    print(f"Task: {args.task}")
    setup_dspy(args.model)
    
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # ============================================
    # Template Selection Optimization
    # ============================================
    if args.task in ["template", "all"]:
        print("\n" + "="*60)
        print("TEMPLATE SELECTION OPTIMIZATION")
        print("="*60)
        
        # Create datasets
        print("Loading template datasets...")
        trainset = create_trainset()
        testset = create_testset()
        print(f"Training: {len(trainset)} examples, Test: {len(testset)} examples")
        
        # Create agent
        if args.use_full_agent:
            agent = ShogoTemplateAgent()
        else:
            agent = TemplateSelector()
        
        # Baseline evaluation
        baseline_score, baseline_metrics = evaluate_baseline(agent, testset)
        
        if not args.eval_only:
            # Optimize
            if args.strategy == "mipro":
                optimized_agent = optimize_with_mipro(agent, trainset, args.num_trials)
            elif args.strategy == "bootstrap":
                optimized_agent = optimize_with_bootstrap(agent, trainset)
            elif args.strategy == "combined":
                optimized_agent = optimize_combined(agent, trainset, args.num_trials)
            
            # Evaluate optimized agent
            print("\n" + "="*60)
            print("OPTIMIZED TEMPLATE EVALUATION")
            print("="*60)
            
            optimized_score, optimized_metrics = evaluate_baseline(optimized_agent, testset)
            
            # Print comparison
            print("\n" + "="*60)
            print("TEMPLATE COMPARISON")
            print("="*60)
            print(f"Baseline combined:  {baseline_metrics['avg_combined']:.3f}")
            print(f"Optimized combined: {optimized_metrics['avg_combined']:.3f}")
            improvement = optimized_metrics['avg_combined'] - baseline_metrics['avg_combined']
            print(f"Improvement:        {improvement:+.3f} ({improvement/baseline_metrics['avg_combined']*100:+.1f}%)")
            
            # Save results
            save_results(output_dir, baseline_metrics, optimized_score, 
                         optimized_metrics, f"template_{args.strategy}", optimized_agent)
            
            # Extract and print optimized prompt
            optimized_prompt = extract_optimized_prompt(optimized_agent)
            if optimized_prompt:
                print("\n" + "="*60)
                print("OPTIMIZED TEMPLATE PROMPT")
                print("="*60)
                print(optimized_prompt[:500] + "..." if len(optimized_prompt) > 500 else optimized_prompt)
                
                prompt_file = output_dir / "optimized_template_prompt.md"
                with open(prompt_file, "w") as f:
                    f.write(optimized_prompt)
                print(f"\nPrompt saved to: {prompt_file}")
    
    # ============================================
    # Schema Modification Optimization
    # ============================================
    if args.task in ["schema", "all"]:
        print("\n" + "="*60)
        print("SCHEMA MODIFICATION OPTIMIZATION")
        print("="*60)
        
        # Create datasets
        print("Loading schema datasets...")
        schema_train = create_schema_trainset()
        schema_test = create_schema_testset()
        print(f"Training: {len(schema_train)} examples, Test: {len(schema_test)} examples")
        
        # Create agent
        schema_agent = SchemaModifier()
        
        # Baseline evaluation
        schema_baseline = evaluate_schema_baseline(schema_agent, schema_test)
        
        if not args.eval_only:
            # Optimize
            optimized_schema_agent = optimize_schema_with_mipro(schema_agent, schema_train)
            
            # Evaluate optimized
            print("\n" + "="*60)
            print("OPTIMIZED SCHEMA EVALUATION")
            print("="*60)
            optimized_schema_score = evaluate_schema_baseline(optimized_schema_agent, schema_test)
            
            # Print comparison
            print("\n" + "="*60)
            print("SCHEMA COMPARISON")
            print("="*60)
            print(f"Baseline:  {schema_baseline:.3f}")
            print(f"Optimized: {optimized_schema_score:.3f}")
            improvement = optimized_schema_score - schema_baseline
            if schema_baseline > 0:
                print(f"Improvement: {improvement:+.3f} ({improvement/schema_baseline*100:+.1f}%)")
            else:
                print(f"Improvement: {improvement:+.3f} (N/A - baseline was 0)")
            
            # Save schema agent
            schema_agent_file = output_dir / "optimized_schema_agent.json"
            optimized_schema_agent.save(str(schema_agent_file))
            print(f"\nSchema agent saved to: {schema_agent_file}")
            
            # Extract prompt
            schema_prompt = extract_optimized_prompt(optimized_schema_agent)
            if schema_prompt:
                prompt_file = output_dir / "optimized_schema_prompt.md"
                with open(prompt_file, "w") as f:
                    f.write(schema_prompt)
                print(f"Schema prompt saved to: {prompt_file}")
    
    print("\n" + "="*60)
    print("OPTIMIZATION COMPLETE")
    print("="*60)


if __name__ == "__main__":
    main()
