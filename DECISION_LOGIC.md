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
| sku | exact match after dropping label text ("SKU:", "Item #") and separators | clearly different SKU | not read; photos disagree; differs only in OCR look-alikes (O/0, I/1, S/5, B/8); only barcode digits read |
| carton | counted cartons = PO cartons | different count | not counted, or photos disagree |
| units_per_carton | counted = PO units/carton | different | not counted, or photos disagree |
| quantity | direct count, or counted cartons x counted units/carton, = PO total | derived (or corroborated) total differs | not counted; direct and derived counts disagree; a direct count that differs but is not backed by cartons x units/carton; PO cartons x units/carton != PO total |
| variant | every PO variant word present (product-name and size words ignored) | no word shared | extra colour word ("Navy Blue" vs "Blue"); partial overlap; not read; photos disagree |
| damage | a reliable photo judged the packaging and no photo shows damage | a reliable photo shows damage (crushed, torn, wet, punctured, open, broken…) | never judged; cosmetic marks only; "uncertain" / unrecognised wording; a weak reading that mentions damage. Photos that could not judge (null) do not vote |
| components | every expected component seen ("caps", "bottle cap" match "cap") | a photo shows a component missing ("missing: cap", "no cap", "cap missing") | an expected component was not seen; photos disagree |

Components with no expected list give `NOT_REQUIRED`.

## Example

```text
PO: 2 cartons x 12 = 24.  Photos: 2 cartons, 10 per carton, 20 units
=> carton PASS, units_per_carton FAIL, quantity FAIL => EXCEPTION, prep_hold true
```
