"""Liveness and readiness. Readiness runs real checks and never reveals secrets."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from uuid import uuid4

from backend.app.core.config import get_settings
from backend.app.services.evidence_record import now_rfc3339

log = logging.getLogger(__name__)
ORDER = {"HEALTHY": 0, "DEGRADED": 1, "UNAVAILABLE": 2}


def liveness() -> dict:
    settings = get_settings()
    return {"status": "ok", "service": "receiving-manager", "version": settings.app_version, "demo_mode": settings.demo_mode}


def parse_peers(raw: str | None = None) -> dict[str, dict]:
    """A2A_PEERS -> {name: {"url": ..., "api_key": ...}}. Invalid entries are dropped (logged, never echoed)."""
    raw = get_settings().a2a_peers if raw is None else raw
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log.error("A2A_PEERS is not valid JSON; outbound hand-offs are disabled")
        return {}
    peers = {}
    if not isinstance(data, dict):
        return {}
    for name, value in data.items():
        if isinstance(value, str):
            url, key = value, None
        elif isinstance(value, dict):
            url, key = value.get("url"), value.get("api_key")
        else:
            continue
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            peers[str(name)] = {"url": url, "api_key": key if isinstance(key, str) else None}
    return peers


def storage_writable() -> tuple[bool, str]:
    root = Path(get_settings().upload_root_dir)
    try:
        root.mkdir(parents=True, exist_ok=True)
        probe = root / f".ready-{uuid4().hex}"
        probe.write_bytes(b"ok")
        probe.unlink()
        return True, "Upload directory is writable."
    except OSError as exc:
        return False, f"Upload directory is not writable ({type(exc).__name__})."


def readiness() -> dict:
    from backend.app.api.deps import auth_status
    from backend.app.database.repository import schema_ok
    from backend.app.services.vision_providers import UNAVAILABLE_MESSAGE, select_provider

    settings = get_settings()
    components = []

    try:
        ok, message = schema_ok()
        components.append({"name": "database", "status": "HEALTHY" if ok else "UNAVAILABLE",
                           "message": "SQLite reachable; schema present." if ok else message})
    except Exception as exc:  # noqa: BLE001 - report, never raise from a probe
        components.append({"name": "database", "status": "UNAVAILABLE", "message": f"Database check failed ({type(exc).__name__})."})

    ok, message = storage_writable()
    components.append({"name": "storage", "status": "HEALTHY" if ok else "UNAVAILABLE", "message": message})

    provider = select_provider(settings)
    available, reason = provider.available()
    if provider.name == "none":
        components.append({"name": "vision_provider", "status": "DEGRADED", "message": UNAVAILABLE_MESSAGE})
    elif not available:
        components.append({"name": "vision_provider", "status": "DEGRADED", "message": f"{provider.name}: {reason}"})
    elif provider.name == "demo":
        components.append({"name": "vision_provider", "status": "HEALTHY",
                           "message": "demo: simulated perception (DEMO_MODE=true); not for real receiving."})
    else:
        components.append({"name": "vision_provider", "status": "HEALTHY", "message": f"{provider.name}: {provider.model}"})

    components.append({"name": "seal_key", "status": "HEALTHY" if settings.seal_key else "DEGRADED",
                       "message": "Seal key configured outside the database." if settings.seal_key else
                       "RECEIVING_SEAL_KEY unset: records use an ephemeral key and stop verifying after restart."})

    auth_state, auth_message = auth_status()
    components.append({"name": "authentication", "status": auth_state, "message": auth_message})

    try:
        from backend.app.services.a2a import agent_card

        agent_card(include_status=False)
        peers = parse_peers()
        components.append({"name": "a2a", "status": "HEALTHY",
                           "message": f"Agent card builds; {len(peers)} peer(s) configured."})
    except Exception as exc:  # noqa: BLE001
        components.append({"name": "a2a", "status": "DEGRADED", "message": f"Agent card failed ({type(exc).__name__})."})

    worst = max((c["status"] for c in components), key=lambda s: ORDER[s])
    return {"status": worst, "checked_at": now_rfc3339(), "components": components}
