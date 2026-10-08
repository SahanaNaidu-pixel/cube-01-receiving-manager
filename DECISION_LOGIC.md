# Decision Logic

The verdict is computed by Python, never by the model. The rules are in `backend/app/core/decision_engine.py`, and fusion and check construction are in `backend/app/services/vision.py`. The model (or the demo provider, or the operator) only supplies readings.

Core rule: **a value the system did not see gives UNCERTAIN, never the expected value.**

## Readings

Each reading has a `check_type` (`sku`, `quantity`, `carton`, `units_per_carton`, `variant`, `damage`, `components`), an `observation`, a `confidence` (0–1) and a description. It is tied to one image.

- **Model readings** come from one Responses API call with a strict JSON schema. For each photo the model also reports `visibility` and `shows_whole_shipment`. The prompt does not contain the PO values.
- **Operator readings** come from `manual_observations` (`observed_sku`, `observed_quantity`, `observed_cartons`, `observed_units_per_carton`, `observed_variant`, `damage`, `components_present`, `components_missing`, `note`). They become a synthetic image `operator` with confidence 1.0 and `shows_whole_shipment: true`, and their evidence ids are `OPR-0001…`. Damage `"none"` / `"no damage"` / `"no_damage"` means no damage, and `components_missing` entries become `missing:<name>`.
- **Payload validation.** A model reply that names an unknown image id, repeats an image id, or uses the reserved id `operator` is treated as a perception failure. A visibility value outside `clear | blurred | occluded | dark | uncertain` is replaced by `uncertain`. Images the model did not report are listed in `measurements.images_not_reported`; this does not change the verdict.

## Fusion across photos

- **`MIN_CONFIDENCE = 0.6`.** A reading below 0.6 counts as not seen. One global threshold, not calibrated per check.
- **Reliable readings.** For SKU, variant, cartons, units per carton and total quantity, every reliable reading from every photo (and the operator) is combined. Photos that do not show a value do not contradict it.
- **`VIEWS_DISAGREE`.** If reliable readings give two different values, the check is `UNCERTAIN` with `VIEWS_DISAGREE`. SKUs are compared after SKU normalisation and variants case-insensitively. This includes operator vs model disagreement.
- **Partial-view exclusion.** Carton and total-quantity counts are used only from photos with `shows_whole_shipment: true`. Counts from close-ups are kept in `measurements.excluded_partial_view_readings` as evidence, but are not treated as shipment totals. Units per carton is not filtered this way.
- **Measurements.** Every check stores `readings`, `reliable_readings`, `min_confidence` and `sources` (`vision` and / or `operator`). The check's confidence is the highest reliable reading's confidence.

## Checks

Reason codes are shown in `monospace`. `PO_FIELD_MISSING` (UNCERTAIN) applies to the SKU, count and variant checks when the expected PO value is missing.

| Check (`check_key`) | PASS | FAIL | UNCERTAIN | NOT_REQUIRED |
| --- | --- | --- | --- | --- |
| `sku_check` (`identity`) | Normalised SKU equals the PO SKU: `MATCH`. Normalisation uppercases and drops spaces, `- _ . /`, with no O/0 substitution. | Different SKU read: `SKU_MISMATCH` | Not read: `NOT_OBSERVED`. Photos disagree: `VIEWS_DISAGREE` | — |
| `carton_check` (`carton_count`) | Counted cartons = PO cartons: `MATCH` | Different count: `COUNT_MISMATCH` | Not counted in a whole-shipment view: `NOT_OBSERVED`. Negative count: `INVALID_READING`. `VIEWS_DISAGREE` | — |
| `units_per_carton_check` (`units_per_carton`) | Counted = PO units per carton: `MATCH` | Different: `COUNT_MISMATCH` | `NOT_OBSERVED`, `INVALID_READING`, `VIEWS_DISAGREE` | — |
| `quantity_check` (`total_quantity`) | Total = PO quantity: `MATCH`. Total is the direct count, or counted cartons × counted units per carton when no direct count exists (`measurements.derived`). | Different: `COUNT_MISMATCH` | PO cartons × units per carton ≠ PO quantity: `PO_INCONSISTENT`. Direct count ≠ derived product: `READINGS_DISAGREE`. Nothing counted: `NOT_OBSERVED`. Direct counts disagree: `VIEWS_DISAGREE` | — |
| `variant_check` (`variant`) | Case-insensitive match: `MATCH` | Different: `VARIANT_MISMATCH` | `NOT_OBSERVED`, `VIEWS_DISAGREE` | PO variant is `n/a`, `na` or `none`: `NOT_REQUIRED` |
| `damage_check` (`carton_damage`) | At least one reading, every reading reliable, none shows damage: `NO_DAMAGE` | A reliable reading shows damage: `DAMAGE_VISIBLE` | Never assessed: `NOT_OBSERVED`. Any low-confidence, null or "uncertain" reading and no reliable damage: `LOW_VISIBILITY`. Operator and photo readings decisive but different: `VIEWS_DISAGREE`. `DAMAGE_POLICY=review` and damage seen: `DAMAGE_REVIEW_REQUIRED` | — |
| `component_check` (`components`) | Every expected component seen present: `MATCH` | An expected component reported `missing:` and not seen present anywhere: `COMPONENT_MISSING` | Reported both present and missing: `VIEWS_DISAGREE`. Expected component never seen: `NOT_OBSERVED` | PO lists no components: `NOT_REQUIRED` |
| `carton_condition_check` (`carton_condition`, contract extension) | Every intake carton has seal `intact` and condition `good`: `MATCH` | Any carton with seal `broken` / `resealed`, or a visible condition other than `good` / `unknown` (`crushed`, `torn`, `punctured`, `wet`, `open`, `label_damaged`): `CARTON_CONDITION_REPORTED` | Nothing recorded for any carton, or not for every carton: `NOT_OBSERVED`. `DAMAGE_POLICY=review` and a problem reported: `DAMAGE_REVIEW_REQUIRED` | No cartons recorded at intake: `NOT_REQUIRED` |

