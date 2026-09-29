from __future__ import annotations

from copy import deepcopy
from datetime import date

import numpy as np
import pandas as pd
import pytest

from backend.app.models import SimulationRequest
from backend.app.solar import SolarCalculator, _timestep_hours
from backend.tests.conftest import make_weather


calculator = SolarCalculator()


def simulate(payload: dict, *, day: date = date(2025, 6, 21)):
    payload = deepcopy(payload)
    payload["simulation"] = {
        **payload.get("simulation", {}),
        "start": day.isoformat(),
        "end": day.isoformat(),
    }
    request = SimulationRequest.model_validate(payload)
    weather = make_weather(
        latitude=request.location.latitude,
        longitude=request.location.longitude,
        day=day,
        timezone_name=request.location.timezone or "UTC",
    )
    return calculator.simulate(request, weather)


@pytest.mark.parametrize("azimuth", [0, 90, 180, 270])
def test_cardinal_roof_directions_produce_finite_energy(valid_payload, azimuth):
    payload = deepcopy(valid_payload)
    payload["roofs"][0]["azimuth_deg"] = azimuth
    result = simulate(payload)
    assert result.summary.total_energy_kwh >= 0
    assert np.isfinite(result.summary.total_energy_kwh)


def test_south_facing_roof_outproduces_north_on_clear_day(valid_payload):
    north = deepcopy(valid_payload)
    north["roofs"][0]["azimuth_deg"] = 0
    south = deepcopy(valid_payload)
    south["roofs"][0]["azimuth_deg"] = 180
    assert simulate(south).summary.total_energy_kwh > simulate(north).summary.total_energy_kwh


@pytest.mark.parametrize("tilt", [0, 30, 45, 90])
def test_required_tilts_are_supported(valid_payload, tilt):
    payload = deepcopy(valid_payload)
    payload["roofs"][0]["tilt_deg"] = tilt
    result = simulate(payload)
    assert result.summary.peak_power_kw >= 0
    assert all(np.isfinite(point.power_kw) for point in result.time_series)


def test_panel_count_and_nameplate_power_scale_output(valid_payload):
    one = deepcopy(valid_payload)
    one["roofs"][0]["panel_count"] = 1
    five = deepcopy(valid_payload)
    five["roofs"][0]["panel_count"] = 5
    result_one = simulate(one)
    result_five = simulate(five)
    assert result_five.summary.total_energy_kwh == pytest.approx(
        result_one.summary.total_energy_kwh * 5, abs=0.06
    )

    low_power = deepcopy(valid_payload)
    low_power["panel"]["power_wp"] = 300
    high_power = deepcopy(valid_payload)
    high_power["panel"]["power_wp"] = 600
    assert simulate(high_power).summary.total_energy_kwh == pytest.approx(
        simulate(low_power).summary.total_energy_kwh * 2, abs=0.06
    )


@pytest.mark.parametrize("latitude", [0.0, 47.0, 70.0])
def test_solar_position_is_finite_at_different_latitudes(valid_payload, latitude):
    payload = deepcopy(valid_payload)
    payload["location"].update(
        {"latitude": latitude, "longitude": 0.0, "timezone": "UTC"}
    )
    result = simulate(payload)
    assert -90 <= result.solar.current_elevation_deg <= 90
    assert 0 <= result.solar.current_azimuth_deg <= 360


def test_polar_day_has_no_invalid_sunrise_values(valid_payload):
    payload = deepcopy(valid_payload)
    payload["location"].update(
        {"latitude": 78.2232, "longitude": 15.6469, "timezone": "Europe/Oslo"}
    )

    result = simulate(payload, day=date(2025, 6, 21))

    assert result.solar.sunrise is None
    assert result.solar.sunset is None
    assert np.isfinite(result.solar.current_elevation_deg)


