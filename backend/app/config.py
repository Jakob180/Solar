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
DEFAULT_NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search"
DEFAULT_NOMINATIM_USER_AGENT = (
    "SolarPotentialLocal/1.0 (local PV simulator; contact: local operator)"
)
load_dotenv(PROJECT_ROOT / ".env", override=False)
load_dotenv(BACKEND_DIR / ".env", override=False)


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_text(name: str, default: str) -> str:
    value = os.getenv(name, "").strip()
    return value or default


@dataclass(frozen=True, slots=True)
class Settings:
    cache_db: Path
    offline: bool
    request_timeout_seconds: float
    archive_url: str
    forecast_url: str
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS
    nominatim_endpoint: str = DEFAULT_NOMINATIM_ENDPOINT
    nominatim_user_agent: str = DEFAULT_NOMINATIM_USER_AGENT
    nominatim_timeout_seconds: float = 8.0
    nominatim_min_interval_seconds: float = 1.05
    nominatim_cache_ttl_seconds: float = 86_400.0
    nominatim_cache_max_entries: int = 256


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
        nominatim_endpoint=_env_text(
            "NOMINATIM_ENDPOINT", DEFAULT_NOMINATIM_ENDPOINT
        ),
        nominatim_user_agent=_env_text(
            "NOMINATIM_USER_AGENT", DEFAULT_NOMINATIM_USER_AGENT
        ),
        nominatim_timeout_seconds=max(
            1.0, min(30.0, float(os.getenv("NOMINATIM_TIMEOUT_SECONDS", "8")))
        ),
        nominatim_min_interval_seconds=max(
            0.0, float(os.getenv("NOMINATIM_MIN_INTERVAL_SECONDS", "1.05"))
        ),
        nominatim_cache_ttl_seconds=max(
            60.0, float(os.getenv("NOMINATIM_CACHE_TTL_SECONDS", "86400"))
        ),
        nominatim_cache_max_entries=max(
            1, min(10_000, int(os.getenv("NOMINATIM_CACHE_MAX_ENTRIES", "256")))
        ),
    )
