from __future__ import annotations

from datetime import date, datetime, time, timezone

import pandas as pd
import pvlib
import pytest

from backend.app.models import DataMetadata
from backend.app.weather import WeatherDataset


def make_weather(
    *,
    latitude: float = 47.0,
    longitude: float = 13.0,
    day: date = date(2025, 6, 21),
    timezone_name: str = "Europe/Vienna",
) -> WeatherDataset:
    start = pd.Timestamp(datetime.combine(day, time(hour=1)), tz=timezone_name)
    labels = pd.date_range(start=start, periods=24, freq="1h")
    midpoints = labels - pd.Timedelta(minutes=30)
    site = pvlib.location.Location(
        latitude=latitude,
        longitude=longitude,
        tz=timezone_name,
    )
    clear = site.get_clearsky(midpoints, model="ineichen")
    clear.index = labels
    frame = pd.DataFrame(
        {
            "ghi": clear["ghi"],
            "dni": clear["dni"],
            "dhi": clear["dhi"],
            "temp_air": 20.0,
            "wind_speed": 2.0,
        },
        index=labels,
    )
    return WeatherDataset(
        data=frame,
        metadata=DataMetadata(
            source="test clear sky",
            retrieved_at=datetime.now(timezone.utc),
            resolution="1 hour",
            data_type="test irradiance and weather",
            quality="modeled",
            is_fallback=False,
            location=f"{latitude}, {longitude}",
            timezone=timezone_name,
            observation_start=labels[0].to_pydatetime(),
            observation_end=labels[-1].to_pydatetime(),
        ),
    )


@pytest.fixture
def valid_payload() -> dict:
    return {
        "location": {
            "latitude": 47.0,
            "longitude": 13.0,
            "name": "Test site",
            "timezone": "Europe/Vienna",
        },
        "roofs": [
            {
                "id": "south",
                "name": "South roof",
                "area_m2": 80,
                "tilt_deg": 35,
                "azimuth_deg": 180,
                "coverage_percent": 80,
                "panel_count": 20,
            }
        ],
        "panel": {
            "name": "450 Wp",
            "power_wp": 450,
            "width_m": 1.134,
            "height_m": 1.762,
            "efficiency": 0.22,
            "temperature_coefficient": -0.0035,
        },
        "system_losses_percent": 14,
        "simulation": {"start": "2025-06-21", "end": "2025-06-21"},
    }
