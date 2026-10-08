"""SQLite persistence. Every query is scoped by organization_id.

ponytail: SQLite single file; move to Postgres with forced row-level security when deployed multi-tenant.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from backend.app.core.config import REPO_ROOT, get_settings
from backend.app.models.inspection import Inspection

SCHEMA = """
CREATE TABLE IF NOT EXISTS inspections (
    inspection_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
    record_id TEXT PRIMARY KEY,
    inspection_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (inspection_id, version)
);
CREATE TABLE IF NOT EXISTS overrides (
    override_id TEXT PRIMARY KEY,
    inspection_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    role TEXT NOT NULL,
    from_verdict TEXT NOT NULL,
    to_verdict TEXT NOT NULL,
    reason TEXT NOT NULL,
    before_hash TEXT NOT NULL,
    after_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS records_no_update BEFORE UPDATE ON records
BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS records_no_delete BEFORE DELETE ON records
BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS overrides_no_update BEFORE UPDATE ON overrides
BEGIN SELECT RAISE(ABORT, 'overrides are append-only'); END;
CREATE TRIGGER IF NOT EXISTS overrides_no_delete BEFORE DELETE ON overrides
BEGIN SELECT RAISE(ABORT, 'overrides are append-only'); END;
"""

# JSON-document tables (one JSON blob per row), all scoped by organization_id.
# ref = secondary lookup key (audit: entity_id, activity: request_id); idem = idempotency key (A2A inbound).
DOC_TABLES = ("issues", "review_tasks", "audit_events", "agent_activity", "products", "purchase_orders", "notes")
APPEND_ONLY_DOC_TABLES = ("audit_events",)


def _doc_schema() -> str:
    parts = []
    for name in DOC_TABLES:
        parts.append(f"""
CREATE TABLE IF NOT EXISTS {name} (
    organization_id TEXT NOT NULL,
    id TEXT NOT NULL,
    inspection_id TEXT,
    status TEXT,
    kind TEXT,
    ref TEXT,
    idem TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (organization_id, id)
);
CREATE INDEX IF NOT EXISTS ix_{name}_created ON {name} (organization_id, created_at);
CREATE INDEX IF NOT EXISTS ix_{name}_inspection ON {name} (organization_id, inspection_id);
CREATE INDEX IF NOT EXISTS ix_{name}_ref ON {name} (organization_id, ref);
CREATE UNIQUE INDEX IF NOT EXISTS ux_{name}_idem ON {name} (organization_id, idem);""")
    for name in APPEND_ONLY_DOC_TABLES:
        parts.append(f"""
CREATE TRIGGER IF NOT EXISTS {name}_no_update BEFORE UPDATE ON {name}
BEGIN SELECT RAISE(ABORT, '{name} are append-only'); END;
CREATE TRIGGER IF NOT EXISTS {name}_no_delete BEFORE DELETE ON {name}
BEGIN SELECT RAISE(ABORT, '{name} are append-only'); END;""")
    return "\n".join(parts)


FULL_SCHEMA = SCHEMA + _doc_schema()
_initialized: set[str] = set()
_init_lock = threading.Lock()


def connect() -> sqlite3.Connection:
    """Open a connection; the schema (idempotent CREATE IF NOT EXISTS) and WAL are applied once per DB file."""
    path = _db_path()
    conn = sqlite3.connect(path, isolation_level=None, timeout=10)
    if path not in _initialized or not Path(path).exists():
        with _init_lock:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(FULL_SCHEMA)
            _initialized.add(path)
    return conn


def schema_ok() -> tuple[bool, str]:
    """Readiness probe: SELECT 1 and every expected table present."""
    with closing(connect()) as conn:
        conn.execute("SELECT 1").fetchone()
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    missing = [t for t in ("inspections", "records", "overrides", *DOC_TABLES) if t not in names]
    return (not missing), ("missing tables: " + ", ".join(missing)) if missing else "ok"


class DocumentTable:
    """Small JSON-document table helper. Every call is scoped by organization_id."""

    def __init__(self, name: str):
        assert name in DOC_TABLES
        self.name = name

    def insert(self, organization_id: str, doc_id: str, data: dict, *, created_at: str, updated_at: str | None = None,
               inspection_id: str | None = None, status: str | None = None, kind: str | None = None,
               ref: str | None = None, idem: str | None = None) -> dict:
        with closing(connect()) as conn:
            conn.execute(
                f"INSERT INTO {self.name} (organization_id, id, inspection_id, status, kind, ref, idem, created_at, updated_at, data) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (organization_id, doc_id, inspection_id, status, kind, ref, idem, created_at, updated_at or created_at,
                 json.dumps(data, default=str)),
            )
        return data

    def upsert(self, organization_id: str, doc_id: str, data: dict, *, created_at: str, updated_at: str | None = None,
               inspection_id: str | None = None, status: str | None = None, kind: str | None = None,
               ref: str | None = None) -> dict:
        if self.name in APPEND_ONLY_DOC_TABLES:
            raise ValueError(f"{self.name} is append-only")
        with closing(connect()) as conn:
            conn.execute(
                f"INSERT INTO {self.name} (organization_id, id, inspection_id, status, kind, ref, idem, created_at, updated_at, data) "
                "VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?) "
                "ON CONFLICT (organization_id, id) DO UPDATE SET inspection_id = excluded.inspection_id, "
                "status = excluded.status, kind = excluded.kind, ref = excluded.ref, "
                "updated_at = excluded.updated_at, data = excluded.data",
                (organization_id, doc_id, inspection_id, status, kind, ref, created_at, updated_at or created_at,
                 json.dumps(data, default=str)),
            )
        return data

    def get(self, organization_id: str, doc_id: str) -> dict | None:
        with closing(connect()) as conn:
            row = conn.execute(f"SELECT data FROM {self.name} WHERE organization_id = ? AND id = ?",
                               (organization_id, doc_id)).fetchone()
        return json.loads(row[0]) if row else None

    def find(self, organization_id: str, **equals) -> list[dict]:
        """Rows matching indexed columns (inspection_id, status, kind, ref, idem), oldest first."""
        allowed = {"inspection_id", "status", "kind", "ref", "idem"}
        where, params = ["organization_id = ?"], [organization_id]
        for column, value in equals.items():
            if column not in allowed:
                raise ValueError(column)
            if value is not None:
                where.append(f"{column} = ?")
                params.append(value)
        with closing(connect()) as conn:
            rows = conn.execute(f"SELECT data FROM {self.name} WHERE {' AND '.join(where)} ORDER BY created_at, rowid",
                                params).fetchall()
        return [json.loads(r[0]) for r in rows]

    def count(self) -> int:
        with closing(connect()) as conn:
            return conn.execute(f"SELECT COUNT(*) FROM {self.name}").fetchone()[0]


issues_table = DocumentTable("issues")
review_tasks_table = DocumentTable("review_tasks")
audit_table = DocumentTable("audit_events")
activity_table = DocumentTable("agent_activity")
products_table = DocumentTable("products")
purchase_orders_table = DocumentTable("purchase_orders")
notes_table = DocumentTable("notes")


def _db_path() -> str:
    """Only file-backed sqlite:/// URLs. Relative paths resolve against the repo root, not the CWD."""
    url = get_settings().database_url.strip()
    path = url.removeprefix("sqlite:///") if url.startswith("sqlite:///") else None
    if not path or path.startswith(":memory:") or "mode=memory" in path:
        raise ValueError(f"Unsupported DATABASE_URL {url!r}: only file-backed sqlite:///path URLs are supported.")
    resolved = Path(path) if Path(path).is_absolute() else REPO_ROOT / path
    resolved.parent.mkdir(parents=True, exist_ok=True)
    return str(resolved)


class InspectionRepository:
    def __init__(self):
        _db_path()  # fail fast on an unsupported DATABASE_URL

    def _connect(self) -> sqlite3.Connection:
        return connect()

    def create(self, inspection: Inspection) -> Inspection:
        with closing(self._connect()) as conn:
            conn.execute(
                "INSERT INTO inspections (inspection_id, organization_id, data) VALUES (?, ?, ?)",
                (inspection.inspection_id, inspection.organization_id, inspection.model_dump_json(exclude={"record", "overrides"})),
            )
        return inspection

    def _hydrate(self, conn, row) -> Inspection:
        inspection = Inspection.model_validate_json(row[0])
        latest = conn.execute(
            "SELECT record_json FROM records WHERE organization_id = ? AND inspection_id = ? ORDER BY version DESC LIMIT 1",
            (inspection.organization_id, inspection.inspection_id),
        ).fetchone()
        if latest:
            inspection.record = json.loads(latest[0])
            inspection.overrides = inspection.record["overrides"]
            inspection.final_decision = inspection.record["outcome"]["verdict"]
            inspection.prep_hold = inspection.record["outcome"]["prep_hold"]
        return inspection

    def list(self, organization_id: str) -> list[Inspection]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT data FROM inspections WHERE organization_id = ? ORDER BY rowid", (organization_id,)).fetchall()
            return [self._hydrate(conn, row) for row in rows]

    def get(self, organization_id: str, inspection_id: str) -> Inspection | None:
        with closing(self._connect()) as conn:
            row = conn.execute(
                "SELECT data FROM inspections WHERE organization_id = ? AND inspection_id = ?", (organization_id, inspection_id)
            ).fetchone()
            return self._hydrate(conn, row) if row else None

    def update(self, inspection: Inspection) -> Inspection:
        with closing(self._connect()) as conn:
            conn.execute(
                "UPDATE inspections SET data = ? WHERE organization_id = ? AND inspection_id = ?",
                (inspection.model_dump_json(exclude={"record", "overrides"}), inspection.organization_id, inspection.inspection_id),
            )
        return inspection

    def append_record(self, organization_id: str, inspection_id: str, build) -> dict:
        """build(previous_record_or_None, next_version) -> sealed record. Serialised with BEGIN IMMEDIATE."""
        with closing(self._connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                previous = self._latest(conn, organization_id, inspection_id)
                record = build(previous, (previous["version"] + 1) if previous else 1)
                self._insert_record(conn, record)
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        return record

    def append_override(self, organization_id: str, inspection_id: str, build) -> tuple[dict, dict] | None:
        """build(previous_record) -> (sealed record, override). Returns None if nothing to override."""
        with closing(self._connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                previous = self._latest(conn, organization_id, inspection_id)
                if previous is None:
                    conn.execute("ROLLBACK")
                    return None
                record, override = build(previous)
                self._insert_record(conn, record)
                conn.execute(
                    "INSERT INTO overrides VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (override["override_id"], inspection_id, organization_id, override["operator_id"], override["role"],
                     override["from_verdict"], override["to_verdict"], override["reason"], override["before_hash"],
                     record["content_hash"], override["created_at"]),
                )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        return record, override

    def records(self, organization_id: str, inspection_id: str) -> list[dict]:
        """Records as stored, with the hash column alongside, oldest first."""
        with closing(self._connect()) as conn:
            rows = conn.execute(
                "SELECT record_json, content_hash, version FROM records WHERE organization_id = ? AND inspection_id = ? ORDER BY version",
                (organization_id, inspection_id),
            ).fetchall()
        return [{"record": json.loads(r[0]), "stored_hash": r[1], "version": r[2]} for r in rows]

    def override_rows(self, organization_id: str, inspection_id: str) -> list[dict]:
        with closing(self._connect()) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT * FROM overrides WHERE organization_id = ? AND inspection_id = ? ORDER BY created_at",
                (organization_id, inspection_id),
            ).fetchall()
        return [dict(r) for r in rows]

    @staticmethod
    def _latest(conn, organization_id, inspection_id):
        row = conn.execute(
            "SELECT record_json FROM records WHERE organization_id = ? AND inspection_id = ? ORDER BY version DESC LIMIT 1",
            (organization_id, inspection_id),
        ).fetchone()
        return json.loads(row[0]) if row else None

    @staticmethod
    def _insert_record(conn, record: dict) -> None:
        conn.execute(
            "INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)",
            (record["record_id"], record["inspection_id"], record["organization_id"], record["version"],
             json.dumps(record, sort_keys=True), record["content_hash"], record["created_at"]),
        )

    def generate_id(self) -> str:
        return f"INS-{uuid4().hex[:8].upper()}"
