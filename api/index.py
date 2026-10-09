"""Vercel serverless entry point for the FastAPI backend."""
import os

# Vercel's filesystem is read-only outside /tmp, and /tmp is not shared between instances.
os.environ.setdefault("DATABASE_URL", "sqlite:////tmp/receiving_manager.db")
os.environ.setdefault("UPLOAD_ROOT_DIR", "/tmp/uploads")
os.environ.setdefault("DEMO_MODE", "true")

# Demo deployments with no RECEIVING_API_KEYS configured fall back to the public example keys from
# .env.example (accepted only in DEMO_MODE). Set real keys in the Vercel project for anything else.
if os.environ["DEMO_MODE"].lower() == "true":
    os.environ.setdefault(
        "RECEIVING_API_KEYS",
        '{"change-me-operator-key":{"organization_id":"org-demo","operator_id":"op-1","role":"operator"},'
        '"change-me-approver-key":{"organization_id":"org-demo","operator_id":"sup-1","role":"approver"}}',
    )

from backend.app.main import app  # noqa: E402,F401
