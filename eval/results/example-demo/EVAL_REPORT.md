# Receiving Manager evaluation report

> **DEMO-MODE PIPELINE CHECK on SYNTHETIC images. Decisions come from the backend's canned demo scenarios (selected per case via the scenario column), not from a vision model. These numbers prove the harness and decision plumbing work; they are NOT accuracy evidence.**

## Run metadata

| Field | Value |
|---|---|
| date_utc | 2026-10-07T08:27:43+00:00 |
| manifest | eval/synthetic/manifest.csv |
| split | heldout |
| n_cases | 7 |
| api | http://127.0.0.1:8810 |
| health | `{"status":"ok","service":"receiving-manager"}` |
| agent_mode | `{"demo":7}` |
| model_version | `{"demo":7}` |
| scenario_column | scenario |
| harness | scripts/evaluate.py, Python 3.14.8, httpx 0.28.1 |

## Methodology

Each case is a real shipment's photo set plus the purchase order it should match. Ground truth (expected decision and, where given, per-check PASS/FAIL) was labelled by a person from the physical shipment *before* the agent was run. The harness creates one inspection per case, uploads the photos grouped by capture view, calls `/analyze` once, and compares the returned decision and checks with the truth. `UNCERTAIN` and `PENDING_REVIEW` are counted as abstentions (routed to a human), not as errors, and are reported separately; accuracy is measured on decided cases only, alongside coverage.

_This run carries a banner (above): for synthetic or demo-mode runs the truth comes from the generator, not from a person inspecting a real shipment, so the numbers check the pipeline only._

## Headline numbers

| Metric | Value |
|---|---|
| Cases run | 7 (0 harness/API errors) |
| Decided (PASS/EXCEPTION) on labelled cases | 4 |
| Accuracy on decided cases | 100.0% (4/4) |
| Coverage (not UNCERTAIN/PENDING_REVIEW) | 57.1% (4/7) |
| False accepts (truth EXCEPTION -> PASS) | **0** |
| False rejects (truth PASS -> EXCEPTION) | 0 |
| Abstained (UNCERTAIN / PENDING_REVIEW) | 3 |
| Latency per case, p50 / p95 (create+upload+analyze) | 0.07 s / 0.08 s |
| Latency of /analyze, p50 / p95 | 0.01 s / 0.02 s |

## Decision confusion matrix

Rows: labelled truth. Columns: agent decision.

| truth \ predicted | PASS | EXCEPTION | UNCERTAIN | PENDING_REVIEW | ERROR | total |
|---|---:|---:|---:|---:|---:|---:|
| **PASS** | 1 | 0 | 2 | 0 | 0 | 3 |
| **EXCEPTION** | 0 | 3 | 1 | 0 | 0 | 4 |

## Errors that matter

### False accepts (0)

Truth EXCEPTION, agent said PASS. The costly error: a short/wrong/damaged delivery is received as good and the supplier claim window is lost.

_None._

### False rejects (0)

Truth PASS, agent said EXCEPTION. Costs re-inspection time and a wrongly raised supplier claim.

_None._

### UNCERTAIN / PENDING_REVIEW (3)

Agent abstained and routed the shipment to a human. Safe, but it erodes coverage.