@pytest.mark.parametrize(
    ("day", "expected_hours"),
    [("2025-03-30", 23), ("2025-10-26", 25)],
)
def test_dst_days_integrate_actual_elapsed_hours(day, expected_hours):
    start = pd.Timestamp(day, tz="Europe/Vienna")
    end = start + pd.DateOffset(days=1)
    index = pd.date_range(start, end, freq="1h", inclusive="left")

    assert len(index) == expected_hours
    assert _timestep_hours(index).sum() == pytest.approx(expected_hours)


def test_seasons_and_sunrise_sunset(valid_payload):
    summer = simulate(valid_payload, day=date(2025, 6, 21))
    winter = simulate(valid_payload, day=date(2025, 12, 21))
    assert summer.solar.current_elevation_deg > winter.solar.current_elevation_deg
    assert summer.solar.sunrise is not None
    assert summer.solar.sunset is not None
    assert summer.solar.day_length_hours is not None
    assert 14 < summer.solar.day_length_hours < 17
    assert winter.solar.day_length_hours is not None
    assert 7 < winter.solar.day_length_hours < 10


def test_reference_time_controls_displayed_solar_position(valid_payload):
    payload = deepcopy(valid_payload)
    payload["simulation"]["reference_time"] = "08:30"

    result = simulate(payload)

    assert result.solar.reference_timestamp.hour == 8
    assert result.solar.reference_timestamp.minute == 30


def test_energy_series_integrates_to_summary(valid_payload):
    result = simulate(valid_payload)
    assert sum(point.energy_kwh for point in result.time_series) == pytest.approx(
        result.summary.total_energy_kwh, abs=0.05
    )
    assert result.monthly[0].energy_kwh == pytest.approx(
        result.summary.total_energy_kwh, abs=0.01
    )


def test_hotter_modules_reduce_energy_with_negative_coefficient(valid_payload):
    request = SimulationRequest.model_validate(valid_payload)
    cool = make_weather()
    hot = make_weather()
    cool.data["temp_air"] = 5.0
    hot.data["temp_air"] = 40.0

    cool_result = calculator.simulate(request, cool)
    hot_result = calculator.simulate(request, hot)

    assert hot_result.summary.total_energy_kwh < cool_result.summary.total_energy_kwh


def test_system_losses_reduce_output_monotonically(valid_payload):
    lossless = deepcopy(valid_payload)
    lossless["system_losses_percent"] = 0
    lossy = deepcopy(valid_payload)
    lossy["system_losses_percent"] = 25

    assert simulate(lossy).summary.total_energy_kwh < simulate(
        lossless
    ).summary.total_energy_kwh


def test_zero_irradiance_produces_exactly_zero(valid_payload):
    request = SimulationRequest.model_validate(valid_payload)
    weather = make_weather()
    weather.data[["ghi", "dni", "dhi"]] = 0.0

    result = calculator.simulate(request, weather)

    assert result.summary.total_energy_kwh == 0
    assert result.summary.peak_power_kw == 0
    assert all(point.power_kw == 0 for point in result.time_series)


def test_house_total_equals_sum_of_roofs(valid_payload):
    payload = deepcopy(valid_payload)
    second_roof = deepcopy(payload["roofs"][0])
    second_roof.update({"id": "east", "name": "East roof", "azimuth_deg": 90})
    payload["roofs"].append(second_roof)

    result = simulate(payload)

    assert result.summary.total_energy_kwh == pytest.approx(
        sum(roof.energy_kwh for roof in result.roofs), abs=0.02
    )


def test_calendar_summaries_are_month_to_date_and_year_to_date():
    today = pd.Timestamp.now(tz="UTC").date()
    first_year = date(today.year, 1, 1)
    index = pd.date_range(first_year, today, freq="1D", tz="UTC") + pd.Timedelta(hours=12)
    energy = pd.Series(1.0, index=index)
    today_value, month_value, year_value = calculator._calendar_summaries(
        energy, index, first_year, today
    )
    assert today_value == 1
    assert month_value is not None and month_value >= 1
    assert year_value == len(index)
