from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app.config import (
    DEFAULT_NOMINATIM_ENDPOINT,
    DEFAULT_NOMINATIM_USER_AGENT,
    get_settings,
)
from backend.app.geocoding import (
    GeocodingService,
    GeocodingUnavailable,
    GeocodingUpstreamError,
)
from backend.app.main import app, get_geocoding_service
from backend.app.models import GeocodingResponse, GeocodingResult


def provider_result(**overrides):
    value = {
        "place_id": 123,
        "osm_type": "way",
        "osm_id": 456,
        "lat": "47.80949",
        "lon": "13.05501",
        "display_name": "Getreidegasse 9, Salzburg, Österreich",
        "type": "house",
        "boundingbox": ["47.80940", "47.80958", "13.05490", "13.05512"],
        "address": {
            "road": "Getreidegasse",
            "house_number": "9",
            "city": "Salzburg",
            "country": "Österreich",
        },
    }
    value.update(overrides)
    return value


def service_with_handler(
    handler: Callable[[httpx.Request], httpx.Response], **kwargs
) -> GeocodingService:
    kwargs.setdefault("min_interval_seconds", 0)
    return GeocodingService(
        endpoint="https://nominatim.test/search",
        user_agent="SolarBackendTests/1.0 (test@example.invalid)",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        **kwargs,
    )


def test_search_maps_results_sends_policy_headers_and_caches_query():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert request.url.params["q"] == "Salzburg Getreidegasse 9"
        assert request.url.params["format"] == "jsonv2"
        assert request.url.params["addressdetails"] == "1"
        assert request.url.params["limit"] == "5"
        assert request.headers["user-agent"].startswith("SolarBackendTests/1.0")
        return httpx.Response(
            200,
            json=[
                provider_result(),
                provider_result(
                    place_id=999,
                    osm_type="relation",
                    osm_id=62422,
                    display_name="Salzburg, Österreich",
                    address={"city": "Salzburg", "country": "Österreich"},
                    boundingbox=["47.7", "47.9", "12.9", "13.2"],
                    type="administrative",
                ),
            ],
        )

    service = service_with_handler(handler)
    first = service.search(" Salzburg   Getreidegasse 9 ", limit=1)
    second = service.search("salzburg getreidegasse 9", limit=2)
    service.close()

    assert len(calls) == 1
    assert len(first.results) == 1
    assert len(second.results) == 2
    assert first.results[0].id == "way:456"
    assert first.results[0].short_name == "Getreidegasse 9"
    assert first.results[0].latitude == pytest.approx(47.80949)
    assert first.results[0].bounding_box == pytest.approx(
        (47.80940, 47.80958, 13.05490, 13.05512)
    )
    assert second.results[1].short_name == "Salzburg"
    assert "OpenStreetMap" in first.attribution


class FakeClock:
    def __init__(self) -> None:
        self.value = 100.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.value += seconds


def test_distinct_provider_requests_are_serialized_and_rate_limited():
    clock = FakeClock()
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=[])

    service = service_with_handler(
        handler,
        min_interval_seconds=1.05,
        clock=clock,
        sleeper=clock.sleep,
    )
    service.search("Vienna")
    service.search("Salzburg")
    service.close()
    assert calls == 2
    assert clock.sleeps == pytest.approx([1.05])


def test_public_endpoint_cannot_be_configured_above_one_request_per_second():
    service = GeocodingService(
        endpoint="https://nominatim.openstreetmap.org/search",
        user_agent="SolarBackendTests/1.0 (test@example.invalid)",
        min_interval_seconds=0,
        client=httpx.Client(
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(200, json=[])
            )
        ),
    )
    assert service.min_interval_seconds == 1.0
    service.close()


def test_cache_ttl_expiry_causes_a_new_request():
    clock = FakeClock()
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=[])

    service = service_with_handler(
        handler,
        cache_ttl_seconds=60,
        clock=clock,
        sleeper=clock.sleep,
    )
    service.search("Vienna")
    service.search("Vienna")
    clock.value += 61
    service.search("Vienna")
    service.close()
    assert calls == 2


