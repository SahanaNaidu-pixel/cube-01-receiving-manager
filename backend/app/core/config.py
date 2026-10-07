import os
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, Field

REPO_ROOT = Path(__file__).resolve().parents[3]  # parent of backend/
ENV_FILE = REPO_ROOT / ".env"

# AI_PROVIDER presets. "gemini" uses Google's OpenAI-compatible endpoint, so the same SDK and error handling apply.
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
GEMINI_DEFAULT_MODEL = "gemini-2.5-flash"
# "ollama" runs a vision model on this machine: no key, nothing leaves the computer. Local models are slow on CPU,
# so images are smaller, the timeout longer, and slow calls are not retried.
OLLAMA_BASE_URL = "http://localhost:11434/v1"
OLLAMA_DEFAULT_MODEL = "qwen2.5vl:3b"


class Settings(BaseModel):
    app_name: str = "receiving-manager"
    ai_provider: str = "openai"
    # "responses" = OpenAI Responses API; "chat" = chat completions (Gemini and other OpenAI-compatible APIs).
    ai_api_style: str = "responses"
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
    ai_max_retries: int = 2
    ai_image_max_edge: int = 2048
    # JSON: {"<api key>": {"organization_id": "...", "operator_id": "...", "role": "operator|approver"}}
    receiving_api_keys: str = ""
    seal_key: str = ""


@lru_cache
def get_settings() -> Settings:
    # Real environment variables win over .env (override=False). RECEIVING_DISABLE_DOTENV=1 skips it (tests).
    if not os.getenv("RECEIVING_DISABLE_DOTENV"):
        try:
            from dotenv import load_dotenv

            load_dotenv(ENV_FILE, override=False)
        except ImportError:
            pass
    provider = os.getenv("AI_PROVIDER", "openai").strip().lower() or "openai"
    if provider == "ollama":
        ai = {"ai_provider": "ollama", "ai_api_style": "chat", "api_key": os.getenv("OLLAMA_API_KEY", "ollama"),
              "ai_model": os.getenv("OLLAMA_MODEL", OLLAMA_DEFAULT_MODEL),
              "openai_base_url": os.getenv("OLLAMA_BASE_URL", OLLAMA_BASE_URL),
              "ai_timeout_s": float(os.getenv("OLLAMA_TIMEOUT_S", "300")), "ai_max_retries": 0,
              "ai_image_max_edge": int(os.getenv("OLLAMA_IMAGE_MAX_EDGE", "1024"))}
    elif provider == "gemini":
        ai = {"ai_provider": "gemini", "ai_api_style": "chat",
              "api_key": os.getenv("GEMINI_API_KEY", "") or os.getenv("AI_API_KEY", ""),
              "ai_model": os.getenv("GEMINI_MODEL", GEMINI_DEFAULT_MODEL),
              "openai_base_url": os.getenv("GEMINI_BASE_URL", GEMINI_BASE_URL)}
    else:
        ai = {"ai_provider": provider, "ai_api_style": os.getenv("AI_API_STYLE", "responses").strip().lower() or "responses",
              "api_key": os.getenv("AI_API_KEY", "") or os.getenv("OPENAI_API_KEY", ""),
              "ai_model": os.getenv("AI_MODEL", os.getenv("OPENAI_MODEL", "gpt-4o-mini")),
              "openai_base_url": os.getenv("OPENAI_BASE_URL", "")}
    return Settings(
        app_name=os.getenv("APP_NAME", "receiving-manager"),
        **ai,
        database_url=os.getenv("DATABASE_URL", "sqlite:///./receiving_manager.db"),
        max_image_size_mb=int(os.getenv("MAX_IMAGE_SIZE_MB", "10")),
        upload_max_images=int(os.getenv("UPLOAD_MAX_IMAGES", "20")),
        allowed_image_types=os.getenv("ALLOWED_IMAGE_TYPES", "image/jpeg,image/png,image/webp"),
        allowed_extensions=os.getenv("ALLOWED_EXTENSIONS", ".jpg,.jpeg,.png,.webp"),
        upload_root_dir=os.getenv("UPLOAD_ROOT_DIR", "uploads"),
        fastapi_host=os.getenv("FASTAPI_HOST", "0.0.0.0"),
        fastapi_port=int(os.getenv("FASTAPI_PORT", "8000")),
        demo_mode=str(os.getenv("DEMO_MODE", "false")).lower() == "true",
        cors_allowed_origins=os.getenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000"),
        **({} if provider == "ollama" else {"ai_timeout_s": float(os.getenv("AI_TIMEOUT_S", "45"))}),
        receiving_api_keys=os.getenv("RECEIVING_API_KEYS", ""),
        seal_key=os.getenv("RECEIVING_SEAL_KEY", ""),
    )
