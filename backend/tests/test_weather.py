from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import httpx
import numpy as np
import pandas as pd
import pytest

from backend.app.cache import SQLiteWeatherCache
from backend.app.config import DEFAULT_CORS_ORIGINS, Settings, get_settings
from backend.app.models import LocationInput
from backend.app.weather import WeatherService, WeatherUnavailable


def settings(tmp_path, *, offline: bool = False) -> Settings:
    return Settings(
        cache_db=tmp_path / "weather.sqlite3",
        offline=offline,
        request_timeout_seconds=1,
        archive_url="https://archive.test/v1/archive",
        forecast_url="https://forecast.test/v1/forecast",
    )


def test_cors_origins_are_read_from_environment(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:9999/, https://example.test")
    assert get_settings().cors_origins == (
        "http://localhost:9999",
        "https://example.test",
    )
    monkeypatch.delenv("CORS_ORIGINS")
    assert get_settings().cors_origins == DEFAULT_CORS_ORIGINS


def test_sqlite_cache_avoids_duplicate_provider_request(tmp_path):
    requested_day = date.today() - timedelta(days=30)
    start = datetime.combine(requested_day, datetime.min.time(), tzinfo=timezone.utc)
    epochs = [int((start + timedelta(hours=i + 1)).timestamp()) for i in range(24)]
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={
                "timezone": "UTC",
                "hourly": {
                    "time": epochs,
                    "shortwave_radiation": [max(0, 700 - abs(12 - i) * 100) for i in range(24)],
                    "direct_normal_irradiance": [max(0, 800 - abs(12 - i) * 110) for i in range(24)],
                    "diffuse_radiation": [50.0] * 24,
                    "temperature_2m": [15.0] * 24,
                    "wind_speed_10m": [2.0] * 24,
                },
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    service = WeatherService(settings(tmp_path), SQLiteWeatherCache(tmp_path / "cache.db"), client)
    location = LocationInput(latitude=47, longitude=13, timezone="UTC")
    first = service.get_range(location, requested_day, requested_day)
    second = service.get_range(location, requested_day, requested_day)
    assert calls == 1
    assert not first.metadata.from_cache
    assert second.metadata.from_cache
    assert len(second.data) == 24


def test_missing_radiation_is_replaced_as_coherent_triplet(tmp_path):
    service = WeatherService(settings(tmp_path))
    location = LocationInput(latitude=47, longitude=13, timezone="UTC")
    index = pd.date_range("2025-06-21 12:00", periods=1, tz="UTC")
    frame = pd.DataFrame(
        {"ghi": [500.0], "dni": [np.nan], "dhi": [100.0], "temp_air": [20], "wind_speed": [2]},
        index=index,
    )
    expected = service._modeled_frame(location, index)
    repaired, count = service._sanitize_and_fill(frame, location)
    assert count == 1
    assert repaired.loc[index[0], ["ghi", "dni", "dhi"]].to_numpy() == pytest.approx(
        expected.loc[index[0], ["ghi", "dni", "dhi"]].to_numpy()
    )
    service.close()


def test_offline_mode_is_explicit_and_can_be_disabled(tmp_path):
    service = WeatherService(settings(tmp_path, offline=True))
    location = LocationInput(latitude=47, longitude=13, timezone="UTC")
    day = date(2025, 6, 21)
    fallback = service.get_range(location, day, day, allow_fallback=True)
    assert fallback.metadata.is_fallback
    assert "clear-sky fallback" in fallback.metadata.source
    with pytest.raises(WeatherUnavailable, match="Offline-Modus"):
        service.get_range(location, day, day, allow_fallback=False)
    service.close()


def test_missing_hour_is_materialized_instead_of_stretched(tmp_path):
    service = WeatherService(settings(tmp_path))
    location = LocationInput(latitude=47, longitude=13, timezone="UTC")
    index = pd.DatetimeIndex(
        [pd.Timestamp("2025-06-21 10:00", tz="UTC"), pd.Timestamp("2025-06-21 12:00", tz="UTC")]
    )
    frame = pd.DataFrame(
        {"ghi": [300, 700], "dni": [400, 800], "dhi": [50, 70], "temp_air": [20, 22], "wind_speed": [2, 2]},
        index=index,
    )
    repaired, missing = service._sanitize_and_fill(frame, location)
    assert len(repaired) == 3
    assert missing == 5
    assert repaired.index[1] == pd.Timestamp("2025-06-21 11:00", tz="UTC")
    service.close()


def test_partial_provider_data_is_rejected_when_fallback_disabled(tmp_path):
    requested_day = date.today() - timedelta(days=30)
    start = datetime.combine(requested_day, datetime.min.time(), tzinfo=timezone.utc)
    epochs = [int((start + timedelta(hours=i + 1)).timestamp()) for i in range(24)]

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "timezone": "UTC",
                "hourly": {
                    "time": epochs,
                    "shortwave_radiation": [None] + [100.0] * 23,
                    "direct_normal_irradiance": [100.0] * 24,
                    "diffuse_radiation": [20.0] * 24,
                    "temperature_2m": [15.0] * 24,
                    "wind_speed_10m": [2.0] * 24,
                },
            },
        )

    service = WeatherService(
        settings(tmp_path),
        SQLiteWeatherCache(tmp_path / "partial-cache.db"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )
    location = LocationInput(latitude=47, longitude=13, timezone="UTC")
    with pytest.raises(WeatherUnavailable, match="incomplete"):
        service.get_range(
            location, requested_day, requested_day, allow_fallback=False
        )
    service.close()


def test_partial_current_data_is_rejected_when_fallback_disabled(tmp_path):
    now_epoch = int(datetime.now(timezone.utc).timestamp())

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "timezone": "UTC",
                "current": {
                    "time": now_epoch,
                    "interval": 900,
                    "shortwave_radiation_instant": 500.0,
                    "direct_normal_irradiance_instant": None,
                    "diffuse_radiation_instant": 100.0,
                    "temperature_2m": 20.0,
                    "wind_speed_10m": 2.0,
                },
            },
        )

    service = WeatherService(
        settings(tmp_path),
        SQLiteWeatherCache(tmp_path / "partial-current-cache.db"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )
    location = LocationInput(latitude=47, longitude=13, timezone="UTC")
    with pytest.raises(WeatherUnavailable, match="unvollst.ndige aktuelle"):
        service.get_current(location, allow_fallback=False)
    service.close()
