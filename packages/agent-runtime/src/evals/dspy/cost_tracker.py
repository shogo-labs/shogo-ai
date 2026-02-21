"""
Cost tracking for DSPy eval and optimization runs.

Monitors token usage and dollar costs from the DSPy LM history.
Provides per-phase breakdowns (baseline eval, optimization, post-opt eval)
and per-track summaries.

Usage:
    tracker = CostTracker()
    tracker.start_phase("canvas/baseline")
    # ... run eval ...
    tracker.end_phase()
    tracker.print_summary()
"""

from dataclasses import dataclass, field
from datetime import datetime

import dspy


# Per-million-token pricing (USD)
MODEL_PRICING = {
    "claude-haiku-4-5": {"input": 0.80, "output": 4.00},
    "claude-haiku-4-5-20251001": {"input": 0.80, "output": 4.00},
    "claude-sonnet-4-6": {"input": 3.00, "output": 15.00},
    "claude-sonnet-4-6-20260220": {"input": 3.00, "output": 15.00},
    # Cached tokens are 90% cheaper for Anthropic
    "cache_discount": 0.10,
}


@dataclass
class PhaseStats:
    label: str
    model: str = ""
    api_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    cost_reported: float = 0.0
    started_at: str = ""
    ended_at: str = ""
    duration_s: float = 0.0


