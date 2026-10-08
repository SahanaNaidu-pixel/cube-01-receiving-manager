"""Inspection exports: JSON bundle, per-check CSV, self-contained printable HTML (all user data escaped)."""

from __future__ import annotations

import csv
import io
import json
from html import escape

from fastapi.responses import Response

from backend.app.services import inspection_service as svc
from backend.app.services.audit import list_events

CSV_COLUMNS = ["inspection_id", "po", "sku", "check_key", "verdict", "expected", "observed", "reason_code", "reason",
               "confidence", "evidence_image_ids"]


def _attachment(content: str | bytes, media_type: str, filename: str) -> Response:
    return Response(content=content, media_type=media_type,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def _cell(value) -> str:
    """Flatten a value for CSV; neutralise spreadsheet formula injection."""
    if value is None:
        return ""
    text = json.dumps(value, ensure_ascii=False) if isinstance(value, (list, dict)) else str(value)
    if text and (text[0] in "=+@\t\r" or (text[0] == "-" and not text[1:2].isdigit())):
        text = "'" + text
    return text


def _check_rows(inspection) -> list[dict]:
    record = inspection.record
    if not record:
        return []
    confidence = {c.check_name: c.confidence for c in inspection.checks}
    return [{
        "inspection_id": inspection.inspection_id,
        "po": inspection.po.po_id,
        "sku": inspection.po.sku,
        "check_key": c["check_key"],
        "verdict": c["verdict"],
        "expected": c.get("expected_state"),
        "observed": c.get("observed_state"),
        "reason_code": c.get("reason_code"),
        "reason": c.get("reason"),
        "confidence": confidence.get(c.get("check_name")),
        "evidence_image_ids": ";".join(c.get("image_ids") or []),
    } for c in record["checks"]]


def export(principal: dict, inspection_id: str, fmt: str) -> Response:
    inspection = svc.load(principal, inspection_id)
    org = principal["organization_id"]
    if fmt == "csv":
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for row in _check_rows(inspection):
            writer.writerow({k: _cell(v) for k, v in row.items()})
        return _attachment(buffer.getvalue(), "text/csv; charset=utf-8", f"{inspection_id}-checks.csv")
    view = svc.inspection_detail(principal, inspection)
    records = [row["record"] for row in svc.repository.records(org, inspection_id)]
    audit = list_events(org, inspection_id=inspection_id)
    if fmt == "json":
        body = json.dumps({"inspection": view, "records": records, "audit": audit}, indent=2, default=str)
        return _attachment(body, "application/json", f"{inspection_id}-export.json")
    verification = svc.verify(principal, inspection_id) if records else None
    return _attachment(render_html(view, records, audit, verification), "text/html; charset=utf-8",
                       f"{inspection_id}-report.html")


def _e(value) -> str:
    if value is None:
        return "—"
    if isinstance(value, (list, dict)):
        value = json.dumps(value, ensure_ascii=False)
    return escape(str(value), quote=True)


def render_html(view: dict, records: list[dict], audit: list[dict], verification: dict | None) -> str:
    po = view["po"]
    latest = records[-1] if records else None
    outcome = (latest or {}).get("outcome", {})
    ship = view.get("shipment") or {}
    check_rows = "".join(
        f"<tr class='v-{_e(c['verdict'])}'><td>{_e(c['check_key'])}</td><td><b>{_e(c['verdict'])}</b></td>"
        f"<td>{_e(c.get('expected_state'))}</td><td>{_e(c.get('observed_state'))}</td><td>{_e(c.get('reason_code'))}</td>"
        f"<td>{_e(c.get('reason'))}</td><td>{_e(c.get('model_version'))}</td><td>{_e(', '.join(c.get('image_ids') or []))}</td></tr>"
        for c in (latest or {}).get("checks", [])
    ) or "<tr><td colspan='8'>Not analysed yet.</td></tr>"
    image_rows = "".join(
        f"<tr><td>{_e(f['evidence_id'])}</td><td>{_e(f['view'])}</td><td>{_e(f['filename'])}</td>"
        f"<td>{_e(f['file_size'])}</td><td class='mono'>{_e(f['sha256_digest'])}</td><td>{_e(f['analysis_status'])}</td></tr>"
        for f in view.get("evidence_files", [])
    ) or "<tr><td colspan='6'>No images.</td></tr>"
    carton_rows = "".join(
        f"<tr><td>{_e(c.get('carton_id'))}</td><td>{_e(c.get('expected_units'))}</td><td>{_e(c.get('seal_condition'))}</td>"
        f"<td>{_e(c.get('visible_condition'))}</td><td>{_e(c.get('notes'))}</td></tr>"
        for c in view.get("cartons", [])
    )
    issue_rows = "".join(
        f"<tr><td>{_e(i['issue_id'])}</td><td>{_e(i['check_key'])}</td><td>{_e(i['severity'])}</td><td>{_e(i['status'])}</td>"
        f"<td>{_e(i['issue_type'])}</td><td>{_e(i.get('reason'))}</td></tr>"
        for i in view.get("issues", [])
    ) or "<tr><td colspan='6'>No issues.</td></tr>"
    override_rows = "".join(
        f"<tr><td>{_e(o.get('override_id'))}</td><td>{_e(o.get('from_verdict'))} → {_e(o.get('to_verdict'))}</td>"
        f"<td>{_e(o.get('operator_id'))}</td><td>{_e(o.get('reason'))}</td><td>{_e(o.get('created_at'))}</td></tr>"
        for o in (latest or {}).get("overrides", [])
    ) or "<tr><td colspan='5'>No overrides.</td></tr>"
    note_rows = "".join(f"<li><b>{_e(n.get('author'))}</b> ({_e(n.get('created_at'))}): {_e(n.get('text'))}</li>"
                        for n in view.get("notes", [])) or "<li>No notes.</li>"
    audit_rows = "".join(
        f"<tr><td>{_e(a['created_at'])}</td><td>{_e(a['actor'])}</td><td>{_e(a['action'])}</td><td>{_e(a.get('summary'))}</td>"
        f"<td class='mono'>{_e(a.get('request_id'))}</td></tr>" for a in audit
    ) or "<tr><td colspan='5'>No audit events.</td></tr>"
    integrity = "not sealed yet"
    if verification:
        integrity = "verified" if verification["integrity_verified"] else "FAILED: " + "; ".join(verification["problems"])
    cartons_section = (f"<h2>Cartons (intake)</h2><table><tr><th>Carton</th><th>Expected units</th><th>Seal</th>"
                       f"<th>Condition</th><th>Notes</th></tr>{carton_rows}</table>") if carton_rows else ""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receiving report {_e(view['inspection_id'])}</title>
<style>
body{{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;color:#111;background:#fff}}
h1{{font-size:20px;margin:0 0 4px}} h2{{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #ccc;padding-bottom:3px}}
table{{border-collapse:collapse;width:100%;font-size:12px}} th,td{{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}}
th{{background:#f3f3f3}} .mono{{font-family:ui-monospace,Consolas,monospace;word-break:break-all}}
.v-FAIL td:nth-child(2){{color:#b00020}} .v-PASS td:nth-child(2){{color:#0a7a2f}} .v-UNCERTAIN td:nth-child(2){{color:#a15c00}}
.kv td:first-child{{width:200px;font-weight:600}} @media print{{body{{margin:8mm}}}}
</style></head><body>
<h1>Receiving inspection {_e(view['inspection_id'])}</h1>
<p>Verdict: <b>{_e(view.get('verdict') or 'NOT ANALYSED')}</b> · Decision: <b>{_e(outcome.get('decision'))}</b> ·
Prep hold: <b>{_e(outcome.get('prep_hold'))}</b> · Integrity: <b>{_e(integrity)}</b></p>
<h2>Purchase order</h2>
<table class="kv"><tr><td>PO</td><td>{_e(po['po_id'])} (line {_e(po.get('po_line'))})</td></tr>
<tr><td>SKU / ASIN</td><td>{_e(po['sku'])} / {_e(po.get('asin'))}</td></tr>
<tr><td>Product</td><td>{_e(po['product_name'])} · variant {_e(po['variant'])}</td></tr>
<tr><td>Expected</td><td>{_e(po['expected_cartons'])} cartons × {_e(po['units_per_carton'])} = {_e(po['expected_quantity'])} units</td></tr>
<tr><td>Components</td><td>{_e(', '.join(po.get('expected_components') or []))}</td></tr>
<tr><td>Shipment</td><td>{_e(ship.get('shipment_id'))} · supplier {_e(ship.get('supplier'))} · ASN {_e(ship.get('asn'))} · warehouse {_e(ship.get('warehouse'))}</td></tr>
<tr><td>Agent summary</td><td>{_e(view.get('agent_summary'))}</td></tr></table>
{cartons_section}
<h2>Checks (latest sealed record)</h2>
<table><tr><th>Check</th><th>Verdict</th><th>Expected</th><th>Observed</th><th>Reason code</th><th>Reason</th><th>Model</th><th>Images</th></tr>{check_rows}</table>
<h2>Evidence</h2>
<table><tr><th>Image</th><th>View</th><th>File</th><th>Bytes</th><th>SHA-256</th><th>Analysis</th></tr>{image_rows}</table>
<h2>Issues</h2>
<table><tr><th>Issue</th><th>Check</th><th>Severity</th><th>Status</th><th>Type</th><th>Reason</th></tr>{issue_rows}</table>
<h2>Overrides</h2>
<table><tr><th>Override</th><th>Change</th><th>By</th><th>Reason</th><th>At</th></tr>{override_rows}</table>
<h2>Notes</h2><ul>{note_rows}</ul>
<h2>Sealed record</h2>
<table class="kv"><tr><td>Record</td><td class="mono">{_e((latest or {}).get('record_id'))} (version {_e((latest or {}).get('version'))} of {len(records)})</td></tr>
<tr><td>Content hash</td><td class="mono">{_e((latest or {}).get('content_hash'))}</td></tr>
<tr><td>Seal</td><td class="mono">{_e((latest or {}).get('seal'))}</td></tr></table>
<h2>Audit trail</h2>
<table><tr><th>At</th><th>Actor</th><th>Action</th><th>Summary</th><th>Request</th></tr>{audit_rows}</table>
</body></html>"""
