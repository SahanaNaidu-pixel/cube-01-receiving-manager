"""Dashboard aggregates. Counts derive from the latest sealed record per inspection."""

from __future__ import annotations

from collections import Counter
from datetime import date, datetime, timedelta, timezone

from backend.app.api.deps import day_of, parse_day
from backend.app.core.errors import AppError
from backend.app.services import a2a as a2a_service
from backend.app.services import inspection_service as svc
from backend.app.services.health import readiness

MAX_DAILY_POINTS = 366
QUANTITY_KEYS = {"carton_count", "units_per_carton", "total_quantity"}


def resolve_range(range_: str, date_from: str | None, date_to: str | None, earliest: str | None) -> tuple[str, str]:
    today = datetime.now(timezone.utc).date()
    if range_ == "today":
        return today.isoformat(), today.isoformat()
    if range_ == "7d":
        return (today - timedelta(days=6)).isoformat(), today.isoformat()
    if range_ == "30d":
        return (today - timedelta(days=29)).isoformat(), today.isoformat()
    if range_ == "all":
        start = min(earliest or today.isoformat(), today.isoformat())
        return start, today.isoformat()
    if range_ == "custom":
        start, end = parse_day(date_from, "date_from"), parse_day(date_to, "date_to")
        if not start or not end:
            raise AppError(422, "range=custom needs date_from and date_to (YYYY-MM-DD).", "VALIDATION_ERROR")
        if start > end:
            raise AppError(422, "date_from must be on or before date_to", "VALIDATION_ERROR")
        return start, end
    raise AppError(422, "range must be today, 7d, 30d, all or custom", "VALIDATION_ERROR")


def _failed(record: dict | None, keys: set[str]) -> bool:
    return any(c["check_key"] in keys and c["verdict"] == "FAIL" for c in (record or {}).get("checks", []))


def build(principal: dict, range_: str, date_from: str | None, date_to: str | None) -> dict:
    org = principal["organization_id"]
    inspections = svc.repository.list(org)
    earliest = min((day_of(i.created_at) for i in inspections), default=None)
    start, end = resolve_range(range_, date_from, date_to, earliest)
    selected = [i for i in inspections if start <= day_of(i.created_at) <= end]
    ctx = svc.OrgContext(org)
    selected_ids = {i.inspection_id for i in selected}

    totals = {k: 0 for k in ("inspections", "not_analyzed", "pass", "fail", "uncertain", "open_issues", "open_reviews",
                             "quantity_discrepancies", "product_mismatches", "variant_mismatches", "damaged_cartons",
                             "damaged_products", "missing_components")}
    days: dict[str, dict] = {}
    start_day, end_day = date.fromisoformat(start), date.fromisoformat(end)
    first_day = max(start_day, end_day - timedelta(days=MAX_DAILY_POINTS - 1))
    cursor = first_day
    while cursor <= end_day:
        days[cursor.isoformat()] = {"date": cursor.isoformat(), "pass": 0, "fail": 0, "uncertain": 0, "not_analyzed": 0}
        cursor += timedelta(days=1)

    for inspection in selected:
        verdict = svc.verdict_of(inspection)
        bucket = {"PASS": "pass", "FAIL": "fail", "UNCERTAIN": "uncertain"}.get(verdict, "not_analyzed")
        totals["inspections"] += 1
        totals[bucket] += 1
        day = days.get(day_of(inspection.created_at))
        if day:
            day[bucket] += 1
        record = inspection.record
        totals["quantity_discrepancies"] += _failed(record, QUANTITY_KEYS)
        totals["product_mismatches"] += _failed(record, {"identity"})
        totals["variant_mismatches"] += _failed(record, {"variant"})
        totals["damaged_cartons"] += _failed(record, {"carton_damage", "carton_condition"})
        totals["damaged_products"] += _failed(record, {"unit_damage"})
        totals["missing_components"] += _failed(record, {"components"})

    issue_types: Counter = Counter()
    for inspection_id, issues in ctx.issues.items():
        if inspection_id not in selected_ids:
            continue
        for issue in issues:
            if issue["status"] in ("open", "in_review"):
                totals["open_issues"] += 1
            if issue["status"] != "superseded":
                issue_types[issue["issue_type"]] += 1
    for inspection_id, tasks in ctx.reviews.items():
        if inspection_id in selected_ids:
            totals["open_reviews"] += sum(1 for t in tasks if t["status"] in ("open", "evidence_requested"))

    recent = sorted(selected, key=lambda i: i.created_at, reverse=True)[:8]
    activity = [a for a in a2a_service.list_activity(org) if start <= (day_of(a["created_at"]) or "") <= end]
    activity.sort(key=lambda a: a["created_at"], reverse=True)
    return {
        "range": {"from": start, "to": end},
        "totals": totals,
        "daily": list(days.values()),
        "issues_by_type": [{"issue_type": t, "count": n} for t, n in issue_types.most_common()],
        "recent_inspections": [svc.inspection_summary(i, ctx) for i in recent],
        "recent_agent_activity": [{k: v for k, v in a.items() if k not in ("request", "response")} for a in activity[:8]],
        "system": readiness(),
    }
