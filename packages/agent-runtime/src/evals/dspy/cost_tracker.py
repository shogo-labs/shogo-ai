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
    # Agent-runtime tokens from E2E evaluation (separate from DSPy LM calls)
    agent_calls: int = 0
    agent_input_tokens: int = 0
    agent_output_tokens: int = 0
    agent_cache_read_tokens: int = 0
    agent_cache_write_tokens: int = 0


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

    def add_agent_tokens(
        self,
        input_tokens: int,
        output_tokens: int,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
    ):
        """Accumulate agent-runtime token usage for the current or most recent phase."""
        target = self._current_phase or (self.phases[-1] if self.phases else None)
        if target:
            target.agent_calls += 1
            target.agent_input_tokens += input_tokens
            target.agent_output_tokens += output_tokens
            target.agent_cache_read_tokens += cache_read_tokens
            target.agent_cache_write_tokens += cache_write_tokens

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

    def _calculate_agent_cost(self, phase: PhaseStats) -> float:
        """Calculate agent-runtime cost from E2E eval token counts."""
        total_in = phase.agent_input_tokens + phase.agent_cache_read_tokens + phase.agent_cache_write_tokens
        if total_in == 0 and phase.agent_output_tokens == 0:
            return 0.0
        model_key = phase.model.replace("anthropic/", "")
        pricing = MODEL_PRICING.get(model_key)
        if not pricing:
            for key in MODEL_PRICING:
                if key in model_key:
                    pricing = MODEL_PRICING[key]
                    break
        if not pricing:
            return 0.0
        uncached_cost = (phase.agent_input_tokens / 1_000_000) * pricing["input"]
        cache_read_cost = (phase.agent_cache_read_tokens / 1_000_000) * pricing["input"] * MODEL_PRICING["cache_discount"]
        cache_write_cost = (phase.agent_cache_write_tokens / 1_000_000) * pricing["input"] * 1.25
        output_cost = (phase.agent_output_tokens / 1_000_000) * pricing["output"]
        return uncached_cost + cache_read_cost + cache_write_cost + output_cost

    def total_cost(self) -> float:
        return sum(self._calculate_cost(p) + self._calculate_agent_cost(p) for p in self.phases)

    def total_tokens(self) -> int:
        return sum(
            p.input_tokens + p.output_tokens
            + p.agent_input_tokens + p.agent_output_tokens
            + p.agent_cache_read_tokens + p.agent_cache_write_tokens
            for p in self.phases
        )

    def total_api_calls(self) -> int:
        return sum(p.api_calls for p in self.phases)

    def total_duration_s(self) -> float:
        return sum(p.duration_s for p in self.phases)

    def summary_dict(self) -> dict:
        phases = []
        for p in self.phases:
            dspy_cost = self._calculate_cost(p)
            agent_cost = self._calculate_agent_cost(p)
            phases.append({
                "label": p.label,
                "model": p.model,
                "api_calls": p.api_calls,
                "input_tokens": p.input_tokens,
                "output_tokens": p.output_tokens,
                "cached_tokens": p.cached_tokens,
                "cost_usd": round(dspy_cost + agent_cost, 6),
                "dspy_cost_usd": round(dspy_cost, 6),
                "duration_s": p.duration_s,
                "agent_calls": p.agent_calls,
                "agent_input_tokens": p.agent_input_tokens,
                "agent_output_tokens": p.agent_output_tokens,
                "agent_cache_read_tokens": p.agent_cache_read_tokens,
                "agent_cache_write_tokens": p.agent_cache_write_tokens,
                "agent_cost_usd": round(agent_cost, 6),
            })

        total_agent_in = sum(p.agent_input_tokens for p in self.phases)
        total_agent_out = sum(p.agent_output_tokens for p in self.phases)
        total_agent_calls = sum(p.agent_calls for p in self.phases)
        total_agent_cache_read = sum(p.agent_cache_read_tokens for p in self.phases)
        total_agent_cache_write = sum(p.agent_cache_write_tokens for p in self.phases)

        return {
            "phases": phases,
            "totals": {
                "api_calls": self.total_api_calls(),
                "input_tokens": sum(p.input_tokens for p in self.phases),
                "output_tokens": sum(p.output_tokens for p in self.phases),
                "cached_tokens": sum(p.cached_tokens for p in self.phases),
                "agent_calls": total_agent_calls,
                "agent_input_tokens": total_agent_in,
                "agent_output_tokens": total_agent_out,
                "agent_cache_read_tokens": total_agent_cache_read,
                "agent_cache_write_tokens": total_agent_cache_write,
                "total_tokens": self.total_tokens(),
                "total_cost_usd": round(self.total_cost(), 6),
                "total_duration_s": round(self.total_duration_s(), 2),
            },
        }

    def print_summary(self):
        s = self.summary_dict()
        totals = s["totals"]

        total_reported = sum(p.cost_reported for p in self.phases)
        dspy_tokens = totals["input_tokens"] + totals["output_tokens"]
        use_reported = dspy_tokens == 0 and total_reported > 0
        has_agent = totals["agent_calls"] > 0

        print(f"\n{'=' * 90}")
        print("COST SUMMARY")
        if use_reported:
            print("  (Token counts from DSPy-reported costs; results may be cached)")
        print(f"{'=' * 90}")

        # DSPy LM calls
        print(f"\n  DSPy LM Calls (structural predictions):")
        print(f"  {'Phase':<35} {'Calls':>5}  {'In Tok':>8}  {'Out Tok':>8}  {'Cost':>8}")
        print(f"  {'-' * 35} {'-' * 5}  {'-' * 8}  {'-' * 8}  {'-' * 8}")

        for i, p in enumerate(s["phases"]):
            if p["api_calls"] == 0 and p["agent_calls"] == 0:
                continue
            phase_obj = self.phases[i]
            cost = p["dspy_cost_usd"] if not use_reported else round(phase_obj.cost_reported, 6)
            cost_str = f"${cost:.4f}"
            print(f"  {p['label']:<35} {p['api_calls']:>5}  {p['input_tokens']:>8,}  {p['output_tokens']:>8,}  {cost_str:>8}")

        dspy_cost = sum(self._calculate_cost(p) for p in self.phases)
        print(f"  {'-' * 35} {'-' * 5}  {'-' * 8}  {'-' * 8}  {'-' * 8}")
        print(f"  {'DSPy subtotal':<35} {totals['api_calls']:>5}  {totals['input_tokens']:>8,}  {totals['output_tokens']:>8,}  ${dspy_cost:>7.4f}")

        # Agent-runtime E2E calls
        if has_agent:
            agent_total_cost = sum(self._calculate_agent_cost(p) for p in self.phases)
            print(f"\n  Agent Runtime Calls (E2E evaluation):")
            print(f"  {'Phase':<35} {'Calls':>5}  {'In Tok':>8}  {'Cached':>8}  {'Out Tok':>8}  {'Cost':>8}")
            print(f"  {'-' * 35} {'-' * 5}  {'-' * 8}  {'-' * 8}  {'-' * 8}  {'-' * 8}")

            for p in s["phases"]:
                if p["agent_calls"] == 0:
                    continue
                cost_str = f"${p['agent_cost_usd']:.4f}"
                cached = p["agent_cache_read_tokens"] + p["agent_cache_write_tokens"]
                print(f"  {p['label']:<35} {p['agent_calls']:>5}  {p['agent_input_tokens']:>8,}  {cached:>8,}  {p['agent_output_tokens']:>8,}  {cost_str:>8}")

            total_cached = totals["agent_cache_read_tokens"] + totals["agent_cache_write_tokens"]
            print(f"  {'-' * 35} {'-' * 5}  {'-' * 8}  {'-' * 8}  {'-' * 8}  {'-' * 8}")
            print(f"  {'Agent subtotal':<35} {totals['agent_calls']:>5}  {totals['agent_input_tokens']:>8,}  {total_cached:>8,}  {totals['agent_output_tokens']:>8,}  ${agent_total_cost:>7.4f}")

        if totals["cached_tokens"] > 0:
            cache_pct = (totals["cached_tokens"] / max(totals["input_tokens"], 1)) * 100
            print(f"\n  Cache hit rate: {cache_pct:.1f}% of input tokens")

        print(f"\n  {'GRAND TOTAL':<35} {'':>5}  {'':>8}  {totals['total_tokens']:>8,}  ${totals['total_cost_usd']:>7.4f}")
        print(f"  Duration: {totals['total_duration_s']:.1f}s")
        print(f"{'=' * 90}\n")

    def print_phase(self, label: str | None = None):
        """Print a one-line cost update for the most recent (or named) phase."""
        phase = None
        if label:
            phase = next((p for p in reversed(self.phases) if p.label == label), None)
        elif self.phases:
            phase = self.phases[-1]

        if not phase:
            return

        dspy_cost = self._calculate_cost(phase)
        agent_cost = self._calculate_agent_cost(phase)
        total_cost = dspy_cost + agent_cost
        dspy_tokens = phase.input_tokens + phase.output_tokens
        agent_total_in = phase.agent_input_tokens + phase.agent_cache_read_tokens + phase.agent_cache_write_tokens
        agent_tokens = agent_total_in + phase.agent_output_tokens
        parts = [f"    Cost: ${total_cost:.4f} | {phase.api_calls} calls | {dspy_tokens:,} tokens"]
        if agent_tokens > 0:
            parts.append(f" + {phase.agent_calls} agent calls | {agent_tokens:,} agent tokens")
            if phase.agent_cache_read_tokens > 0:
                parts.append(f" ({phase.agent_cache_read_tokens:,} cached)")
        parts.append(f" | {phase.duration_s:.1f}s")
        print("".join(parts))
