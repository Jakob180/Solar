from __future__ import annotations

import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx
from pydantic import ValidationError

from .models import GeocodingResponse, GeocodingResult


NOMINATIM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)"
PROVIDER_RESULT_LIMIT = 5


class GeocodingUnavailable(RuntimeError):
    """The configured geocoding provider cannot currently be reached."""


class GeocodingUpstreamError(RuntimeError):
    """The provider returned an invalid or unusable response."""


@dataclass(frozen=True, slots=True)
class _CacheEntry:
    results: tuple[GeocodingResult, ...]
    expires_at: float


class GeocodingService:
    """Policy-conscious, submit-only Nominatim forward-geocoding client.

    All external calls are serialized and separated by the configured minimum
    interval. A bounded in-memory TTL cache prevents repeated queries from
    reaching the public service. The frontend must call this only after an
    explicit user submit; this backend intentionally exposes no autocomplete.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        user_agent: str,
        timeout_seconds: float = 8.0,
        min_interval_seconds: float = 1.05,
        cache_ttl_seconds: float = 86_400,
        cache_max_entries: int = 256,
        offline: bool = False,
        client: httpx.Client | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        endpoint = endpoint.strip()
        user_agent = user_agent.strip()
        if not endpoint:
            raise ValueError("Nominatim endpoint must not be empty")
        if not user_agent:
            raise ValueError("Nominatim User-Agent must identify the application")
        self.endpoint = endpoint
        self.user_agent = user_agent
        requested_interval = max(0.0, float(min_interval_seconds))
        is_public_nominatim = (
            urlparse(endpoint).hostname or ""
        ).lower() == "nominatim.openstreetmap.org"
        # The public service has an absolute one-request-per-second ceiling.
        # A self-hosted endpoint may deliberately choose a different limit.
        self.min_interval_seconds = (
            max(1.0, requested_interval)
            if is_public_nominatim
            else requested_interval
        )
        self.cache_ttl_seconds = max(1.0, float(cache_ttl_seconds))
        self.cache_max_entries = max(1, int(cache_max_entries))
        self.offline = bool(offline)
        self.client = client or httpx.Client(timeout=max(1.0, timeout_seconds))
        self._clock = clock
        self._sleeper = sleeper
        self._cache: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._cache_lock = threading.Lock()
        self._provider_lock = threading.Lock()
        self._last_request_started: float | None = None

    def close(self) -> None:
        self.client.close()

    def search(self, query: str, limit: int = PROVIDER_RESULT_LIMIT) -> GeocodingResponse:
        normalized_query = " ".join(query.split())
        if len(normalized_query) < 2:
            raise ValueError("Search query must contain at least two non-space characters")
        if len(normalized_query) > 200:
            raise ValueError("Search query may contain at most 200 characters")
        if not 1 <= limit <= PROVIDER_RESULT_LIMIT:
            raise ValueError("Geocoding limit must be between 1 and 5")
        if self.offline:
            raise GeocodingUnavailable(
                "Geocoding is disabled because SOLAR_OFFLINE is enabled"
            )

        cache_key = normalized_query.casefold()
        cached = self._cache_get(cache_key)
        if cached is not None:
            return self._response(cached[:limit])

        # Serialize cache misses. This both deduplicates concurrent identical
        # searches and enforces Nominatim's application-wide request interval.
        with self._provider_lock:
            cached = self._cache_get(cache_key)
            if cached is not None:
                return self._response(cached[:limit])
            self._wait_for_rate_limit()
            results = self._request(normalized_query)
            self._cache_put(cache_key, results)
            return self._response(results[:limit])

    def _request(self, query: str) -> tuple[GeocodingResult, ...]:
        params = {
            "q": query,
            "format": "jsonv2",
            "addressdetails": "1",
            "limit": str(PROVIDER_RESULT_LIMIT),
        }
        headers = {
            "User-Agent": self.user_agent,
            "Accept": "application/json",
            "Accept-Language": "de,en;q=0.8",
        }
        try:
            response = self.client.get(self.endpoint, params=params, headers=headers)
        except httpx.TimeoutException as exc:
            raise GeocodingUnavailable("Geocoding request timed out") from exc
        except httpx.RequestError as exc:
            raise GeocodingUnavailable("Geocoding provider is unreachable") from exc

        if response.status_code == 429:
            raise GeocodingUnavailable(
                "Geocoding provider rate limit reached; please retry later"
            )
        if response.status_code >= 500:
            raise GeocodingUnavailable(
                f"Geocoding provider is temporarily unavailable ({response.status_code})"
            )
        if response.status_code >= 400:
            raise GeocodingUpstreamError(
                f"Geocoding provider rejected the request ({response.status_code})"
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise GeocodingUpstreamError(
                "Geocoding provider returned invalid JSON"
            ) from exc
        if not isinstance(payload, list):
            raise GeocodingUpstreamError(
                "Geocoding provider returned an unexpected document"
            )

        parsed: list[GeocodingResult] = []
        invalid_items = 0
        for item in payload[:PROVIDER_RESULT_LIMIT]:
            if not isinstance(item, dict):
                invalid_items += 1
                continue
            try:
                parsed.append(self._parse_result(item))
            except (KeyError, TypeError, ValueError, ValidationError):
                invalid_items += 1
        if payload and not parsed and invalid_items:
            raise GeocodingUpstreamError(
                "Geocoding provider returned no valid result objects"
            )
        return tuple(parsed)

    @staticmethod
    def _parse_result(item: dict[str, Any]) -> GeocodingResult:
        display_name = str(item["display_name"]).strip()
        if not display_name:
            raise ValueError("Empty display name")
        latitude = float(item["lat"])
        longitude = float(item["lon"])
        if not math.isfinite(latitude) or not math.isfinite(longitude):
            raise ValueError("Non-finite coordinates")

        osm_type = str(item.get("osm_type") or "").strip().lower()
        osm_id = item.get("osm_id")
        place_id = item.get("place_id")
        if osm_type and osm_id is not None:
            result_id = f"{osm_type}:{osm_id}"
        elif place_id is not None:
            result_id = f"place:{place_id}"
        else:
            result_id = f"coordinate:{latitude:.7f},{longitude:.7f}"

        raw_address = item.get("address")
        address = raw_address if isinstance(raw_address, dict) else {}
        short_name = GeocodingService._short_name(item, address, display_name)
        bounding_box = GeocodingService._bounding_box(item.get("boundingbox"))
        result_type = str(item.get("type") or "").strip() or None
        return GeocodingResult(
            id=result_id,
            display_name=display_name,
            short_name=short_name,
            latitude=latitude,
            longitude=longitude,
            type=result_type,
            bounding_box=bounding_box,
        )

    @staticmethod
    def _short_name(
        item: dict[str, Any], address: dict[str, Any], display_name: str
    ) -> str:
        road = next(
            (
                str(address[key]).strip()
                for key in ("road", "pedestrian", "footway", "path")
                if address.get(key)
            ),
            "",
        )
        house_number = str(address.get("house_number") or "").strip()
        if road:
            return " ".join(part for part in (road, house_number) if part)

        raw_name = str(item.get("name") or "").strip()
        if raw_name:
            return raw_name
        for key in (
            "city",
            "town",
            "village",
            "municipality",
            "hamlet",
            "suburb",
            "county",
            "state",
            "country",
        ):
            value = str(address.get(key) or "").strip()
            if value:
                return value
        return display_name.split(",", maxsplit=1)[0].strip() or display_name

    @staticmethod
    def _bounding_box(value: Any) -> tuple[float, float, float, float] | None:
        if not isinstance(value, (list, tuple)) or len(value) != 4:
            return None
        bounds = tuple(float(part) for part in value)
        south, north, west, east = bounds
        if not all(math.isfinite(part) for part in bounds):
            return None
        if not (-90 <= south <= north <= 90):
            return None
        if not (-180 <= west <= 180 and -180 <= east <= 180):
            return None
        return south, north, west, east

    def _wait_for_rate_limit(self) -> None:
        now = self._clock()
        if self._last_request_started is not None:
            remaining = self.min_interval_seconds - (
                now - self._last_request_started
            )
            if remaining > 0:
                self._sleeper(remaining)
        self._last_request_started = self._clock()

    def _cache_get(self, key: str) -> tuple[GeocodingResult, ...] | None:
        now = self._clock()
        with self._cache_lock:
            entry = self._cache.get(key)
            if entry is None:
                return None
            if entry.expires_at <= now:
                del self._cache[key]
                return None
            self._cache.move_to_end(key)
            return entry.results

    def _cache_put(self, key: str, results: tuple[GeocodingResult, ...]) -> None:
        now = self._clock()
        with self._cache_lock:
            expired_keys = [
                cached_key
                for cached_key, entry in self._cache.items()
                if entry.expires_at <= now
            ]
            for expired_key in expired_keys:
                del self._cache[expired_key]
            self._cache[key] = _CacheEntry(
                results=results,
                expires_at=now + self.cache_ttl_seconds,
            )
            self._cache.move_to_end(key)
            while len(self._cache) > self.cache_max_entries:
                self._cache.popitem(last=False)

    @staticmethod
    def _response(results: tuple[GeocodingResult, ...]) -> GeocodingResponse:
        return GeocodingResponse(
            results=list(results),
            attribution=NOMINATIM_ATTRIBUTION,
        )

