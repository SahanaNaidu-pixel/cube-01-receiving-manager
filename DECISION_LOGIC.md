# Decision Logic

The verdict is computed by `backend/app/core/decision_engine.py`, never by the model.

Core rule: **a value the system did not see gives UNCERTAIN, never the expected value.**

## Overall

- Any check `FAIL` gives `EXCEPTION` (decision `REJECT`).
- Otherwise, any check `UNCERTAIN` gives `UNCERTAIN` (decision `PENDING_REVIEW`).
- Otherwise `PASS` (decision `ACCEPT`). `NOT_REQUIRED` checks are ignored.
- If perception failed (model error, timeout or missing key), the result is `PENDING_REVIEW` and every check is `UNCERTAIN`.

## Checks

| Check | PASS | FAIL | UNCERTAIN |
|---|---|---|---|
| sku | exact normalised match | different SKU read | not read, or photos disagree |
| carton | counted cartons = PO cartons | different count | not counted, or photos disagree |
| units_per_carton | counted = PO units/carton | different | not counted, or photos disagree |
| quantity | direct count, or counted cartons x counted units/carton, = PO total | different | not counted; direct and derived counts disagree; PO cartons x units/carton != PO total |
| variant | match | different variant | not read, or photos disagree |
| damage | assessed in at least one photo and no damage seen | damage seen in any photo | never assessed, low confidence, or "uncertain" |
| components | every expected component seen | a photo shows a component missing | an expected component was not seen |

Components with no expected list give `NOT_REQUIRED`.

## Example

```text
PO: 2 cartons x 12 = 24.  Photos: 2 cartons, 10 per carton, 20 units
=> carton PASS, units_per_carton FAIL, quantity FAIL => EXCEPTION, prep_hold true
```