| case | truth | predicted | non-PASS checks (status: reason_code) | notes |
|---|---|---|---|---|
| syn-heldout-wrong_sku | EXCEPTION | UNCERTAIN | sku_check: UNCERTAIN NOT_OBSERVED | SYNTHETIC. Demo mode has no wrong-SKU scenario; barcode_glare (SKU unreadable) is the closest. |
| syn-heldout-blurred | PASS | UNCERTAIN | sku_check: UNCERTAIN NOT_OBSERVED<br>carton_check: UNCERTAIN NOT_OBSERVED<br>units_per_carton_check: UNCERTAIN NOT_OBSERVED<br>quantity_check: UNCERTAIN NOT_OBSERVED<br>variant_check: UNCERTAIN NOT_OBSERVED<br>damage_check: UNCERTAIN LOW_VISIBILITY<br>component_check: UNCERTAIN NOT_OBSERVED | SYNTHETIC. Shipment is correct; photos are heavily blurred. Abstaining (UNCERTAIN) is the desired output. |
| syn-heldout-dark | PASS | UNCERTAIN | sku_check: UNCERTAIN NOT_OBSERVED<br>carton_check: UNCERTAIN NOT_OBSERVED<br>units_per_carton_check: UNCERTAIN NOT_OBSERVED<br>quantity_check: UNCERTAIN NOT_OBSERVED<br>variant_check: UNCERTAIN NOT_OBSERVED<br>damage_check: UNCERTAIN LOW_VISIBILITY<br>component_check: UNCERTAIN NOT_OBSERVED | SYNTHETIC. Shipment is correct; photos are badly under-exposed. Abstaining (UNCERTAIN) is the desired output. |

## Per-check results

Positive class = FAIL (a real problem with the shipment). Precision/recall use decided checks; `recall` counts an abstention on a true FAIL as a miss, `recall (decided)` does not. FN = truth FAIL, agent PASS (silent miss).

| check | n | truth FAIL | TP | FP | FN | TN | abstain | precision | recall | recall (decided) | accuracy (decided) | abstention |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sku_check | 7 | 1 | 0 | 0 | 0 | 4 | 3 | n/a | 0.00 | n/a | 1.00 | 0.43 |
| carton_check | 7 | 1 | 0 | 0 | 1 | 4 | 2 | n/a | 0.00 | 0.00 | 0.80 | 0.29 |
| units_per_carton_check | 7 | 0 | 0 | 1 | 0 | 4 | 2 | 0.00 | n/a | n/a | 0.80 | 0.29 |
| quantity_check | 7 | 1 | 1 | 0 | 0 | 4 | 2 | 1.00 | 1.00 | 1.00 | 1.00 | 0.29 |
| variant_check | 7 | 1 | 1 | 0 | 0 | 4 | 2 | 1.00 | 1.00 | 1.00 | 1.00 | 0.29 |
| damage_check | 7 | 1 | 1 | 0 | 0 | 4 | 2 | 1.00 | 1.00 | 1.00 | 1.00 | 0.29 |
| component_check | 7 | 0 | 0 | 0 | 0 | 5 | 2 | n/a | n/a | n/a | 1.00 | 0.29 |

## Failure modes

Every wrong, abstained or errored outcome, grouped by the backend `reason_code` that produced it (one case can appear under several modes).

| outcome | reason_code | meaning | cases | checks affected | example cases |
|---|---|---|---:|---|---|
| check-level missed FAIL | `MATCH` | agent reported a match | 1 | carton_check | syn-heldout-short_cartons |
| check-level false FAIL | `COUNT_MISMATCH` | agent counted a different number | 1 | units_per_carton_check | syn-heldout-short_cartons |
| abstained (UNCERTAIN) | `NOT_OBSERVED` | value never read with enough confidence in any photo | 3 | sku_check x3, carton_check x2, units_per_carton_check x2, quantity_check x2, variant_check x2, component_check x2 | syn-heldout-wrong_sku, syn-heldout-blurred, syn-heldout-dark |
| abstained (UNCERTAIN) | `LOW_VISIBILITY` | damage could not be assessed confidently (blur/dark/occlusion) | 2 | damage_check x2 | syn-heldout-blurred, syn-heldout-dark |

## Reading this report

- **False accepts** are the number to drive to zero; a false reject or an abstention only costs operator time.
- Accuracy without coverage is meaningless: an agent that abstains on everything has 100% accuracy on 0 decided cases.
- With fewer than ~50 held-out shipments every percentage has a wide confidence interval; quote the counts.
- Raw responses for every case are in `results.jsonl` next to this file.
