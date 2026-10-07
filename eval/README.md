# Evaluating the Receiving Manager agent

This folder holds the evaluation harness: a manifest format, a runner (`scripts/evaluate.py`) that
pushes each labelled shipment through the real API and writes `EVAL_REPORT.md`, and a synthetic
smoke-test set (`scripts/make_synthetic_set.py`).

> **Status: no real-photo results exist yet.** The only report in this repo,
> [`results/example-demo/EVAL_REPORT.md`](results/example-demo/EVAL_REPORT.md), is a **demo-mode
> pipeline check on synthetic images**: the backend's canned scenarios produce the decisions, so its
> numbers say nothing about how well the agent reads real photos. Real accuracy figures need the
> held-out real-photo set described below.

## 1. Build a held-out set of real photos

### What a "case" is
One case = one inbound shipment (one PO line) + its photo set + labelled truth.
Aim for **at least 40 held-out cases** before quoting percentages, with deliberate coverage of each
failure type: clean deliveries, wrong SKU, wrong variant/colour, short cartons, short units per carton,
visible damage (crush, tear, wet), missing components, and hard capture conditions (glare on the label,
low light, motion blur, partly occluded pallet). Real exceptions are rarer than clean deliveries, so
stage some (swap a unit, remove a cap, pull a carton) and say so in `notes`.

### Capture protocol (per shipment)
Take the photos the way an operator would on the dock, with the phone the operator will use:

| view (`image_type`) | what to capture |
|---|---|
| `pallet` | whole delivery in one frame, every carton visible (this is the only view whose counts are taken as shipment totals) |
| `carton` | one or two close-ups of carton faces; include any damage |
| `label` | the shipping/product label straight on, SKU text, barcode and "QTY n / CTN" readable |
| `unit` | one opened unit showing colour/variant |
| `other` | the components laid out (cap, label, cable, manual ...) |

Do not retake a bad photo for the eval set just because it is bad; glare and blur are part of
reality. Record the capture conditions in `notes`.

### Label truth BEFORE running the agent
1. A person checks the physical shipment against the PO (count cartons, open one, read the label).
2. They fill in `expected_decision` (`PASS` or `EXCEPTION`) and, ideally, every `truth_<check>` column
   (`PASS` / `FAIL`; leave blank or `NOT_REQUIRED` when a check does not apply, e.g. no components on the PO).
3. Only then is the case run. Truth is never edited after seeing the agent's output; if the labeller
   finds they were wrong, fix it and write why in `notes`.

`expected_decision` is the truth about the *shipment*, not about the photos: a correct delivery
photographed in the dark is `PASS`. The desired agent output there is `UNCERTAIN`, which the report
counts as an abstention, not an error.

### Keep the held-out split held out
- `split=dev`: photos you may look at while tuning the prompt, `MIN_CONFIDENCE`, view handling, etc.
- `split=heldout`: never opened while tuning, never pasted into a prompt, never used to pick a
  threshold. Run it once per release candidate and report that run. If you tune after looking at
  held-out failures, those cases have become dev cases; move them and capture new held-out ones.
- Split by **shipment/supplier/day**, not by photo, so near-duplicate photos never straddle the split.

## 2. Manifest format

CSV (see [`manifest.example.csv`](manifest.example.csv)) or JSON (a list of objects, or
`{"cases": [...]}`, with the same keys; list-valued fields may be JSON arrays). One row per case:

| column | required | meaning |
|---|---|---|
| `case_id` | yes | unique id |
| `split` | yes | `dev` or `heldout` |
| `po_id`, `sku`, `product_name`, `variant` | yes | PO fields sent to `POST /api/inspections` |
| `expected_quantity`, `expected_cartons`, `units_per_carton` | yes | integers from the PO |
| `expected_components` | no | `;`-separated, e.g. `cap;label` (empty = component check not required) |
| `photos` | yes | `;`-separated `view:relative/path.jpg`; paths are relative to the manifest file. Views: `pallet`, `carton`, `label`, `unit`, `other`. Repeat a view for several photos |
| `expected_decision` | yes | truth: `PASS` or `EXCEPTION` |
| `truth_sku_check` ... `truth_component_check` | no | per-check truth `PASS` / `FAIL` for `sku_check`, `carton_check`, `units_per_carton_check`, `quantity_check`, `variant_check`, `damage_check`, `component_check` |
| `notes` | no | capture conditions, how the exception was staged, labeller remarks |
| `scenario` | demo only | demo scenario name passed as `?scenario=` (ignored unless `--scenario-column` is given) |

Keep real photos out of git if they show people, customer addresses or supplier data; the manifest
can point anywhere on disk.

## 3. Run

