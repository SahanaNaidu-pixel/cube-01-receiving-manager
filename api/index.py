"""Vercel serverless entry point for the FastAPI backend."""
import os

# Vercel's filesystem is read-only outside /tmp, and /tmp is not shared between instances.
os.environ.setdefault("DATABASE_URL", "sqlite:////tmp/receiving_manager.db")
os.environ.setdefault("UPLOAD_ROOT_DIR", "/tmp/uploads")
os.environ.setdefault("DEMO_MODE", "true")

from backend.app.main import app  # noqa: E402,F401
