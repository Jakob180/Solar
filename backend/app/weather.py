from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
import numpy as np
import pandas as pd
import pvlib

from .cache import SQLiteWeatherCache
from .config import Settings
from .models import DataMetadata, LocationInput

try:  # timezonefinder is preferred, but the service has a deterministic fallback.
    from timezonefinder import TimezoneFinder
except ImportError:  # pragma: no cover - exercised only in incomplete installations
    TimezoneFinder = None  # type: ignore[assignment,misc]


HOURLY_VARIABLES = (
    "shortwave_radiation",
    "direct_normal_irradiance",
    "diffuse_radiation",
    "temperature_2m",
    "wind_speed_10m",
)
CURRENT_VARIABLES = (
    "shortwave_radiation_instant",
    "direct_normal_irradiance_instant",
    "diffuse_radiation_instant",
    "temperature_2m",
    "wind_speed_10m",
)


class WeatherUnavailable(RuntimeError):
    """Raised when real weather is unavailable and fallback was disabled."""


@dataclass(slots=True)
class WeatherDataset:
    data: pd.DataFrame
    metadata: DataMetadata


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class WeatherService:
    """Open-Meteo client with SQLite caching and an explicit clear-sky fallback."""

    def __init__(
        self,
        settings: Settings,
        cache: SQLiteWeatherCache | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        self.settings = settings
        self.cache = cache or SQLiteWeatherCache(settings.cache_db)
        self.client = client or httpx.Client(
            timeout=settings.request_timeout_seconds,
            headers={"User-Agent": "local-solar-potential/1.0"},
        )
        self._timezone_finder = TimezoneFinder(in_memory=True) if TimezoneFinder else None

    def close(self) -> None:
        self.client.close()

    def timezone_for(self, location: LocationInput) -> tzinfo:
        if location.timezone:
            try:
                return ZoneInfo(location.timezone)
            except ZoneInfoNotFoundError as exc:
                raise ValueError(
                    f"Unknown IANA timezone '{location.timezone}'"
                ) from exc

        if self._timezone_finder is not None:
            timezone_name = self._timezone_finder.timezone_at(
                lat=location.latitude,
                lng=location.longitude,
            )
            if timezone_name:
                return ZoneInfo(timezone_name)

        # Last-resort solar-time approximation. It is intentionally documented in
        # metadata whenever used and avoids making the offline mode unusable.
        offset_hours = max(-12, min(14, round(location.longitude / 15)))
        return timezone(timedelta(hours=offset_hours))

    def get_range(
        self,
        location: LocationInput,
        start: date,
        end: date,
        *,
        allow_fallback: bool = True,
    ) -> WeatherDataset:
        local_tz = self.timezone_for(location)
        today = datetime.now(local_tz).date()
        segments: list[tuple[str, date, date]] = []
        if start < today:
            segments.append(("archive", start, min(end, today - timedelta(days=1))))
        if end >= today:
            segments.append(("forecast", max(start, today), end))

        datasets: list[WeatherDataset] = []
        for kind, segment_start, segment_end in segments:
            if segment_end < segment_start:
                continue
            if self.settings.offline:
                if not allow_fallback:
                    raise WeatherUnavailable("Der Offline-Modus ist aktiviert")
                datasets.append(
                    self._fallback_range(
                        location,
                        segment_start,
                        segment_end,
                        "Der Offline-Modus ist aktiviert (SOLAR_OFFLINE).",
                    )
                )
                continue
            try:
                dataset = self._fetch_range(location, segment_start, segment_end, kind)
                if dataset.metadata.is_fallback and not allow_fallback:
                    raise WeatherUnavailable(
                        "Open-Meteo returned incomplete values and fallback is disabled"
                    )
                datasets.append(dataset)
            except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
                if not allow_fallback:
                    raise WeatherUnavailable(
                        f"Open-Meteo-Daten konnten nicht geladen werden: {exc}"
                    ) from exc
                datasets.append(
                    self._fallback_range(
                        location,
                        segment_start,
                        segment_end,
                        f"Open-Meteo-Anfrage fehlgeschlagen: {exc}",
                    )
                )

        if not datasets:
            # This only occurs for unusual date/tz edge cases.
            if not allow_fallback:
                raise WeatherUnavailable("Es konnte kein Wetterintervall erstellt werden")
            return self._fallback_range(location, start, end, "Kein Providerintervall verfügbar.")
        merged = self._merge(datasets)
        # Radiation values are backward interval means. Keep exactly the
        # intervals whose midpoint belongs to the requested local dates:
        # (start 00:00, end+1 00:00].
        lower = pd.Timestamp(start, tz=merged.data.index.tz)
        upper = pd.Timestamp(end + timedelta(days=1), tz=merged.data.index.tz)
        selected = merged.data.loc[(merged.data.index > lower) & (merged.data.index <= upper)]
        if selected.empty:
            if not allow_fallback:
                raise WeatherUnavailable("Keine Wetterintervalle decken den gewählten Zeitraum ab")
            return self._fallback_range(
                location, start, end, "Provider data did not cover the requested intervals."
            )
        merged.data = selected
        merged.metadata.observation_start = selected.index[0].to_pydatetime()
        merged.metadata.observation_end = selected.index[-1].to_pydatetime()
        return merged

    def get_current(
        self,
        location: LocationInput,
        *,
        allow_fallback: bool = True,
    ) -> WeatherDataset:
        if self.settings.offline:
            if not allow_fallback:
                raise WeatherUnavailable("Der Offline-Modus ist aktiviert")
            return self._fallback_current(location, "Der Offline-Modus ist aktiviert (SOLAR_OFFLINE).")

        params: dict[str, Any] = {
            "latitude": round(location.latitude, 6),
            "longitude": round(location.longitude, 6),
            "current": ",".join(CURRENT_VARIABLES),
            "timezone": location.timezone or "auto",
            "wind_speed_unit": "ms",
            "timeformat": "unixtime",
        }
        try:
            payload, fetched_at, cache_hit = self._request_json(
                self.settings.forecast_url,
                params,
                ttl=timedelta(minutes=10),
            )
            current = payload["current"]
            timezone_name = payload.get("timezone") or location.timezone or "UTC"
            timestamp = self._localized_index([current["time"]], timezone_name)
            frame = pd.DataFrame(
                {
                    "ghi": [
                        current.get(
                            "shortwave_radiation_instant",
                            current.get("shortwave_radiation"),
                        )
                    ],
                    "dni": [
                        current.get(
                            "direct_normal_irradiance_instant",
                            current.get("direct_normal_irradiance"),
                        )
                    ],
                    "dhi": [
                        current.get(
                            "diffuse_radiation_instant",
                            current.get("diffuse_radiation"),
                        )
                    ],
                    "temp_air": [current.get("temperature_2m")],
                    "wind_speed": [current.get("wind_speed_10m")],
                },
                index=timestamp,
                dtype=float,
            )
            frame, missing_count = self._sanitize_and_fill(
                frame, location, interval_midpoint=False
            )
            if missing_count and not allow_fallback:
                raise WeatherUnavailable(
                    "Open-Meteo lieferte unvollständige aktuelle Werte und der Fallback ist deaktiviert"
                )
            interval_seconds = int(current.get("interval") or 900)
            notes = [
                "Open-Meteo liefert numerische Wettermodelldaten, keine Messung direkt am Gebäude."
            ]
            is_fallback = missing_count > 0
            if missing_count:
                notes.append(
                    f"{missing_count} fehlende aktuelle Werte wurden durch das Clear-Sky-Modell ersetzt."
                )
            if cache_hit:
                notes.append("Aus dem lokalen SQLite-Cache geladen.")
            return WeatherDataset(
                data=frame,
                metadata=DataMetadata(
                    source="Open-Meteo Forecast API",
                    retrieved_at=fetched_at,
                    resolution=f"{max(1, interval_seconds // 60)} Minuten",
                    data_type="Aktuelle Einstrahlung und Wettermodell",
                    quality="mixed" if is_fallback else "modeled",
                    is_fallback=is_fallback,
                    from_cache=cache_hit,
                    location=f"{location.latitude:.6f}, {location.longitude:.6f}",
                    timezone=str(timestamp.tz),
                    observation_start=timestamp[0].to_pydatetime(),
                    observation_end=timestamp[-1].to_pydatetime(),
                    notes=notes,
                ),
            )
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
            if not allow_fallback:
                raise WeatherUnavailable(
                    f"Aktuelle Open-Meteo-Daten konnten nicht geladen werden: {exc}"
                ) from exc
            return self._fallback_current(location, f"Open-Meteo-Anfrage fehlgeschlagen: {exc}")

    def _fetch_range(
        self,
        location: LocationInput,
        start: date,
        end: date,
        kind: str,
    ) -> WeatherDataset:
        url = self.settings.archive_url if kind == "archive" else self.settings.forecast_url
        params: dict[str, Any] = {
            "latitude": round(location.latitude, 6),
            "longitude": round(location.longitude, 6),
            "start_date": start.isoformat(),
            # One boundary value from the following date is required because
            # radiation is a mean over the interval ending at its timestamp.
            "end_date": (end + timedelta(days=1)).isoformat(),
            "hourly": ",".join(HOURLY_VARIABLES),
            "timezone": location.timezone or "auto",
            "wind_speed_unit": "ms",
            "timeformat": "unixtime",
        }
        ttl = timedelta(days=30) if kind == "archive" else timedelta(minutes=30)
        shortened_request = False
        try:
            payload, fetched_at, cache_hit = self._request_json(url, params, ttl=ttl)
        except (httpx.HTTPError, ValueError):
            # Provider availability can stop at the requested final date. Retry
            # without the one-day boundary and let the explicit modeled repair
            # supply only the missing final interval instead of discarding an
            # otherwise valid historic series.
            params["end_date"] = end.isoformat()
            payload, fetched_at, cache_hit = self._request_json(url, params, ttl=ttl)
            shortened_request = True
        hourly = payload["hourly"]
        timezone_name = payload.get("timezone") or location.timezone or "UTC"
        index = self._localized_index(hourly["time"], timezone_name)
        size = len(index)

        def values(name: str) -> list[Any]:
            raw = hourly.get(name)
            return raw if isinstance(raw, list) and len(raw) == size else [None] * size

        frame = pd.DataFrame(
            {
                "ghi": values("shortwave_radiation"),
                "dni": values("direct_normal_irradiance"),
                "dhi": values("diffuse_radiation"),
                "temp_air": values("temperature_2m"),
                "wind_speed": values("wind_speed_10m"),
            },
            index=index,
        ).apply(pd.to_numeric, errors="coerce")
        if frame.empty:
            raise ValueError("Open-Meteo returned no hourly values")
        wanted_index = pd.date_range(
            start=pd.Timestamp(start, tz=index.tz) + pd.Timedelta(hours=1),
            end=pd.Timestamp(end + timedelta(days=1), tz=index.tz),
            freq="1h",
            inclusive="both",
        )
        frame = frame.reindex(frame.index.union(wanted_index)).sort_index()
        frame, missing_count = self._sanitize_and_fill(
            frame, location, interval_midpoint=True
        )
        source = (
            "Open-Meteo Historical Weather API"
            if kind == "archive"
            else "Open-Meteo Forecast API"
        )
        notes = [
            "Open-Meteo-Historien- und Prognosefelder sind gerasterte Modell- oder "
            "Reanalysedaten, keine Pyranometermessung direkt am Gebäude."
        ]
        is_fallback = missing_count > 0
        if missing_count:
            notes.append(
                f"{missing_count} fehlende Providerwerte wurden durch klar ausgewiesene Modellwerte ergänzt."
            )
        if cache_hit:
            notes.append("Aus dem lokalen SQLite-Cache geladen.")
        if shortened_request:
            notes.append(
                "Der Provider stellte den folgenden Grenztag nicht bereit; nur die fehlenden "
                "Randintervalle wurden durch den ausgewiesenen Fallback ergänzt."
            )
        return WeatherDataset(
            data=frame,
            metadata=DataMetadata(
                source=source,
                retrieved_at=fetched_at,
                resolution="1 Stunde",
                data_type=(
                    "Historische Einstrahlung und Wetterdaten"
                    if kind == "archive"
                    else "Prognostizierte Einstrahlung und Wetterdaten"
                ),
                quality="mixed" if is_fallback else "modeled",
                is_fallback=is_fallback,
                from_cache=cache_hit,
                location=f"{location.latitude:.6f}, {location.longitude:.6f}",
                timezone=str(index.tz),
                observation_start=index[0].to_pydatetime(),
                observation_end=index[-1].to_pydatetime(),
                notes=notes,
            ),
        )

    def _request_json(
        self,
        url: str,
        params: dict[str, Any],
        *,
        ttl: timedelta,
    ) -> tuple[dict[str, Any], datetime, bool]:
        canonical = json.dumps(
            {"url": url, "params": params}, sort_keys=True, separators=(",", ":")
        )
        key = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        cached = self.cache.get(key)
        if cached is not None:
            return cached.payload, cached.created_at, True

        response = self.client.get(url, params=params)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("Open-Meteo returned an invalid JSON document")
        if payload.get("error"):
            raise ValueError(str(payload.get("reason") or "Open-Meteo error"))
        fetched_at = _utc_now()
        self.cache.set(key, payload, ttl)
        return payload, fetched_at, False

    def _fallback_range(
        self,
        location: LocationInput,
        start: date,
        end: date,
        reason: str,
    ) -> WeatherDataset:
        tz = self.timezone_for(location)
        index = pd.date_range(
            start=pd.Timestamp(start, tz=tz) + pd.Timedelta(hours=1),
            end=pd.Timestamp(end + timedelta(days=1), tz=tz),
            freq="1h",
            inclusive="both",
        )
        return WeatherDataset(
            data=self._modeled_frame(location, index, interval_midpoint=True),
            metadata=DataMetadata(
                source="pvlib Ineichen clear-sky fallback",
                retrieved_at=_utc_now(),
                resolution="1 Stunde",
                data_type="Modellierte Einstrahlung und synthetisches Umgebungswetter",
                quality="modeled",
                is_fallback=True,
                location=f"{location.latitude:.6f}, {location.longitude:.6f}",
                timezone=str(index.tz),
                observation_start=index[0].to_pydatetime(),
                observation_end=index[-1].to_pydatetime(),
                notes=[
                    reason,
                    "Das Clear-Sky-Modell enthält keine Bewölkung; der Ertrag kann zu hoch ausfallen.",
                    "Umgebungstemperatur und Wind sind deterministische synthetische Schätzwerte.",
                ],
            ),
        )

    def _fallback_current(self, location: LocationInput, reason: str) -> WeatherDataset:
        tz = self.timezone_for(location)
        now = pd.Timestamp.now(tz=tz).floor("15min")
        return WeatherDataset(
            data=self._modeled_frame(
                location, pd.DatetimeIndex([now]), interval_midpoint=False
            ),
            metadata=DataMetadata(
                source="pvlib Ineichen clear-sky fallback",
                retrieved_at=_utc_now(),
                resolution="Momentanwert (15-Minuten-Zeitstempel)",
                data_type="Modellierte aktuelle Einstrahlung und synthetisches Umgebungswetter",
                quality="modeled",
                is_fallback=True,
                location=f"{location.latitude:.6f}, {location.longitude:.6f}",
                timezone=str(now.tz),
                observation_start=now.to_pydatetime(),
                observation_end=now.to_pydatetime(),
                notes=[
                    reason,
                    "Das Clear-Sky-Modell enthält keine aktuelle Bewölkung.",
                    "Umgebungstemperatur und Wind sind deterministische synthetische Schätzwerte.",
                ],
            ),
        )

    def _modeled_frame(
        self,
        location: LocationInput,
        index: pd.DatetimeIndex,
        *,
        interval_midpoint: bool = True,
    ) -> pd.DataFrame:
        if index.tz is None:
            index = index.tz_localize(self.timezone_for(location))
        evaluation_index = (
            index - pd.Timedelta(minutes=30) if interval_midpoint else index
        )
        site = pvlib.location.Location(
            latitude=location.latitude,
            longitude=location.longitude,
            tz=index.tz,
        )
        clear = site.get_clearsky(evaluation_index, model="ineichen")
        clear.index = index
        day = evaluation_index.dayofyear.to_numpy(dtype=float)
        hour = (
            evaluation_index.hour.to_numpy(dtype=float)
            + evaluation_index.minute.to_numpy(dtype=float) / 60
        )
        seasonal_peak = 200 if location.latitude >= 0 else 18
        seasonal = 11 * np.cos(2 * np.pi * (day - seasonal_peak) / 365.25)
        latitude_baseline = 18 - 0.12 * abs(location.latitude)
        diurnal = 4 * np.cos(2 * np.pi * (hour - 14) / 24)
        return pd.DataFrame(
            {
                "ghi": clear["ghi"].clip(lower=0).fillna(0),
                "dni": clear["dni"].clip(lower=0).fillna(0),
                "dhi": clear["dhi"].clip(lower=0).fillna(0),
                "temp_air": latitude_baseline + seasonal + diurnal,
                "wind_speed": np.full(len(index), 2.0),
            },
            index=index,
            dtype=float,
        )

    def _sanitize_and_fill(
        self,
        frame: pd.DataFrame,
        location: LocationInput,
        *,
        interval_midpoint: bool = True,
    ) -> tuple[pd.DataFrame, int]:
        frame = frame.replace([np.inf, -np.inf], np.nan).sort_index()
        if len(frame.index) > 1:
            # Open-Meteo's requested resolution is hourly. Materialize missing
            # timestamps so they are visible and repaired rather than integrating
            # one sample across a multi-hour hole.
            expected_index = pd.date_range(
                frame.index[0], frame.index[-1], freq="1h", tz=frame.index.tz
            )
            frame = frame.reindex(expected_index)
        missing_count = int(frame.isna().sum().sum())
        if missing_count:
            modeled = self._modeled_frame(
                location, frame.index, interval_midpoint=interval_midpoint
            )
            # GHI/DNI/DHI describe one physical radiation state. Replacing only
            # one component can create an impossible triplet and inflate POA, so
            # any incomplete row receives the full coherent modeled triplet.
            radiation_columns = ["ghi", "dni", "dhi"]
            radiation_gap = frame[radiation_columns].isna().any(axis=1)
            frame.loc[radiation_gap, radiation_columns] = modeled.loc[
                radiation_gap, radiation_columns
            ]
            frame[["temp_air", "wind_speed"]] = frame[
                ["temp_air", "wind_speed"]
            ].fillna(modeled[["temp_air", "wind_speed"]])
        frame[["ghi", "dni", "dhi"]] = frame[["ghi", "dni", "dhi"]].clip(
            lower=0
        )
        frame["wind_speed"] = frame["wind_speed"].clip(lower=0)
        if not np.isfinite(frame.to_numpy(dtype=float)).all():
            raise ValueError("Weather dataset still contains non-finite values after repair")
        return frame.astype(float), missing_count

    @staticmethod
    def _localized_index(values: list[Any], timezone_name: str) -> pd.DatetimeIndex:
        if values and isinstance(values[0], (int, float, np.integer, np.floating)):
            return pd.DatetimeIndex(
                pd.to_datetime(values, unit="s", utc=True, errors="raise")
            ).tz_convert(timezone_name)
        index = pd.DatetimeIndex(pd.to_datetime(values, errors="raise"))
        if index.tz is not None:
            return index.tz_convert(timezone_name)
        try:
            return index.tz_localize(
                timezone_name, ambiguous="infer", nonexistent="shift_forward"
            )
        except (ValueError, TypeError):
            return index.tz_localize(
                timezone_name, ambiguous=True, nonexistent="shift_forward"
            )

    @staticmethod
    def _merge(datasets: list[WeatherDataset]) -> WeatherDataset:
        target_tz = datasets[0].data.index.tz
        frames = []
        for dataset in datasets:
            frame = dataset.data
            if frame.index.tz != target_tz:
                frame = frame.tz_convert(target_tz)
            frames.append(frame)
        combined = pd.concat(frames).sort_index()
        combined = combined[~combined.index.duplicated(keep="last")]

        metadata_items = [item.metadata for item in datasets]
        sources = list(dict.fromkeys(item.source for item in metadata_items))
        fallback = any(item.is_fallback for item in metadata_items)
        qualities = {item.quality for item in metadata_items}
        quality = next(iter(qualities)) if len(qualities) == 1 else "mixed"
        notes = list(
            dict.fromkeys(note for item in metadata_items for note in item.notes)
        )
        return WeatherDataset(
            data=combined,
            metadata=DataMetadata(
                source=" + ".join(sources),
                retrieved_at=max(item.retrieved_at for item in metadata_items),
                resolution="1 hour",
                data_type="irradiance and weather time series",
                quality=quality,  # type: ignore[arg-type]
                is_fallback=fallback,
                from_cache=all(item.from_cache for item in metadata_items),
                location=metadata_items[0].location,
                timezone=str(target_tz),
                observation_start=combined.index[0].to_pydatetime(),
                observation_end=combined.index[-1].to_pydatetime(),
                notes=notes,
            ),
        )

