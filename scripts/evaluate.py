"""Run the Receiving Manager agent over a labelled manifest and write an evaluation report.

Usage (from the repo root, backend running):
    ../.venv/Scripts/python.exe scripts/evaluate.py --manifest eval/my_set/manifest.csv --split heldout

For each case: POST /api/inspections {po} -> POST /{id}/images (one request per view) -> POST /{id}/analyze.
Writes <out>/results.jsonl (one raw record per case), <out>/metrics.json and <out>/EVAL_REPORT.md.
Only the standard library and httpx are needed. See eval/README.md for the manifest format.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import httpx

CHECKS = ["sku_check", "carton_check", "units_per_carton_check", "quantity_check",
          "variant_check", "damage_check", "component_check"]
PRED_DECISIONS = ["PASS", "EXCEPTION", "UNCERTAIN", "PENDING_REVIEW", "ERROR"]
TRUTH_DECISIONS = ["PASS", "EXCEPTION"]
MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
# Plain-language gloss for reason codes the backend is known to emit; unknown codes are still reported.
REASON_GLOSS = {
    "NOT_OBSERVED": "value never read with enough confidence in any photo",
    "VIEWS_DISAGREE": "photos gave conflicting readings",
    "READINGS_DISAGREE": "direct and derived counts disagree",
    "LOW_VISIBILITY": "damage could not be assessed confidently (blur/dark/occlusion)",
    "PERCEPTION_UNAVAILABLE": "model call failed or timed out; nothing checked",
    "SKU_MISMATCH": "agent read a different SKU",
    "VARIANT_MISMATCH": "agent read a different variant",
    "COUNT_MISMATCH": "agent counted a different number",
    "DAMAGE_VISIBLE": "agent saw damage",
    "COMPONENT_MISSING": "agent saw a component missing",
    "INVALID_READING": "reading could not be parsed",
    "PO_INCONSISTENT": "PO cartons x units/carton != PO quantity",
    "PO_FIELD_MISSING": "PO lacks the field to check against",
    "MATCH": "agent reported a match",
    "NO_CHECK_TRUTH": "decision wrong, but no truth_<check> columns to attribute it",
    "NO_DAMAGE": "agent saw no damage",
}


# ---------------------------------------------------------------- manifest
def load_manifest(path: Path) -> list[dict]:
    if path.suffix.lower() == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        rows = data["cases"] if isinstance(data, dict) else data
    else:
        with open(path, newline="", encoding="utf-8-sig") as fh:
            rows = list(csv.DictReader(fh))
    cases = []
    for row in rows:
        row = {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in row.items() if k}
        if not row.get("case_id"):
            continue
        cases.append(row)
    return cases


def _as_list(value) -> list[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [v.strip() for v in str(value or "").split(";") if v.strip()]


def build_po(row: dict) -> dict:
    po = {
        "po_id": row["po_id"],
        "sku": row["sku"],
        "product_name": row["product_name"],
        "variant": row["variant"],
        "expected_quantity": int(row["expected_quantity"]),
        "expected_cartons": int(row["expected_cartons"]),
        "units_per_carton": int(row["units_per_carton"]),
        "expected_components": _as_list(row.get("expected_components")),
    }
    for optional in ("unit_id", "asin", "po_line"):
        if row.get(optional):
            po[optional] = row[optional]
    return po


def photos_by_view(row: dict, base: Path) -> dict[str, list[Path]]:
    groups: dict[str, list[Path]] = defaultdict(list)
    for item in _as_list(row.get("photos")):
        view, sep, rel = item.partition(":")
        if not sep or len(view) == 1:  # no view prefix, or a Windows drive letter like C:\...
            view, rel = "other", item
        path = Path(rel)
        groups[view.strip().lower() or "other"].append(path if path.is_absolute() else base / path)
    return groups


def norm_truth(value) -> str | None:
    v = str(value or "").strip().upper()
    if v in {"PASS", "ACCEPT", "OK"}:
        return "PASS"
    if v in {"EXCEPTION", "FAIL", "REJECT"}:
        return "EXCEPTION" if v != "FAIL" else "FAIL"
    if v in {"NOT_REQUIRED", "N/A", "NA"}:
        return "NOT_REQUIRED"
    return None


# ---------------------------------------------------------------- running
class Runner:
    def __init__(self, api: str, api_key: str, timeout: float):
        self.client = httpx.Client(base_url=api.rstrip("/"), headers={"X-API-Key": api_key}, timeout=timeout)

    def health(self) -> dict:
        try:
            r = self.client.get("/api/health")
            return r.json() if r.headers.get("content-type", "").startswith("application/json") else {"status": r.status_code}
        except Exception as exc:  # noqa: BLE001
            return {"error": f"{type(exc).__name__}: {exc}"}

    def _check(self, r: httpx.Response, step: str):
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail")
            except Exception:  # noqa: BLE001
                detail = r.text[:300]
            raise RuntimeError(f"{step} HTTP {r.status_code}: {detail}")
        return r.json()

    def run_case(self, row: dict, base: Path, scenario: str | None) -> dict:
        t0 = time.perf_counter()
        created = self._check(self.client.post("/api/inspections", json={"po": build_po(row)}), "create")
        inspection_id = created["inspection_id"]
        groups = photos_by_view(row, base)
        if not groups:
            raise RuntimeError("case has no photos")
        uploaded = 0
        for view, paths in groups.items():
            files = []
            handles = []
            try:
                for p in paths:
                    if not p.is_file():
                        raise RuntimeError(f"photo not found: {p}")
                    fh = open(p, "rb")
                    handles.append(fh)
                    files.append(("files", (p.name, fh, MIME.get(p.suffix.lower(), "application/octet-stream"))))
                self._check(self.client.post(f"/api/inspections/{inspection_id}/images", files=files,
                                             data={"image_type": view}), f"upload[{view}]")
                uploaded += len(files)
            finally:
                for fh in handles:
                    fh.close()
        t1 = time.perf_counter()
        params = {"scenario": scenario} if scenario else None
        result = self._check(self.client.post(f"/api/inspections/{inspection_id}/analyze", params=params), "analyze")
        t2 = time.perf_counter()
        return {"inspection_id": inspection_id, "images_uploaded": uploaded,
                "latency_s": {"total": round(t2 - t0, 3), "analyze": round(t2 - t1, 3)}, "response": result}


def run_with_retry(runner: Runner, row: dict, base: Path, scenario: str | None, retries: int) -> dict:
    last = None
    for attempt in range(retries + 1):
        try:
            out = runner.run_case(row, base, scenario)
            out["attempts"] = attempt + 1
            return out
        except (httpx.TransportError, RuntimeError) as exc:
            last = exc
            transient = isinstance(exc, httpx.TransportError) or " HTTP 5" in str(exc)
            if not transient or attempt == retries:
                break
            time.sleep(2.0)
    return {"error": f"{type(last).__name__}: {last}", "attempts": attempt + 1}


# ---------------------------------------------------------------- metrics
def pct(n: int, d: int) -> str:
    return "n/a" if d == 0 else f"{100.0 * n / d:.1f}%"


def ratio(n: int, d: int) -> float | None:
    return None if d == 0 else round(n / d, 4)


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 3)


def compute(records: list[dict]) -> dict:
    confusion = {t: Counter() for t in TRUTH_DECISIONS + ["UNLABELLED"]}
    false_accepts, false_rejects, abstained, errors = [], [], [], []
    decided = correct = labelled = 0
    for rec in records:
        truth = rec["truth_decision"] or "UNLABELLED"
        pred = rec["predicted"]
        confusion.setdefault(truth, Counter())[pred] += 1
        if pred == "ERROR":
            errors.append(rec)
            continue
        if truth == "UNLABELLED":
            continue
        labelled += 1
        if pred in ("PASS", "EXCEPTION"):
            decided += 1
            correct += pred == truth
            if truth == "EXCEPTION" and pred == "PASS":
                false_accepts.append(rec)
            if truth == "PASS" and pred == "EXCEPTION":
                false_rejects.append(rec)
        else:
            abstained.append(rec)

    # Per-check: positive class = FAIL (a real problem). Abstain = UNCERTAIN.
    per_check = {}
    for name in CHECKS:
        c = Counter()
        for rec in records:
            truth = rec["truth_checks"].get(name)
            if truth not in ("PASS", "FAIL") or rec["predicted"] == "ERROR":
                continue
            pred = rec["pred_checks"].get(name, {}).get("status", "MISSING")
            c["n"] += 1
            c[f"truth_{truth}"] += 1
            if pred in ("UNCERTAIN", "MISSING"):
                c["abstain"] += 1
            elif pred == "NOT_REQUIRED":
                c["not_required"] += 1
            elif truth == "FAIL" and pred == "FAIL":
                c["tp"] += 1
            elif truth == "PASS" and pred == "FAIL":
                c["fp"] += 1
            elif truth == "FAIL" and pred == "PASS":
                c["fn"] += 1
            else:
                c["tn"] += 1
        if c["n"]:
            d = c["tp"] + c["fp"] + c["fn"] + c["tn"]
            per_check[name] = {
                **dict(c),
                "precision": ratio(c["tp"], c["tp"] + c["fp"]),
                "recall": ratio(c["tp"], c["truth_FAIL"]),
                "recall_decided": ratio(c["tp"], c["tp"] + c["fn"]),
                "accuracy_decided": ratio(c["tp"] + c["tn"], d),
                "abstention": ratio(c["abstain"], c["n"]),
            }

    latencies = [r["latency_s"]["total"] for r in records if r.get("latency_s")]
    analyze_lat = [r["latency_s"]["analyze"] for r in records if r.get("latency_s")]
    ok = len(records) - len(errors)
    return {
        "n_cases": len(records), "n_errors": len(errors), "n_labelled": labelled,
        "confusion": {t: dict(c) for t, c in confusion.items() if c},
        "decided": decided, "correct": correct,
        "accuracy_decided": ratio(correct, decided),
        "coverage": ratio(sum(1 for r in records if r["predicted"] in ("PASS", "EXCEPTION")), ok),
        "false_accepts": [r["case_id"] for r in false_accepts],
        "false_rejects": [r["case_id"] for r in false_rejects],
        "abstained": [r["case_id"] for r in abstained],
        "errors": {r["case_id"]: r.get("error") for r in errors},
        "per_check": per_check,
        "latency_total_s": {"p50": percentile(latencies, 0.5), "p95": percentile(latencies, 0.95),
                            "mean": round(statistics.mean(latencies), 3) if latencies else None},
        "latency_analyze_s": {"p50": percentile(analyze_lat, 0.5), "p95": percentile(analyze_lat, 0.95)},
        "failure_modes": failure_modes(records),
    }


def failure_modes(records: list[dict]) -> list[dict]:
    """Group every wrong, abstained or errored outcome by the reason_code that drove it.

    For each case that is not a correct decision we attribute it to checks:
      - UNCERTAIN / PENDING_REVIEW: every check the agent marked UNCERTAIN (abstention).
      - false reject / wrong FAIL: checks the agent marked FAIL whose truth is PASS (or no truth given).
      - false accept / missed problem: checks whose truth is FAIL but the agent said PASS.
    Per-check misses in otherwise-correct cases are included too (outcome "check-level").
    """
    groups: dict[tuple, dict] = {}

    def add(kind, code, check, case_id):
        g = groups.setdefault((kind, code), {"outcome": kind, "reason_code": code, "checks": Counter(),
                                             "cases": []})
        g["checks"][check] += 1
        if case_id not in g["cases"]:
            g["cases"].append(case_id)

    for rec in records:
        cid, pred, truth = rec["case_id"], rec["predicted"], rec["truth_decision"]
        if pred == "ERROR":
            err = str(rec.get("error") or "")
            code = err.split(":", 1)[0] if ":" in err else "ERROR"
            if " HTTP " in err:
                code = "HTTP_" + err.split(" HTTP ", 1)[1].split(":", 1)[0]
            add("harness/API error", code, "-", cid)
            continue
        decision_wrong = truth in TRUTH_DECISIONS and pred in TRUTH_DECISIONS and pred != truth
        before = sum(len(g["cases"]) for g in groups.values())
        for name, chk in rec["pred_checks"].items():
            status, code = chk.get("status"), chk.get("reason_code") or "UNSPECIFIED"
            tc = rec["truth_checks"].get(name)
            if status == "UNCERTAIN":
                kind = "pending review (perception failed)" if pred == "PENDING_REVIEW" else "abstained (UNCERTAIN)"
                if truth is None or pred in ("UNCERTAIN", "PENDING_REVIEW"):
                    add(kind, code, name, cid)
                elif tc is not None:  # uncertain check hidden behind another check's FAIL
                    add("check-level abstention", code, name, cid)
            elif status == "FAIL" and tc == "PASS":
                add("false reject" if decision_wrong else "check-level false FAIL", code, name, cid)
            elif status == "PASS" and tc == "FAIL":
                add("false accept" if decision_wrong else "check-level missed FAIL", code, name, cid)
            elif status == "FAIL" and tc is None and truth == "PASS" and decision_wrong:
                add("false reject", code, name, cid)
        if decision_wrong and sum(len(g["cases"]) for g in groups.values()) == before:
            # Wrong decision but no per-check truth to attribute it to: label the per-check truth to see why.
            add("false accept" if pred == "PASS" else "false reject", "NO_CHECK_TRUTH", "-", cid)
    order = {"false accept": 0, "false reject": 1, "check-level missed FAIL": 2, "check-level false FAIL": 3,
             "abstained (UNCERTAIN)": 4, "check-level abstention": 5, "pending review (perception failed)": 6,
             "harness/API error": 7}
    out = []
    for g in groups.values():
        out.append({"outcome": g["outcome"], "reason_code": g["reason_code"],
                    "n_cases": len(g["cases"]), "n_checks": sum(g["checks"].values()),
                    "checks": dict(g["checks"]), "example_cases": g["cases"][:5]})
    return sorted(out, key=lambda g: (order.get(g["outcome"], 9), -g["n_cases"], g["reason_code"]))


# ---------------------------------------------------------------- report
def fmt(v, digits=2):
    if v is None:
        return "n/a"
    return f"{v:.{digits}f}" if isinstance(v, float) else str(v)


def render_report(meta: dict, m: dict, records: list[dict]) -> str:
    L = []
    w = L.append
    w(f"# Receiving Manager evaluation report\n")
    if meta.get("banner"):
        w(f"> **{meta['banner']}**\n")
    w("## Run metadata\n")
    w("| Field | Value |\n|---|---|")
    for k in ("date_utc", "manifest", "split", "n_cases", "api", "health", "agent_mode", "model_version",
              "scenario_column", "harness"):
        v = meta.get(k)
        if isinstance(v, (dict, list)):
            v = "`" + json.dumps(v, separators=(",", ":")) + "`"
        w(f"| {k} | {v if v not in (None, '') else '-'} |")
    w("")
    w("## Methodology\n")
    w("Each case is a real shipment's photo set plus the purchase order it should match. Ground truth "
      "(expected decision and, where given, per-check PASS/FAIL) was labelled by a person from the physical "
      "shipment *before* the agent was run. The harness creates one inspection per case, uploads the photos "
      "grouped by capture view, calls `/analyze` once, and compares the returned decision and checks with the "
      "truth. `UNCERTAIN` and `PENDING_REVIEW` are counted as abstentions (routed to a human), not as errors, "
      "and are reported separately; accuracy is measured on decided cases only, alongside coverage.\n")
    if meta.get("banner"):
        w("_This run carries a banner (above): for synthetic or demo-mode runs the truth comes from the "
          "generator, not from a person inspecting a real shipment, so the numbers check the pipeline only._\n")
    w("## Headline numbers\n")
    n_ok = m["n_cases"] - m["n_errors"]
    w("| Metric | Value |\n|---|---|")
    w(f"| Cases run | {m['n_cases']} ({m['n_errors']} harness/API errors) |")
    w(f"| Decided (PASS/EXCEPTION) on labelled cases | {m['decided']} |")
    w(f"| Accuracy on decided cases | {pct(m['correct'], m['decided'])} ({m['correct']}/{m['decided']}) |")
    cov_n = round((m['coverage'] or 0) * n_ok)
    w(f"| Coverage (not UNCERTAIN/PENDING_REVIEW) | {pct(cov_n, n_ok)} ({cov_n}/{n_ok}) |")
    w(f"| False accepts (truth EXCEPTION -> PASS) | **{len(m['false_accepts'])}** |")
    w(f"| False rejects (truth PASS -> EXCEPTION) | {len(m['false_rejects'])} |")
    w(f"| Abstained (UNCERTAIN / PENDING_REVIEW) | {len(m['abstained'])} |")
    lt, la = m["latency_total_s"], m["latency_analyze_s"]
    w(f"| Latency per case, p50 / p95 (create+upload+analyze) | {fmt(lt['p50'])} s / {fmt(lt['p95'])} s |")
    w(f"| Latency of /analyze, p50 / p95 | {fmt(la['p50'])} s / {fmt(la['p95'])} s |")
    w("")

    w("## Decision confusion matrix\n")
    w("Rows: labelled truth. Columns: agent decision.\n")
    w("| truth \\ predicted | " + " | ".join(PRED_DECISIONS) + " | total |")
    w("|---|" + "---:|" * (len(PRED_DECISIONS) + 1))
    for t, row in m["confusion"].items():
        w(f"| **{t}** | " + " | ".join(str(row.get(p, 0)) for p in PRED_DECISIONS) + f" | {sum(row.values())} |")
    w("")

    def case_list(title, ids, explain):
        w(f"### {title} ({len(ids)})\n")
        w(explain + "\n")
        if not ids:
            w("_None._\n")
            return
        w("| case | truth | predicted | non-PASS checks (status: reason_code) | notes |\n|---|---|---|---|---|")
        by_id = {r["case_id"]: r for r in records}
        for cid in ids:
            r = by_id[cid]
            bad = [f"{n}: {c.get('status')} {c.get('reason_code') or ''}".strip()
                   for n, c in r["pred_checks"].items() if c.get("status") not in ("PASS", "NOT_REQUIRED")]
            w(f"| {cid} | {r['truth_decision']} | {r['predicted']} | {'<br>'.join(bad) or '-'} | "
              f"{(r.get('notes') or '').replace('|', '/')[:160]} |")
        w("")

    w("## Errors that matter\n")
    case_list("False accepts", m["false_accepts"],
              "Truth EXCEPTION, agent said PASS. The costly error: a short/wrong/damaged delivery is received as "
              "good and the supplier claim window is lost.")
    case_list("False rejects", m["false_rejects"],
              "Truth PASS, agent said EXCEPTION. Costs re-inspection time and a wrongly raised supplier claim.")
    case_list("UNCERTAIN / PENDING_REVIEW", m["abstained"],
              "Agent abstained and routed the shipment to a human. Safe, but it erodes coverage.")
    if m["errors"]:
        w(f"### Harness / API errors ({len(m['errors'])})\n")
        w("| case | error |\n|---|---|")
        for cid, err in m["errors"].items():
            w(f"| {cid} | {str(err).replace('|', '/')[:240]} |")
        w("")

    w("## Per-check results\n")
    if not m["per_check"]:
        w("_No per-check truth columns (`truth_<check>`) in the manifest; per-check metrics skipped._\n")
    else:
        w("Positive class = FAIL (a real problem with the shipment). Precision/recall use decided checks; "
          "`recall` counts an abstention on a true FAIL as a miss, `recall (decided)` does not. "
          "FN = truth FAIL, agent PASS (silent miss).\n")
        w("| check | n | truth FAIL | TP | FP | FN | TN | abstain | precision | recall | recall (decided) "
          "| accuracy (decided) | abstention |")
        w("|---|" + "---:|" * 12)
        for name, c in m["per_check"].items():
            w(f"| {name} | {c['n']} | {c.get('truth_FAIL', 0)} | {c.get('tp', 0)} | {c.get('fp', 0)} | "
              f"{c.get('fn', 0)} | {c.get('tn', 0)} | {c.get('abstain', 0)} | {fmt(c['precision'])} | "
              f"{fmt(c['recall'])} | {fmt(c['recall_decided'])} | {fmt(c['accuracy_decided'])} | "
              f"{fmt(c['abstention'])} |")
        w("")

    w("## Failure modes\n")
    w("Every wrong, abstained or errored outcome, grouped by the backend `reason_code` that produced it "
      "(one case can appear under several modes).\n")
    if not m["failure_modes"]:
        w("_No failures recorded._\n")
    else:
        w("| outcome | reason_code | meaning | cases | checks affected | example cases |\n|---|---|---|---:|---|---|")
        for g in m["failure_modes"]:
            checks = ", ".join(f"{k} x{v}" if v > 1 else k for k, v in g["checks"].items())
            w(f"| {g['outcome']} | `{g['reason_code']}` | {REASON_GLOSS.get(g['reason_code'], '-')} | "
              f"{g['n_cases']} | {checks} | {', '.join(g['example_cases'])} |")
        w("")
    w("## Reading this report\n")
    w("- **False accepts** are the number to drive to zero; a false reject or an abstention only costs "
      "operator time.\n"
      "- Accuracy without coverage is meaningless: an agent that abstains on everything has 100% accuracy on "
      "0 decided cases.\n"
      "- With fewer than ~50 held-out shipments every percentage has a wide confidence interval; quote the "
      "counts.\n"
      "- Raw responses for every case are in `results.jsonl` next to this file.\n")
    return "\n".join(L)


def _find_key(obj, key):
    """Every value stored under `key` anywhere in a nested dict/list (the record nests model_version per check)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key and isinstance(v, (str, int, float)):
                yield v
            else:
                yield from _find_key(v, key)
    elif isinstance(obj, list):
        for v in obj:
            yield from _find_key(v, key)


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description="Evaluate the Receiving Manager agent on a labelled manifest.")
    ap.add_argument("--manifest", required=True, help="CSV or JSON manifest (see eval/README.md)")
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--api-key", default=os.getenv("RECEIVING_EVAL_API_KEY"),
                    help="X-API-Key value (default: env RECEIVING_EVAL_API_KEY)")
    ap.add_argument("--split", default="heldout", help="split to run: dev | heldout | all (default heldout)")
    ap.add_argument("--out", default=None, help="output dir (default eval/results/<UTC timestamp>/)")
    ap.add_argument("--scenario-column", default=None,
                    help="manifest column passed as ?scenario= to /analyze (DEMO_MODE backends only)")
    ap.add_argument("--timeout", type=float, default=180.0, help="per-request timeout in seconds")
    ap.add_argument("--retries", type=int, default=1, help="retries per case on 5xx/connection errors")
    ap.add_argument("--limit", type=int, default=None, help="run only the first N cases")
    ap.add_argument("--banner", default=None, help="optional line shown at the top of the report")
    args = ap.parse_args()

    if not args.api_key:
        ap.error("no API key: pass --api-key or set RECEIVING_EVAL_API_KEY")
    manifest = Path(args.manifest).resolve()
    cases = load_manifest(manifest)
    if args.split != "all":
        cases = [c for c in cases if (c.get("split") or "").lower() == args.split.lower()]
    if args.limit:
        cases = cases[: args.limit]
    if not cases:
        print(f"no cases for split={args.split} in {manifest}", file=sys.stderr)
        return 2

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = Path(args.out) if args.out else Path("eval/results") / stamp
    out.mkdir(parents=True, exist_ok=True)

    runner = Runner(args.api, args.api_key, args.timeout)
    health = runner.health()
    records = []
    modes, models = Counter(), Counter()
    with open(out / "results.jsonl", "w", encoding="utf-8") as jl:
        for i, row in enumerate(cases, 1):
            scenario = row.get(args.scenario_column) if args.scenario_column else None
            res = run_with_retry(runner, row, manifest.parent, scenario or None, args.retries)
            resp = res.get("response") or {}
            pred = resp.get("decision") if "error" not in res else "ERROR"
            if pred not in PRED_DECISIONS:
                pred = "ERROR" if pred is None else pred
            pred_checks = {c.get("check_name"): c for c in resp.get("checks") or [] if isinstance(c, dict)}
            truth_checks = {}
            for name in CHECKS:
                t = norm_truth(row.get(f"truth_{name}"))
                if t == "EXCEPTION":
                    t = "FAIL"
                if t in ("PASS", "FAIL", "NOT_REQUIRED"):
                    truth_checks[name] = t
            truth = norm_truth(row.get("expected_decision"))
            truth = "EXCEPTION" if truth == "FAIL" else truth
            truth = truth if truth in TRUTH_DECISIONS else None
            record = {
                "case_id": row["case_id"], "split": row.get("split"), "scenario": scenario,
                "truth_decision": truth, "truth_checks": truth_checks, "predicted": pred,
                "pred_checks": pred_checks, "notes": row.get("notes"),
                "inspection_id": res.get("inspection_id"), "latency_s": res.get("latency_s"),
                "attempts": res.get("attempts"), "error": res.get("error"), "response": resp or None,
            }
            if resp:
                modes[resp.get("analysis_status") or ("demo" if resp.get("demo_mode") else "unknown")] += 1
                for mv in set(_find_key(resp.get("record"), "model_version")) - {"rules"}:
                    models[str(mv)] += 1
            records.append(record)
            jl.write(json.dumps(record, default=str) + "\n")
            jl.flush()
            lat = (res.get("latency_s") or {}).get("total")
            print(f"[{i}/{len(cases)}] {row['case_id']}: truth={truth} predicted={pred}"
                  + (f" ({lat:.2f}s)" if lat is not None else "") + (f" ERROR {res['error']}" if res.get("error") else ""))

    metrics = compute(records)
    meta = {
        "date_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "manifest": str(args.manifest), "split": args.split, "n_cases": len(records), "api": args.api,
        "health": health, "agent_mode": dict(modes) or None, "model_version": dict(models) or None,
        "scenario_column": args.scenario_column,
        "harness": f"scripts/evaluate.py, Python {platform.python_version()}, httpx {httpx.__version__}",
        "banner": args.banner,
    }
    (out / "metrics.json").write_text(json.dumps({"meta": meta, "metrics": metrics}, indent=2, default=str),
                                      encoding="utf-8")
    (out / "EVAL_REPORT.md").write_text(render_report(meta, metrics, records), encoding="utf-8")
    print(f"\naccuracy(decided)={metrics['accuracy_decided']} coverage={metrics['coverage']} "
          f"false_accepts={len(metrics['false_accepts'])} false_rejects={len(metrics['false_rejects'])} "
          f"errors={metrics['n_errors']}\nreport: {out / 'EVAL_REPORT.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
