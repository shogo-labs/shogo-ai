"""
Optimization runner for all 5 DSPy tracks with sub-track routing.

Each track may have multiple sub-tracks (e.g., skill has 'match' and 'create'),
each with its own DSPy signature and quality metric. Examples are routed to the
correct sub-program automatically.

Usage:
    # Baseline eval with haiku (default)
    python optimize.py --track canvas --eval-only

    # Eval all tracks
    python optimize.py --track all --eval-only

    # Optimize with sonnet
    python optimize.py --track canvas --model sonnet --strategy combined

    # Different models for eval vs optimization
    python optimize.py --track all --eval-model haiku --optimize-model sonnet
"""

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import dspy

from meta_metrics import universal_score, combined_track_score, MetaMetricsTracker
from cost_tracker import CostTracker


# ---------------------------------------------------------------------------
# Sub-track definition
# ---------------------------------------------------------------------------

@dataclass
class SubTrack:
    label: str
    signature_cls: type
    quality_fn: Callable
    train: list = field(default_factory=list)
    test: list = field(default_factory=list)


# ---------------------------------------------------------------------------
# Track registry — returns list of SubTrack per track
# ---------------------------------------------------------------------------

TRACKS = ["canvas", "memory", "personality", "skill", "multiturn"]


def load_track(track_name: str) -> list[SubTrack]:
    """Load a track's sub-tracks with datasets, signatures, and quality metrics."""

    if track_name == "canvas":
        from canvas_dataset import get_canvas_dataset
        from canvas_metrics import canvas_quality
        from canvas_signatures import CanvasPlanning, CanvasE2E
        from e2e_metrics import canvas_e2e_quality

        data = get_canvas_dataset()
        subtracks = []
        if "planning" in data:
            train, test = data["planning"]
            subtracks.append(SubTrack("planning", CanvasPlanning, canvas_quality, train, test))
        if "e2e" in data:
            train, test = data["e2e"]
            subtracks.append(SubTrack("e2e", CanvasE2E, canvas_e2e_quality, train, test))
        return subtracks

    elif track_name == "memory":
        from memory_dataset import get_memory_dataset
        from memory_metrics import memory_write_quality, memory_retrieval_quality
        from memory_signatures import MemoryWriteDecision, MemoryRetrieval
        from e2e_metrics import memory_write_e2e_quality

        data = get_memory_dataset()
        subtracks = []
        if "write" in data:
            train, test = data["write"]
            subtracks.append(SubTrack("write", MemoryWriteDecision, memory_write_quality, train, test))
            subtracks.append(SubTrack("write_e2e", MemoryWriteDecision, memory_write_e2e_quality, train, test))
        if "retrieval" in data:
            train, test = data["retrieval"]
            subtracks.append(SubTrack("retrieval", MemoryRetrieval, memory_retrieval_quality, train, test))
        return subtracks

    elif track_name == "personality":
        from personality_dataset import get_personality_dataset
        from personality_metrics import personality_selection_quality, personality_self_update_quality
        from personality_signatures import AgentTemplateSelection, PersonalitySelfUpdate
        from e2e_metrics import personality_update_e2e_quality

        data = get_personality_dataset()
        subtracks = []
        if "selection" in data:
            train, test = data["selection"]
            subtracks.append(SubTrack("selection", AgentTemplateSelection, personality_selection_quality, train, test))
        if "self_update" in data:
            train, test = data["self_update"]
            subtracks.append(SubTrack("self_update", PersonalitySelfUpdate, personality_self_update_quality, train, test))
            subtracks.append(SubTrack("self_update_e2e", PersonalitySelfUpdate, personality_update_e2e_quality, train, test))
        return subtracks

    elif track_name == "skill":
        from skill_dataset import get_skill_dataset
        from skill_metrics import skill_match_quality, skill_create_quality
        from skill_signatures import SkillMatcher, SkillCreation
        from e2e_metrics import skill_create_e2e_quality

        data = get_skill_dataset()
        subtracks = []
        if "match" in data:
            train, test = data["match"]
            subtracks.append(SubTrack("match", SkillMatcher, skill_match_quality, train, test))
        if "create" in data:
            train, test = data["create"]
            subtracks.append(SubTrack("create", SkillCreation, skill_create_quality, train, test))
            subtracks.append(SubTrack("create_e2e", SkillCreation, skill_create_e2e_quality, train, test))
        return subtracks

    elif track_name == "multiturn":
        from multiturn_dataset import get_multiturn_dataset
        from multiturn_metrics import multiturn_plan_quality, multiturn_summary_quality
        from multiturn_signatures import ConversationPlanner, SessionSummarizer
        from e2e_metrics import multiturn_plan_e2e_quality

        data = get_multiturn_dataset()
        subtracks = []
        if "plan" in data:
            train, test = data["plan"]
            subtracks.append(SubTrack("plan", ConversationPlanner, multiturn_plan_quality, train, test))
            subtracks.append(SubTrack("plan_e2e", ConversationPlanner, multiturn_plan_e2e_quality, train, test))
        if "summarize" in data:
            train, test = data["summarize"]
            subtracks.append(SubTrack("summarize", SessionSummarizer, multiturn_summary_quality, train, test))
        return subtracks

    else:
        raise ValueError(f"Unknown track: {track_name}")


