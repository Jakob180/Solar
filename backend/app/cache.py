from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class CacheEntry:
    payload: dict[str, Any]
    created_at: datetime
    expires_at: datetime


class SQLiteWeatherCache:
    """Small process-safe cache for successful external weather responses."""

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_lock = threading.Lock()
        self._initialized = False

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=10000")
        return connection

    def _initialize(self) -> None:
        if self._initialized:
            return
        with self._init_lock:
            if self._initialized:
                return
            with self._connect() as connection:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS weather_cache (
                        cache_key TEXT PRIMARY KEY,
                        payload TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        expires_at TEXT NOT NULL
                    )
                    """
                )
                connection.execute(
                    "CREATE INDEX IF NOT EXISTS idx_weather_cache_expiry "
                    "ON weather_cache(expires_at)"
                )
            self._initialized = True

    def get(self, key: str) -> CacheEntry | None:
        self._initialize()
        now = datetime.now(timezone.utc)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload, created_at, expires_at FROM weather_cache "
                "WHERE cache_key = ?",
                (key,),
            ).fetchone()
            if row is None:
                return None
            expires_at = datetime.fromisoformat(row["expires_at"])
            if expires_at <= now:
                connection.execute(
                    "DELETE FROM weather_cache WHERE cache_key = ?", (key,)
                )
                return None
            return CacheEntry(
                payload=json.loads(row["payload"]),
                created_at=datetime.fromisoformat(row["created_at"]),
                expires_at=expires_at,
            )

    def set(self, key: str, payload: dict[str, Any], ttl: timedelta) -> None:
        self._initialize()
        now = datetime.now(timezone.utc)
        expires_at = now + ttl
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        )
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO weather_cache(cache_key, payload, created_at, expires_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    payload = excluded.payload,
                    created_at = excluded.created_at,
                    expires_at = excluded.expires_at
                """,
                (key, encoded, now.isoformat(), expires_at.isoformat()),
            )

    def purge_expired(self) -> int:
        self._initialize()
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM weather_cache WHERE expires_at <= ?", (now,)
            )
            return cursor.rowcount