Notes:

- **Damage.** Damage tokens such as `crushing`, `tear` or `wet` count as damage. The words `none`, `no_damage` and `no damage` mean undamaged. The tokens `""`, `unknown`, `n/a`, `uncertain`, `not_available` and `not_visible` mean not assessed.
  - A low-confidence reading counts as "uncertain" whatever it says, so only a reliable reading can FAIL.
  - One reliable photo showing damage is enough to FAIL, even if other photos show none.
  - When operator readings exist, the model and operator damage results are judged separately. If the model result is UNCERTAIN or absent, the operator result is used. If both are decisive and agree, they are combined. If they are decisive and disagree, the check is `VIEWS_DISAGREE`.
- **Components.** Components are matched case-insensitively. Reported components that are not in the PO list are ignored.
- **Carton condition** uses only the operator's intake data, never the model, so it runs even when perception is unavailable.
- **`DAMAGE_POLICY=review`** affects only `damage_check` and `carton_condition_check`. It turns their FAIL into UNCERTAIN `DAMAGE_REVIEW_REQUIRED`, and the reason ends with "Held for human review (DAMAGE_POLICY=review)."
- **Perception unavailable.** When perception failed or is unavailable, a perception check with no operator reading gets `PERCEPTION_UNAVAILABLE` (UNCERTAIN).

### `model_version` per check (in the record)

| Value | When |
| --- | --- |
| `operator` | `carton_condition`, and any check whose only reliable source was the operator |
| `rules` | Reason code `NOT_REQUIRED`, `PO_FIELD_MISSING` or `PO_INCONSISTENT`, or a quantity derived arithmetically |
| model id (e.g. `gpt-4o-mini`, `demo`, `none`) | Everything else |

`rule_ids` are `RCV-<CHECK>-01`, for example `RCV-SKU-01`, `RCV-UNITS-PER-CARTON-01` and `RCV-CARTON-CONDITION-01`.

## Overall verdict (`evaluate_overall`)

1. `NOT_REQUIRED` checks are ignored. If nothing is left, the verdict is `UNCERTAIN`.
2. Any `FAIL` gives `EXCEPTION`.
3. Otherwise, anything not `PASS` gives `UNCERTAIN`.
4. Otherwise the verdict is `PASS`.

**Perception failure without operator readings** sets the verdict to `PENDING_REVIEW` regardless of the checks. "Perception failure" covers no provider, a model error, timeout, refusal, incomplete response, invalid output, or the demo `perception_failure` scenario. Every perception check is `UNCERTAIN` (`PERCEPTION_UNAVAILABLE`). The record has `status: "pending"`, `stage: "pending_review"`, `outcome.failure_reason` set and `PERCEPTION_UNAVAILABLE` added to `hold_reasons` (contract rule 3).

This holds even if the operator-reported `carton_condition` check FAILs. That FAIL is recorded in the checks, opens an issue and is named in the agent summary, but the verdict stays `PENDING_REVIEW` rather than `EXCEPTION`.

**Perception failure with operator readings** is decided by `evaluate_overall` as above (`analysis_status: "operator_only"`). The vision failure is kept in `record.perception`.

## Verdict mapping