# ---------------------------------------------------------------------------
# Combined metric factory
# ---------------------------------------------------------------------------

def make_combined_metric(track_quality_fn):
    """Create a combined metric: universal (60%) + track quality (40%)."""
    def metric(example, prediction, trace=None):
        return combined_track_score(example, prediction, track_quality_fn, trace)
    return metric


# ---------------------------------------------------------------------------
# Optimization strategies
# ---------------------------------------------------------------------------

def run_mipro(program, trainset, metric, num_trials=25):
    optimizer = dspy.MIPROv2(
        metric=metric,
        num_candidates=num_trials,
        init_temperature=1.0,
    )
    return optimizer.compile(program, trainset=trainset, num_trials=num_trials)


def run_bootstrap(program, trainset, metric, num_trials=25):
    optimizer = dspy.BootstrapFewShot(
        metric=metric,
        max_bootstrapped_demos=4,
        max_labeled_demos=8,
    )
    return optimizer.compile(program, trainset=trainset)


def run_combined(program, trainset, metric, num_trials=25):
    bootstrapped = run_bootstrap(program, trainset, metric, num_trials)
    return run_mipro(bootstrapped, trainset, metric, num_trials)


STRATEGIES = {
    "mipro": run_mipro,
    "bootstrap": run_bootstrap,
    "combined": run_combined,
}


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def evaluate_subtracks(track_name: str, subtracks: list[SubTrack], programs: dict[str, object] | None = None):
    """Evaluate all sub-tracks, creating baseline programs if none provided."""
    tracker = MetaMetricsTracker()

    for st in subtracks:
        if not st.test:
            print(f"    [{st.label}] no test examples, skipping")
            continue

        program = (programs or {}).get(st.label) or dspy.ChainOfThought(st.signature_cls)
        print(f"    [{st.label}] evaluating {len(st.test)} examples ({st.signature_cls.__name__})...")

        for example in st.test:
            try:
                prediction = program(**example.inputs())
                tracker.add(example, prediction, st.quality_fn)
            except Exception as e:
                print(f"      Error: {e}")
                bad = dspy.Prediction()
                tracker.add(example, bad, st.quality_fn)

    print(f"\n--- {track_name.upper()} Track Results ---")
    tracker.print_summary()
    return tracker.summary()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

MODEL_ALIASES = {
    "haiku": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-4-6",
}


def resolve_model(name: str) -> str:
    return MODEL_ALIASES.get(name, name)


_cache_enabled = True

def configure_lm(model: str, max_tokens: int = 4096):
    resolved = resolve_model(model)
    lm = dspy.LM(f"anthropic/{resolved}", max_tokens=max_tokens, cache=_cache_enabled)
    dspy.configure(lm=lm)
    return resolved