@pytest.mark.parametrize("status", [429, 500, 503])
def test_rate_limit_and_server_errors_become_503_service_errors(status):
    service = service_with_handler(
        lambda _request: httpx.Response(status, json={"error": "unavailable"})
    )
    with pytest.raises(GeocodingUnavailable):
        service.search("Vienna")
    service.close()


def test_timeout_becomes_unavailable_without_retry():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("too slow", request=request)

    service = service_with_handler(handler)
    with pytest.raises(GeocodingUnavailable, match="timed out"):
        service.search("Vienna")
    service.close()
    assert calls == 1


def test_offline_mode_never_attempts_a_geocoding_request():
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=[])

    service = service_with_handler(handler, offline=True)
    with pytest.raises(GeocodingUnavailable, match="SOLAR_OFFLINE"):
        service.search("Vienna")
    service.close()
    assert calls == 0


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(400, json={"error": "bad request"}),
        httpx.Response(200, text="not-json"),
        httpx.Response(200, json={"unexpected": "object"}),
        httpx.Response(200, json=[{"lat": "invalid"}]),
    ],
)
def test_invalid_provider_responses_become_502_service_errors(response):
    service = service_with_handler(lambda _request: response)
    with pytest.raises(GeocodingUpstreamError):
        service.search("Vienna")
    service.close()


class FakeGeocodingService:
    def search(self, query: str, limit: int = 5) -> GeocodingResponse:
        return GeocodingResponse(
            results=[
                GeocodingResult(
                    id="node:1",
                    display_name=f"{query}, Österreich",
                    short_name=query,
                    latitude=47.8,
                    longitude=13.04,
                    type="city",
                    bounding_box=(47.7, 47.9, 12.9, 13.2),
                )
            ][:limit]
        )


class FailingGeocodingService:
    def __init__(self, error: Exception) -> None:
        self.error = error

    def search(self, query: str, limit: int = 5) -> GeocodingResponse:
        raise self.error


def api_client(service) -> TestClient:
    app.dependency_overrides[get_geocoding_service] = lambda: service
    return TestClient(app)


def test_geocode_api_contract_and_query_validation():
    with api_client(FakeGeocodingService()) as client:
        response = client.get("/api/geocode", params={"q": "Salzburg", "limit": 1})
        blank = client.get("/api/geocode", params={"q": "  ", "limit": 1})
        excessive_limit = client.get(
            "/api/geocode", params={"q": "Salzburg", "limit": 6}
        )
    app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"results", "attribution"}
    assert body["results"][0]["short_name"] == "Salzburg"
    assert body["results"][0]["bounding_box"] == [47.7, 47.9, 12.9, 13.2]
    assert blank.status_code == 422
    assert excessive_limit.status_code == 422


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (GeocodingUnavailable("offline"), 503, "geocoding_unavailable"),
        (GeocodingUpstreamError("invalid response"), 502, "geocoding_upstream_error"),
    ],
)
def test_geocode_api_returns_clear_provider_errors(error, status, code):
    with api_client(FailingGeocodingService(error)) as client:
        response = client.get("/api/geocode", params={"q": "Salzburg"})
    app.dependency_overrides.clear()
    assert response.status_code == status
    assert response.json()["detail"]["code"] == code


def test_nominatim_configuration_is_environment_driven(monkeypatch):
    monkeypatch.setenv("NOMINATIM_ENDPOINT", "https://geo.example.test/search")
    monkeypatch.setenv("NOMINATIM_USER_AGENT", "MySolarTool/2.0 (ops@example.test)")
    monkeypatch.setenv("NOMINATIM_TIMEOUT_SECONDS", "12")
    settings = get_settings()
    assert settings.nominatim_endpoint == "https://geo.example.test/search"
    assert settings.nominatim_user_agent.startswith("MySolarTool/2.0")
    assert settings.nominatim_timeout_seconds == 12

    monkeypatch.setenv("NOMINATIM_ENDPOINT", "")
    monkeypatch.setenv("NOMINATIM_USER_AGENT", "")
    assert get_settings().nominatim_endpoint == DEFAULT_NOMINATIM_ENDPOINT
    assert get_settings().nominatim_user_agent == DEFAULT_NOMINATIM_USER_AGENT