| Engine / stored verdict | UI and A2A `verdict` | Record `outcome.decision` | `outcome.disposition` |
| --- | --- | --- | --- |
| `PASS` | `PASS` | `ACCEPT` | `putaway` |
| `EXCEPTION` | `FAIL` | `REJECT` | `quarantine` |
| `UNCERTAIN` | `UNCERTAIN` | `PENDING_REVIEW` | `hold_for_review` |
| `PENDING_REVIEW` | `UNCERTAIN` | `PENDING_REVIEW` | `hold_for_review` |
| never analysed | `null` (UI shows NOT_ANALYZED) | — | — |

`outcome.prep_hold` is true unless the decision is `ACCEPT` with no hold reasons. `hold_reasons` lists `<check_key>:<FAIL|UNCERTAIN>` for every held check. Prep must not pass a unit whose record has `prep_hold: true` unless an override clears it.

## Issues (exceptions)

After every run (`services/issues.py`):

1. Every issue of the inspection that is still `open` or `in_review` becomes `superseded`, pointing at the new record (`superseded_by_record`). Resolved issues are left as they are.
2. One new issue is opened per check with verdict FAIL or UNCERTAIN in the new record: `issue_type` = reason code, `severity` = `high` (FAIL) or `medium` (UNCERTAIN), with the expected and observed values and the supporting image ids.

Overrides and review decisions do not close issues; a person resolves them. Transitions: `start_review` (open → in_review), `resolve` (open / in_review → resolved), `reopen` (resolved → open), `assign`. Any other transition gives 409.

## Review tasks

There is at most one active task (`open` or `evidence_requested`) per inspection (`services/reviews.py`).

- **Run ends `UNCERTAIN` or `PENDING_REVIEW`.** An existing active task is refreshed: it returns to `open` and its machine snapshot is updated. Otherwise a new task is opened with trigger `perception_unavailable` (pending) or `uncertain`. The reason is the perception failure, or the list of FAIL / UNCERTAIN checks. A manual task keeps its own reason.
- **Run ends `PASS` or `EXCEPTION`.** An automatic active task is `cancelled` (`resolution: superseded_by_run`). A manual task stays open, with its machine snapshot updated. An EXCEPTION does not open a review task by itself; its failed checks become issues.
- **Manual request** (`POST /api/inspections/{id}/review`). Creates a task with trigger `manual`. It gives 409 if an active task already exists.
- **Request evidence.** Sets the task to `evidence_requested`. The next run puts it back to `open`.

## Overrides and human review preserve the machine result

- **Override** (`POST /api/inspections/{id}/override`): `decision` is `PASS`, `EXCEPTION` or `UNCERTAIN`, and a reason (1–2000 characters) is required.
  - Only `approver` may choose `PASS` (otherwise 403). It is allowed only after a run (otherwise 409).
  - The operator id and role come from the API key, never from the body.
  - It appends a new sealed record version. `checks` are copied unchanged, so the machine verdict per check stays in the record. `outcome` takes the override verdict. `overrides[]` gains `{override_id, check_key: null, operator_id, role, from_verdict, to_verdict, reason, prev_content_hash, before_hash, new_content_hash, created_at}`.
  - A row is written to the append-only `overrides` table.
  - If a review task is active, it is completed with `resolution: overridden`.
  - After an override, `hold_reasons` is empty if the new decision is `ACCEPT`. Otherwise it holds the previous held checks plus `override:<VERDICT>`.
- **Review decision** (`POST /api/reviews/{id}/decision`): `PASS`, `FAIL` or `UNCERTAIN` with a note. PASS needs `approver`. It goes through the same override path (`FAIL → EXCEPTION`, reason `Review <task_id>: <note>`). The task is completed with `human_decision`, `decided_by` and `decided_at`, and its `machine_verdict` and `machine_record_id` stay on the task.
- **Re-running** after an override appends a new machine version. Its `outcome` is the new machine verdict, earlier overrides stay in `overrides[]`, and all versions stay in the chain.

## Example

```text
PO: 2 cartons x 12 = 24 units, variant Blue, components [cap, label]
Whole-shipment photo: 2 cartons; label close-up: 10 per carton; no direct total
=> carton PASS, units_per_carton FAIL (COUNT_MISMATCH), quantity derived 2 x 10 = 20 FAIL (COUNT_MISMATCH)
=> verdict EXCEPTION -> FAIL / REJECT / quarantine, prep_hold true,
   hold_reasons [units_per_carton:FAIL, total_quantity:FAIL, ...]; two high-severity issues opened
   (plus medium-severity ones for any check left UNCERTAIN, e.g. SKU not read)
```
