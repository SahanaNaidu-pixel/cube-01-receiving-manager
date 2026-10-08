import os
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, Field

REPO_ROOT = Path(__file__).resolve().parents[3]  # parent of backend/
ENV_FILE = REPO_ROOT / ".env"


class Settings(BaseModel):
    app_name: str = "receiving-manager"
    api_key: str = ""
    ai_model: str = "gpt-4o-mini"
    database_url: str = "sqlite:///./receiving_manager.db"
    max_image_size_mb: int = Field(default=10, ge=1)
    upload_max_images: int = Field(default=20, ge=1)
    allowed_image_types: str = "image/jpeg,image/png,image/webp"
    allowed_extensions: str = ".jpg,.jpeg,.png,.webp"
    upload_root_dir: str = "uploads"
    fastapi_host: str = "0.0.0.0"
    fastapi_port: int = 8000
    demo_mode: bool = False
    openai_base_url: str = ""
    cors_allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000"
    ai_timeout_s: float = 45.0
    # JSON: {"<api key>": {"organization_id": "...", "operator_id": "...", "role": "operator|approver"}}
    receiving_api_keys: str = ""
    seal_key: str = ""
    # auto | openai | demo | none (auto: demo if DEMO_MODE, else openai if a key is set, else none)
    vision_provider: str = "auto"
    # fail | review: under review, visible damage gives UNCERTAIN (DAMAGE_REVIEW_REQUIRED) instead of FAIL
    damage_policy: str = "fail"
    # JSON {"prep_manager": "https://.../api/agent/receive"} or {"prep_manager": {"url": "...", "api_key": "..."}}
    a2a_peers: str = ""
    agent_id: str = "receiving_manager"
    app_version: str = "1.0.0"


@lru_cache
def get_settings() -> Settings:
    # Real environment variables win over .env (override=False). RECEIVING_DISABLE_DOTENV=1 skips it (tests).
    if not os.getenv("RECEIVING_DISABLE_DOTENV"):
        try:
            from dotenv import load_dotenv

            load_dotenv(ENV_FILE, override=False)
        except ImportError:
            pass
    return Settings(
        app_name=os.getenv("APP_NAME", "receiving-manager"),
        api_key=os.getenv("AI_API_KEY", "") or os.getenv("OPENAI_API_KEY", ""),
        ai_model=os.getenv("AI_MODEL", os.getenv("OPENAI_MODEL", "gpt-4o-mini")),
        database_url=os.getenv("DATABASE_URL", "sqlite:///./receiving_manager.db"),
        max_image_size_mb=int(os.getenv("MAX_IMAGE_SIZE_MB", "10")),
        upload_max_images=int(os.getenv("UPLOAD_MAX_IMAGES", "20")),
        allowed_image_types=os.getenv("ALLOWED_IMAGE_TYPES", "image/jpeg,image/png,image/webp"),
        allowed_extensions=os.getenv("ALLOWED_EXTENSIONS", ".jpg,.jpeg,.png,.webp"),
        upload_root_dir=os.getenv("UPLOAD_ROOT_DIR", "uploads"),
        fastapi_host=os.getenv("FASTAPI_HOST", "0.0.0.0"),
        fastapi_port=int(os.getenv("FASTAPI_PORT", "8000")),
        demo_mode=str(os.getenv("DEMO_MODE", "false")).lower() == "true",
        openai_base_url=os.getenv("OPENAI_BASE_URL", ""),
        cors_allowed_origins=os.getenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000"),
        ai_timeout_s=float(os.getenv("AI_TIMEOUT_S", "45")),
        receiving_api_keys=os.getenv("RECEIVING_API_KEYS", ""),
        seal_key=os.getenv("RECEIVING_SEAL_KEY", ""),
        vision_provider=(os.getenv("VISION_PROVIDER", "auto") or "auto").strip().lower(),
        damage_policy="review" if (os.getenv("DAMAGE_POLICY", "fail") or "").strip().lower() == "review" else "fail",
        a2a_peers=os.getenv("A2A_PEERS", ""),
        agent_id=(os.getenv("AGENT_ID", "receiving_manager") or "receiving_manager").strip(),
        app_version=os.getenv("APP_VERSION", "1.0.0") or "1.0.0",
    )