def main():
    parser = argparse.ArgumentParser(
        description="DSPy optimizer for agent-runtime",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--track", required=True, choices=TRACKS + ["all"],
                        help="Which track to optimize")
    parser.add_argument("--strategy", default="combined", choices=list(STRATEGIES.keys()),
                        help="Optimization strategy")
    parser.add_argument("--num-trials", type=int, default=25,
                        help="Number of optimization trials (for MIPRO)")

    model_group = parser.add_argument_group("model selection")
    model_group.add_argument("--model", default=None,
                             help="LLM model for both eval and optimization. "
                                  "Accepts aliases: haiku, sonnet. Default: haiku")
    model_group.add_argument("--eval-model", default=None,
                             help="LLM model for evaluation (overrides --model)")
    model_group.add_argument("--optimize-model", default=None,
                             help="LLM model for optimization (overrides --model)")

    parser.add_argument("--eval-only", action="store_true",
                        help="Only run baseline evaluation, skip optimization")
    parser.add_argument("--no-cache", action="store_true",
                        help="Disable DSPy/litellm response caching (forces fresh API calls)")
    parser.add_argument("--output-dir", default="results",
                        help="Directory to save results")
    args = parser.parse_args()

    global _cache_enabled
    if args.no_cache:
        _cache_enabled = False

    base_model = args.model or "haiku"
    eval_model = args.eval_model or base_model
    optimize_model = args.optimize_model or base_model

    tracks_to_run = TRACKS if args.track == "all" else [args.track]
    all_results = {}
    costs = CostTracker()

    results_dir = Path(args.output_dir)
    results_dir.mkdir(parents=True, exist_ok=True)

    print(f"  Eval model:     {resolve_model(eval_model)}")
    if not args.eval_only:
        print(f"  Optimize model: {resolve_model(optimize_model)}")

    for track_name in tracks_to_run:
        print(f"\n{'=' * 60}")
        if args.eval_only:
            print(f"EVALUATING: {track_name.upper()}")
        else:
            print(f"OPTIMIZING: {track_name.upper()}")
        print(f"{'=' * 60}")

        subtracks = load_track(track_name)

        total_train = sum(len(st.train) for st in subtracks)
        total_test = sum(len(st.test) for st in subtracks)
        sub_labels = ", ".join(f"{st.label}({len(st.train)}/{len(st.test)})" for st in subtracks)
        print(f"  Sub-tracks: {sub_labels}")
        print(f"  Total: {total_train} train, {total_test} test")

        # --- Baseline evaluation ---
        resolved_eval = configure_lm(eval_model)
        costs.start_phase(f"{track_name}/baseline")
        print(f"\n  Baseline evaluation (model: {resolved_eval})...")
        baseline = evaluate_subtracks(track_name, subtracks)
        costs.end_phase()
        costs.print_phase()

        if args.eval_only:
            all_results[track_name] = {"baseline": baseline}
            continue

        # --- Optimization (per sub-track) ---
        resolved_opt = configure_lm(optimize_model)
        optimized_programs = {}

        for st in subtracks:
            if not st.train:
                continue
            program = dspy.ChainOfThought(st.signature_cls)
            metric = make_combined_metric(st.quality_fn)
            strategy_fn = STRATEGIES[args.strategy]
            costs.start_phase(f"{track_name}/optimize/{st.label}")
            print(f"\n  Optimizing [{st.label}] with {args.strategy} (model: {resolved_opt})...")
            optimized_programs[st.label] = strategy_fn(program, st.train, metric, args.num_trials)
            costs.end_phase()
            costs.print_phase()

        # --- Post-optimization evaluation ---
        configure_lm(eval_model)
        costs.start_phase(f"{track_name}/optimized_eval")
        print(f"\n  Optimized evaluation (model: {resolved_eval})...")
        optimized_results = evaluate_subtracks(track_name, subtracks, optimized_programs)
        costs.end_phase()
        costs.print_phase()

        # Save optimized programs
        for label, prog in optimized_programs.items():
            program_path = results_dir / f"{track_name}_{label}_optimized.json"
            prog.save(str(program_path))
            print(f"  Saved {label} -> {program_path}")

        all_results[track_name] = {
            "eval_model": resolved_eval,
            "optimize_model": resolved_opt,
            "baseline": baseline,
            "optimized": optimized_results,
            "improvement": {
                k: optimized_results.get(k, 0) - baseline.get(k, 0)
                for k in baseline if isinstance(baseline[k], (int, float))
            },
        }

    # Save summary with costs
    cost_summary = costs.summary_dict()
    summary_data = {"results": all_results, "costs": cost_summary}
    summary_path = results_dir / "optimization_summary.json"
    with open(summary_path, "w") as f:
        json.dump(summary_data, f, indent=2)

    print(f"\n{'=' * 60}")
    print("COMPLETE")
    print(f"{'=' * 60}")
    print(f"Results saved to {results_dir}/")

    for track, data in all_results.items():
        if "optimized" in data:
            improvement = data.get("improvement", {})
            final_delta = improvement.get("avg_final", 0)
            print(f"  {track}: final score {'+'if final_delta >= 0 else ''}{final_delta:.3f}")
        else:
            baseline = data.get("baseline", {})
            print(f"  {track}: baseline universal={baseline.get('avg_universal', 0):.3f}")

    costs.print_summary()


if __name__ == "__main__":
    main()
