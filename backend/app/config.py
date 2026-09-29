from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent
DEFAULT_CORS_ORIGINS = (
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)
load_dotenv(PROJECT_ROOT / ".env", override=False)
load_dotenv(BACKEND_DIR / ".env", override=False)


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True, slots=True)
class Settings:
    cache_db: Path
    offline: bool
    request_timeout_seconds: float
    archive_url: str
    forecast_url: str
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS


def get_settings() -> Settings:
    raw_cache_path = os.getenv("SOLAR_CACHE_DB") or os.getenv(
        "SOLAR_CACHE_PATH", "data/weather_cache.sqlite3"
    )
    cache_path = Path(raw_cache_path).expanduser()
    if not cache_path.is_absolute():
        parts = cache_path.parts
        # Root-level .env examples commonly use backend/data/..., while a
        # backend-local .env usually uses data/.... Both remain CWD-independent.
        base = PROJECT_ROOT if parts and parts[0].lower() == "backend" else BACKEND_DIR
        cache_path = (base / cache_path).resolve()
    configured_origins = tuple(
        origin.strip().rstrip("/")
        for origin in os.getenv("CORS_ORIGINS", "").split(",")
        if origin.strip()
    )
    return Settings(
        cache_db=cache_path,
        offline=_env_bool("SOLAR_OFFLINE"),
        request_timeout_seconds=float(os.getenv("SOLAR_HTTP_TIMEOUT", "20")),
        archive_url=os.getenv(
            "OPEN_METEO_ARCHIVE_URL",
            "https://archive-api.open-meteo.com/v1/archive",
        ),
        forecast_url=os.getenv(
            "OPEN_METEO_FORECAST_URL",
            "https://api.open-meteo.com/v1/forecast",
        ),
        cors_origins=configured_origins or DEFAULT_CORS_ORIGINS,
    )
