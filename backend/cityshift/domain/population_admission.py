"""Read-only admission previews; the gateway remains the final atomic authority."""
from cityshift.agents.population_gateway import RunLimits, RunScope, _normalize_request
from cityshift.contracts import PopulationDefinition


def admission_quotes(model_ids: list[str], output_tokens: int) -> dict[str, int]:
    scope = RunScope("admission", "unused", tuple(model_ids), frozenset(), RunLimits(max_output_tokens=output_tokens))
    return {model_id: _normalize_request(scope, {
        "model": model_id, "messages": [{"role": "user", "content": "Admission quote"}],
        "max_tokens": output_tokens,
    })[1].ceiling_microdollars for model_id in model_ids}


def admitted_residents(population: PopulationDefinition, oldest_due: list[str], usage: dict) -> list[str]:
    """Longest oldest-first batch whose concurrent request reservations fit."""
    budget = population.spec.budget
    totals = usage["run_totals"]
    if usage.get("blocked") or totals["reported_tokens"] >= budget.max_tokens:
        return []
    limit = min(budget.max_concurrency, max(0, budget.max_calls - totals["calls"]))
    candidates = oldest_due[:limit]
    remaining = min(usage["remaining_microdollars"],
                    int(budget.max_cost_usd * 1_000_000) - totals["accounted_microdollars"])
    models = sorted({population.assignments[rid].model_id for rid in candidates})
    quotes = admission_quotes(models, budget.max_output_tokens)
    admitted = []
    for rid in candidates:
        quote = quotes[population.assignments[rid].model_id]
        if quote > remaining:
            break
        admitted.append(rid)
        remaining -= quote
    return admitted


def boundary_budget_reason(population: PopulationDefinition, resident_ids: list[str], usage: dict) -> str | None:
    if not resident_ids:
        return None
    budget = population.spec.budget
    totals = usage["run_totals"]
    if usage.get("blocked"):
        return "Inference accounting is blocked; execution paused before requesting another decision."
    if totals["calls"] >= budget.max_calls or totals["reported_tokens"] >= budget.max_tokens:
        return "The run's model call or token ceiling is exhausted; execution paused before another decision."
    remaining = min(usage["remaining_microdollars"],
                    int(budget.max_cost_usd * 1_000_000) - totals["accounted_microdollars"])
    models = sorted({population.assignments[rid].model_id for rid in resident_ids})
    for model_id, quote in admission_quotes(models, budget.max_output_tokens).items():
        if quote > remaining:
            return (f"Execution paused: {model_id} needs a ${quote / 1_000_000:.4f} request reservation; "
                    f"${max(0, remaining) / 1_000_000:.4f} remains within the run/inference budget. "
                    "No replacement rule decisions were generated.")
    return None
