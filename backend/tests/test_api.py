from __future__ import annotations

from copy import deepcopy
from datetime import date

from fastapi.testclient import TestClient

from backend.app.main import app, get_weather_service
from backend.app.weather import WeatherUnavailable
from backend.tests.conftest import make_weather


class FakeWeatherService:
    def get_range(self, location, start, end, *, allow_fallback=True):
        return make_weather(
            latitude=location.latitude,
            longitude=location.longitude,
            day=start,
            timezone_name=location.timezone or "UTC",
        )

    def get_current(self, location, *, allow_fallback=True):
        dataset = make_weather(
            latitude=location.latitude,
            longitude=location.longitude,
            day=date(2025, 6, 21),
            timezone_name=location.timezone or "UTC",
        )
        dataset.data = dataset.data.iloc[[12]]
        return dataset


class FailingWeatherService(FakeWeatherService):
    def get_range(self, location, start, end, *, allow_fallback=True):
        raise WeatherUnavailable("provider unavailable and fallback disabled")


def client_for(service):
    app.dependency_overrides[get_weather_service] = lambda: service
    return TestClient(app)


def test_health_endpoint():
    with client_for(FakeWeatherService()) as client:
        response = client.get("/api/health")
    app.dependency_overrides.clear()
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_simulation_endpoint_returns_dashboard_contract(valid_payload):
    with client_for(FakeWeatherService()) as client:
        response = client.post("/api/simulation", json=valid_payload)
    app.dependency_overrides.clear()
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"summary", "time_series", "monthly", "roofs", "solar", "metadata"}
    assert body["summary"]["total_modules"] == 20
    assert body["summary"]["installed_kwp"] == 9
    assert body["summary"]["total_energy_kwh"] > 0
    assert len(body["time_series"]) == 24
    assert body["roofs"][0]["id"] == "south"
    assert body["metadata"]["source"] == "test clear sky"


def test_now_endpoint_accepts_reused_simulation_payload(valid_payload):
    with client_for(FakeWeatherService()) as client:
        response = client.post("/api/now", json=valid_payload)
    app.dependency_overrides.clear()
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["current_power_kw"] > 0
    assert body["total_modules"] == 20
    assert body["irradiance"]["ghi_wm2"] > 0
    assert len(body["roofs"]) == 1


def test_api_returns_422_for_invalid_coordinates_and_area(valid_payload):
    invalid = deepcopy(valid_payload)
    invalid["location"]["latitude"] = 100
    invalid["roofs"][0]["area_m2"] = -2
    with client_for(FakeWeatherService()) as client:
        response = client.post("/api/simulation", json=invalid)
    app.dependency_overrides.clear()
    assert response.status_code == 422
    locations = [tuple(error["loc"]) for error in response.json()["detail"]]
    assert ("body", "location", "latitude") in locations
    assert ("body", "roofs", 0, "area_m2") in locations


def test_weather_failure_without_fallback_is_503(valid_payload):
    payload = deepcopy(valid_payload)
    payload["allow_modeled_fallback"] = False
    with client_for(FailingWeatherService()) as client:
        response = client.post("/api/simulation", json=payload)
    app.dependency_overrides.clear()
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "weather_unavailable"