@dataclass
class CostTracker:
    phases: list[PhaseStats] = field(default_factory=list)
    _current_phase: PhaseStats | None = None
    _history_offset: int = 0
    _start_time: float = 0.0

    def start_phase(self, label: str):
        """Mark the start of a phase (e.g., 'canvas/baseline')."""
        import time
        lm = dspy.settings.lm
        self._history_offset = len(lm.history) if lm else 0
        self._start_time = time.time()
        self._current_phase = PhaseStats(
            label=label,
            model=str(getattr(lm, 'model', 'unknown')) if lm else 'unknown',
            started_at=datetime.now().isoformat(),
        )

    def end_phase(self):
        """Mark the end of the current phase and tally costs."""
        import time
        if not self._current_phase:
            return

        phase = self._current_phase
        phase.ended_at = datetime.now().isoformat()
        phase.duration_s = round(time.time() - self._start_time, 2)

        lm = dspy.settings.lm
        if lm and hasattr(lm, 'history'):
            new_entries = lm.history[self._history_offset:]
            phase.api_calls = len(new_entries)

            for entry in new_entries:
                usage = entry.get('usage', {})
                if isinstance(usage, dict):
                    phase.input_tokens += usage.get('prompt_tokens', 0)
                    phase.output_tokens += usage.get('completion_tokens', 0)
                    phase.cached_tokens += usage.get('cache_read_input_tokens', 0)

                # Also try the response object (litellm ModelResponse)
                if phase.input_tokens == 0:
                    resp = entry.get('response')
                    if resp and hasattr(resp, 'usage') and resp.usage:
                        phase.input_tokens += getattr(resp.usage, 'prompt_tokens', 0)
                        phase.output_tokens += getattr(resp.usage, 'completion_tokens', 0)

                cost = entry.get('cost', 0)
                if cost:
                    phase.cost_reported += cost

        self.phases.append(phase)
        self._current_phase = None

    def _calculate_cost(self, phase: PhaseStats) -> float:
        """Calculate cost from token counts using known pricing."""
        model_key = phase.model.replace("anthropic/", "")
        pricing = MODEL_PRICING.get(model_key)
        if not pricing:
            for key in MODEL_PRICING:
                if key in model_key:
                    pricing = MODEL_PRICING[key]
                    break

        if not pricing:
            return phase.cost_reported

        uncached_input = phase.input_tokens - phase.cached_tokens
        cached_cost = (phase.cached_tokens / 1_000_000) * pricing["input"] * MODEL_PRICING["cache_discount"]
        uncached_cost = (uncached_input / 1_000_000) * pricing["input"]
        output_cost = (phase.output_tokens / 1_000_000) * pricing["output"]

        return cached_cost + uncached_cost + output_cost

    def total_cost(self) -> float:
        return sum(self._calculate_cost(p) for p in self.phases)

    def total_tokens(self) -> int:
        return sum(p.input_tokens + p.output_tokens for p in self.phases)

    def total_api_calls(self) -> int:
        return sum(p.api_calls for p in self.phases)

    def total_duration_s(self) -> float:
        return sum(p.duration_s for p in self.phases)

    def summary_dict(self) -> dict:
        phases = []
        for p in self.phases:
            cost = self._calculate_cost(p)
            phases.append({
                "label": p.label,
                "model": p.model,
                "api_calls": p.api_calls,
                "input_tokens": p.input_tokens,
                "output_tokens": p.output_tokens,
                "cached_tokens": p.cached_tokens,
                "cost_usd": round(cost, 6),
                "duration_s": p.duration_s,
            })

        return {
            "phases": phases,
            "totals": {
                "api_calls": self.total_api_calls(),
                "input_tokens": sum(p.input_tokens for p in self.phases),
                "output_tokens": sum(p.output_tokens for p in self.phases),
                "cached_tokens": sum(p.cached_tokens for p in self.phases),
                "total_tokens": self.total_tokens(),
                "total_cost_usd": round(self.total_cost(), 6),
                "total_duration_s": round(self.total_duration_s(), 2),
            },
        }

    def print_summary(self):
        s = self.summary_dict()
        totals = s["totals"]

        # Use reported cost as fallback when token tracking returns 0
        total_reported = sum(p.cost_reported for p in self.phases)
        use_reported = totals["total_tokens"] == 0 and total_reported > 0

        print(f"\n{'=' * 68}")
        print("COST SUMMARY")
        if use_reported:
            print("  (Token counts from DSPy-reported costs; results may be cached)")
        print(f"{'=' * 68}")
        print(f"  {'Phase':<35} {'Calls':>5}  {'In Tok':>8}  {'Out Tok':>8}  {'Cost':>8}")
        print(f"  {'-' * 35} {'-' * 5}  {'-' * 8}  {'-' * 8}  {'-' * 8}")

        for i, p in enumerate(s["phases"]):
            phase_obj = self.phases[i]
            cost = p["cost_usd"] if not use_reported else round(phase_obj.cost_reported, 6)
            cost_str = f"${cost:.4f}"
            print(f"  {p['label']:<35} {p['api_calls']:>5}  {p['input_tokens']:>8,}  {p['output_tokens']:>8,}  {cost_str:>8}")

        print(f"  {'-' * 35} {'-' * 5}  {'-' * 8}  {'-' * 8}  {'-' * 8}")
        total_cost = totals["total_cost_usd"] if not use_reported else round(total_reported, 6)
        total_cost_str = f"${total_cost:.4f}"
        print(f"  {'TOTAL':<35} {totals['api_calls']:>5}  {totals['input_tokens']:>8,}  {totals['output_tokens']:>8,}  {total_cost_str:>8}")

        if totals["cached_tokens"] > 0:
            cache_pct = (totals["cached_tokens"] / max(totals["input_tokens"], 1)) * 100
            print(f"  Cache hit rate: {cache_pct:.1f}% of input tokens")

        print(f"  Duration: {totals['total_duration_s']:.1f}s")
        print(f"{'=' * 68}\n")

    def print_phase(self, label: str | None = None):
        """Print a one-line cost update for the most recent (or named) phase."""
        phase = None
        if label:
            phase = next((p for p in reversed(self.phases) if p.label == label), None)
        elif self.phases:
            phase = self.phases[-1]

        if not phase:
            return

        cost = self._calculate_cost(phase)
        tokens = phase.input_tokens + phase.output_tokens
        print(f"    Cost: ${cost:.4f} | {phase.api_calls} calls | {tokens:,} tokens | {phase.duration_s:.1f}s")