```bash
# backend running (normal, non-demo mode, real model) on :8000
export RECEIVING_EVAL_API_KEY=<an operator key from RECEIVING_API_KEYS>
../.venv/Scripts/python.exe scripts/evaluate.py --manifest path/to/manifest.csv --split heldout
#   --api http://localhost:8000     backend base URL
#   --out eval/results/<ts>/        default; results/ is git-ignored except the example
#   --split dev|heldout|all         default heldout
#   --limit N, --timeout S, --retries N, --banner "text shown at the top of the report"
```

Output in the run folder: `results.jsonl` (one line per case: truth, prediction, per-check results,
latency, the raw `/analyze` response or the error), `metrics.json`, and `EVAL_REPORT.md`.
A case that fails (missing photo, HTTP error, timeout) is recorded as `ERROR` and the run continues;
5xx and connection errors are retried once.

### Synthetic smoke test (pipeline only)

```bash
../.venv/Scripts/python.exe -m pip install -r scripts/requirements-eval.txt
../.venv/Scripts/python.exe scripts/make_synthetic_set.py          # -> eval/synthetic/ (~2.7 MB)
# demo-mode backend on a spare port, then:
RECEIVING_EVAL_API_KEY=eval-key ../.venv/Scripts/python.exe scripts/evaluate.py \
  --manifest eval/synthetic/manifest.csv --api http://127.0.0.1:8810 \
  --scenario-column scenario --banner "DEMO-MODE PIPELINE CHECK - not accuracy evidence"
```

The generator draws 7 variants x 2 splits (clean, wrong SKU, wrong variant colour, short carton count,
damaged carton, blurred, dark), 5 views each: a shipping label with the SKU as text and as a real
CODE128 barcode (decodable), a pallet with N cartons, a carton close-up (crushed/torn/water-stained
when damaged), an opened unit in the variant colour, and the components laid out. **These are
drawings, not photos. Results on them are a smoke test of the pipeline, not evidence of accuracy.**
Pointed at a real-model backend (no `--scenario-column`) they are still useful as a sanity check that
the model can read a clean label and that blur/dark produce abstentions.

In demo mode the backend ignores the pixels and returns a canned scenario, so the `scenario` column
maps each case to the closest one: clean -> `correct_shipment`, wrong variant -> `wrong_variant`,
damaged -> `damaged_carton`, short -> `short_shipment`, blurred/dark -> `ambiguous`, wrong SKU ->
`barcode_glare` (there is no wrong-SKU demo scenario, so it shows up as an abstention). Demo
`short_shipment` shortens units per carton rather than cartons, which is why the example report shows
check-level disagreements on `carton_check` / `units_per_carton_check` for the short case.

## 4. Reading the report

- **Confusion matrix**: rows are truth (`PASS`/`EXCEPTION`), columns are the agent's decision
  (`PASS`, `EXCEPTION`, `UNCERTAIN`, `PENDING_REVIEW`, plus `ERROR` for harness/API failures).
- **Accuracy on decided cases** is measured only where the agent committed to PASS/EXCEPTION;
  always read it next to **coverage** (share of cases not UNCERTAIN/PENDING_REVIEW).
- **False accepts** (truth EXCEPTION -> PASS) are the costly error: the delivery is received as good
  and the supplier-claim window is lost. They are listed by case id. **False rejects** (truth PASS ->
  EXCEPTION) cost re-inspection time and a wrong claim.
- **UNCERTAIN / PENDING_REVIEW** cases are listed with the checks that abstained.
  `PENDING_REVIEW` means perception failed (timeout, missing key, model error) and nothing was checked.
- **Per-check table** (when `truth_*` columns exist): positive class is FAIL (a real problem).
  `precision` = TP/(TP+FP); `recall` counts abstention on a true FAIL as a miss, `recall (decided)`
  does not; `abstention` = share of cases where the check was UNCERTAIN. FN is a silent miss.
- **Failure modes** groups every wrong/abstained/errored outcome by the backend `reason_code`
  (`NOT_OBSERVED`, `VIEWS_DISAGREE`, `LOW_VISIBILITY`, `PERCEPTION_UNAVAILABLE`, `SKU_MISMATCH`,
  `COUNT_MISMATCH`, `MATCH` on a missed problem, ...; new codes, e.g. from barcode decoding or image
  quality gates, appear automatically) with counts and example case ids. `NO_CHECK_TRUTH` means a
  decision was wrong but the case had no per-check truth to attribute it to.
- **Latency** p50/p95 is wall time per case (create + upload + analyze) and for `/analyze` alone.

With small held-out sets, quote counts ("1 false accept in 42 shipments"), not just percentages.
