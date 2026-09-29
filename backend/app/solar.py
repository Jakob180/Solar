from __future__ import annotations

from datetime import date, datetime, time

import numpy as np
import pandas as pd
import pvlib

from .models import (
    CurrentIrradiance,
    MonthlyResult,
    NowRequest,
    NowResponse,
    NowRoofResult,
    RoofInput,
    RoofResult,
    SimulationRequest,
    SimulationResponse,
    SolarResult,
    SummaryResult,
    TimeSeriesPoint,
)
from .weather import WeatherDataset


def _rounded(value: float, digits: int = 3) -> float:
    value = float(value)
    if not np.isfinite(value):
        return 0.0
    return round(value, digits)


def _module_count(roof: RoofInput, module_area_m2: float) -> tuple[int, int]:
    usable_area = roof.area_m2 * roof.panel_coverage_percent / 100
    maximum = int((usable_area + 1e-9) // module_area_m2)
    return (maximum if roof.panel_count is None else roof.panel_count), maximum


def _timestep_hours(index: pd.DatetimeIndex) -> pd.Series:
    if len(index) == 1:
        return pd.Series([0.0], index=index, dtype=float)
    utc_index = index.tz_convert("UTC") if index.tz is not None else index
    previous = utc_index.to_series().shift(1)
    hours = (utc_index.to_series() - previous).dt.total_seconds() / 3600
    positive = hours[(hours > 0) & (hours <= 1.5)]
    typical = float(positive.median()) if not positive.empty else 1.0
    hours.iloc[0] = typical
    hours = hours.where((hours > 0) & (hours <= 1.5), typical)
    hours.index = index
    return hours.astype(float)


class SolarCalculator:
    """pvlib-backed transposition, temperature and nameplate-power model."""

    def simulate(
        self, request: SimulationRequest, weather: WeatherDataset
    ) -> SimulationResponse:
        frame = self._validated_weather(weather.data)
        durations = _timestep_hours(frame.index)
        # Open-Meteo hourly radiation is the mean over the interval ending at
        # its timestamp. Use the interval midpoint for geometry and assign the
        # result back to the provider label for stable API timestamps.
        midpoint_index = pd.DatetimeIndex(
            frame.index - pd.to_timedelta(durations.to_numpy() / 2, unit="h")
        )
        solar_position = self._solar_position(
            midpoint_index, request.location.latitude, request.location.longitude
        )
        solar_position.index = frame.index
        dni_extra = pd.Series(
            np.asarray(pvlib.irradiance.get_extra_radiation(midpoint_index)),
            index=frame.index,
        )
        total_power = pd.Series(0.0, index=frame.index)
        weighted_module_temperature = pd.Series(0.0, index=frame.index)
        temperature_weight = 0
        roof_results: list[RoofResult] = []

        for position, roof in enumerate(request.roofs, start=1):
            count, maximum = _module_count(roof, request.panel.area_m2)
            power, module_temperature = self._roof_power(
                roof=roof,
                panel_count=count,
                panel_power_wp=request.panel.power_wp,
                temperature_coefficient=request.panel.temperature_coefficient,
                loss_fraction=request.system_losses_percent / 100,
                albedo=request.albedo,
                weather=frame,
                solar_position=solar_position,
                dni_extra=dni_extra,
            )
            energy = power * durations
            total_power = total_power.add(power, fill_value=0)
            weighted_module_temperature = weighted_module_temperature.add(
                module_temperature * count, fill_value=0
            )
            temperature_weight += count
            roof_results.append(
                RoofResult(
                    id=roof.id or f"roof-{position}",
                    name=roof.name,
                    panel_count=count,
                    max_panel_count=maximum,
                    pv_area_m2=_rounded(count * request.panel.area_m2, 2),
                    installed_kwp=_rounded(count * request.panel.power_wp / 1000, 3),
                    energy_kwh=_rounded(energy.sum(), 2),
                    peak_power_kw=_rounded(power.max(), 3),
                )
            )

        module_temperature = weighted_module_temperature / max(1, temperature_weight)
        total_energy = total_power * durations
        total_modules = sum(item.panel_count for item in roof_results)
        installed_kwp = total_modules * request.panel.power_wp / 1000
        monthly_energy = total_energy.groupby(midpoint_index.strftime("%Y-%m")).sum()
        today_energy, month_energy, year_energy = self._calendar_summaries(
            total_energy,
            midpoint_index,
            request.simulation.start,
            request.simulation.end,
        )

        metadata = weather.metadata.model_copy(deep=True)
        self._append_model_notes(metadata.notes, request)
        if any(value is None for value in (today_energy, month_energy, year_energy)):
            metadata.notes.append(
                "Kalenderkennzahlen bleiben leer, wenn der gewählte Zeitraum den aktuellen "
                "Tag, Monat oder das laufende Jahr bis heute nicht vollständig abdeckt."
            )

        reference = self._simulation_reference(
            frame.index,
            request.simulation.start,
            request.simulation.end,
            request.simulation.reference_time,
        )
        return SimulationResponse(
            summary=SummaryResult(
                total_modules=total_modules,
                installed_kwp=_rounded(installed_kwp, 3),
                total_energy_kwh=_rounded(total_energy.sum(), 2),
                specific_yield_kwh_per_kwp=_rounded(
                    total_energy.sum() / installed_kwp if installed_kwp else 0, 2
                ),
                peak_power_kw=_rounded(total_power.max(), 3),
                production_today_kwh=(
                    None if today_energy is None else _rounded(today_energy, 2)
                ),
                production_month_kwh=(
                    None if month_energy is None else _rounded(month_energy, 2)
                ),
                production_year_kwh=(
                    None if year_energy is None else _rounded(year_energy, 2)
                ),
            ),
            time_series=[
                TimeSeriesPoint(
                    timestamp=timestamp.to_pydatetime(),
                    power_kw=_rounded(total_power.loc[timestamp], 3),
                    energy_kwh=_rounded(total_energy.loc[timestamp], 3),
                    ghi_wm2=_rounded(frame.at[timestamp, "ghi"], 1),
                    dni_wm2=_rounded(frame.at[timestamp, "dni"], 1),
                    dhi_wm2=_rounded(frame.at[timestamp, "dhi"], 1),
                    ambient_temperature_c=_rounded(frame.at[timestamp, "temp_air"], 1),
                    module_temperature_c=_rounded(module_temperature.loc[timestamp], 1),
                )
                for timestamp in frame.index
            ],
            monthly=[
                MonthlyResult(month=str(month), energy_kwh=_rounded(energy, 2))
                for month, energy in monthly_energy.items()
            ],
            roofs=roof_results,
            solar=self._solar_summary(
                reference,
                request.location.latitude,
                request.location.longitude,
            ),
            metadata=metadata,
        )

    def now(self, request: NowRequest, weather: WeatherDataset) -> NowResponse:
        frame = self._validated_weather(weather.data)
        timestamp = frame.index[-1]
        point = frame.loc[[timestamp]]
        solar_position = self._solar_position(
            point.index, request.location.latitude, request.location.longitude
        )
        dni_extra = pd.Series(
            np.asarray(pvlib.irradiance.get_extra_radiation(point.index)),
            index=point.index,
        )
        roof_results: list[NowRoofResult] = []
        total_power = 0.0
        weighted_temperature = 0.0
        total_modules = 0

        for position, roof in enumerate(request.roofs, start=1):
            count, _ = _module_count(roof, request.panel.area_m2)
            power, module_temperature = self._roof_power(
                roof=roof,
                panel_count=count,
                panel_power_wp=request.panel.power_wp,
                temperature_coefficient=request.panel.temperature_coefficient,
                loss_fraction=request.system_losses_percent / 100,
                albedo=request.albedo,
                weather=point,
                solar_position=solar_position,
                dni_extra=dni_extra,
            )
            roof_power = float(power.iloc[0])
            total_power += roof_power
            total_modules += count
            weighted_temperature += float(module_temperature.iloc[0]) * count
            roof_results.append(
                NowRoofResult(
                    id=roof.id or f"roof-{position}",
                    name=roof.name,
                    panel_count=count,
                    installed_kwp=_rounded(count * request.panel.power_wp / 1000, 3),
                    power_kw=_rounded(roof_power, 3),
                )
            )

        metadata = weather.metadata.model_copy(deep=True)
        self._append_model_notes(metadata.notes, request)
        module_temperature = weighted_temperature / max(total_modules, 1)
        return NowResponse(
            timestamp=timestamp.to_pydatetime(),
            current_power_kw=_rounded(total_power, 3),
            total_modules=total_modules,
            installed_kwp=_rounded(total_modules * request.panel.power_wp / 1000, 3),
            irradiance=CurrentIrradiance(
                ghi_wm2=_rounded(point.iloc[0]["ghi"], 1),
                dni_wm2=_rounded(point.iloc[0]["dni"], 1),
                dhi_wm2=_rounded(point.iloc[0]["dhi"], 1),
                ambient_temperature_c=_rounded(point.iloc[0]["temp_air"], 1),
                module_temperature_c=_rounded(module_temperature, 1),
            ),
            roofs=roof_results,
            solar=self._solar_summary(
                timestamp,
                request.location.latitude,
                request.location.longitude,
            ),
            metadata=metadata,
        )

    @staticmethod
    def _validated_weather(frame: pd.DataFrame) -> pd.DataFrame:
        required = {"ghi", "dni", "dhi", "temp_air", "wind_speed"}
        missing = required.difference(frame.columns)
        if missing:
            raise ValueError(f"Weather data is missing columns: {sorted(missing)}")
        if frame.empty:
            raise ValueError("Weather data is empty")
        if not isinstance(frame.index, pd.DatetimeIndex) or frame.index.tz is None:
            raise ValueError("Weather timestamps must be timezone-aware")
        clean = frame.loc[:, sorted(required)].copy().sort_index()
        clean = clean[~clean.index.duplicated(keep="last")]
        if not np.isfinite(clean.to_numpy(dtype=float)).all():
            raise ValueError("Weather data contains NaN or infinite values")
        clean[["ghi", "dni", "dhi", "wind_speed"]] = clean[
            ["ghi", "dni", "dhi", "wind_speed"]
        ].clip(lower=0)
        return clean

    @staticmethod
    def _solar_position(
        index: pd.DatetimeIndex, latitude: float, longitude: float
    ) -> pd.DataFrame:
        return pvlib.solarposition.get_solarposition(
            time=index,
            latitude=latitude,
            longitude=longitude,
            method="nrel_numpy",
        )

    @staticmethod
    def _roof_power(
        *,
        roof: RoofInput,
        panel_count: int,
        panel_power_wp: float,
        temperature_coefficient: float,
        loss_fraction: float,
        albedo: float,
        weather: pd.DataFrame,
        solar_position: pd.DataFrame,
        dni_extra: pd.Series,
    ) -> tuple[pd.Series, pd.Series]:
        poa = pvlib.irradiance.get_total_irradiance(
            surface_tilt=roof.tilt_deg,
            surface_azimuth=roof.azimuth_deg,
            solar_zenith=solar_position["apparent_zenith"],
            solar_azimuth=solar_position["azimuth"],
            dni=weather["dni"],
            ghi=weather["ghi"],
            dhi=weather["dhi"],
            dni_extra=dni_extra,
            albedo=albedo,
            model="haydavies",
        )
        poa_global = (
            pd.Series(poa["poa_global"], index=weather.index)
            .replace([np.inf, -np.inf], np.nan)
            .fillna(0)
            .clip(lower=0)
        )
        cell_temperature = pd.Series(
            pvlib.temperature.faiman(
                poa_global=poa_global,
                temp_air=weather["temp_air"],
                wind_speed=weather["wind_speed"],
            ),
            index=weather.index,
        ).replace([np.inf, -np.inf], np.nan)
        cell_temperature = cell_temperature.fillna(weather["temp_air"])

        # power_wp already contains area and efficiency at STC. Multiplying by
        # efficiency again would double-count it, so efficiency is reserved for
        # fit/plausibility information while pvwatts_dc uses the nameplate basis.
        dc_watts = pvlib.pvsystem.pvwatts_dc(
            poa_global,
            cell_temperature,
            panel_count * panel_power_wp,
            temperature_coefficient,
        )
        power_kw = (
            pd.Series(dc_watts, index=weather.index)
            .replace([np.inf, -np.inf], np.nan)
            .fillna(0)
            .clip(lower=0)
            * (1 - loss_fraction)
            / 1000
        )
        return power_kw, cell_temperature

    @staticmethod
    def _simulation_reference(
        index: pd.DatetimeIndex,
        start: date,
        end: date,
        reference_time: time | None = None,
    ) -> pd.Timestamp:
        tz = index.tz
        if reference_time is not None:
            return pd.Timestamp(datetime.combine(start, reference_time), tz=tz)
        now = pd.Timestamp.now(tz=tz)
        if start <= now.date() <= end:
            return now
        return pd.Timestamp(datetime.combine(start, time(hour=12)), tz=tz)

    def _solar_summary(
        self, timestamp: pd.Timestamp, latitude: float, longitude: float
    ) -> SolarResult:
        position = self._solar_position(
            pd.DatetimeIndex([timestamp]), latitude, longitude
        ).iloc[0]
        sunrise: datetime | None = None
        sunset: datetime | None = None
        day_length: float | None = None
        try:
            events = pvlib.solarposition.sun_rise_set_transit_spa(
                pd.DatetimeIndex([timestamp.normalize()]),
                latitude=latitude,
                longitude=longitude,
                how="numpy",
            ).iloc[0]
            if not pd.isna(events["sunrise"]):
                sunrise = pd.Timestamp(events["sunrise"]).to_pydatetime(warn=False)
            if not pd.isna(events["sunset"]):
                sunset = pd.Timestamp(events["sunset"]).to_pydatetime(warn=False)
            if sunrise is not None and sunset is not None:
                day_length = _rounded((sunset - sunrise).total_seconds() / 3600, 2)
        except (ValueError, OverflowError):
            # Polar-day/night edge cases legitimately have no rise/set value.
            pass
        return SolarResult(
            reference_timestamp=timestamp.to_pydatetime(),
            sunrise=sunrise,
            sunset=sunset,
            day_length_hours=day_length,
            current_elevation_deg=_rounded(position["apparent_elevation"], 2),
            current_azimuth_deg=_rounded(position["azimuth"], 2),
        )

    @staticmethod
    def _calendar_summaries(
        energy: pd.Series,
        interval_midpoints: pd.DatetimeIndex,
        start: date,
        end: date,
    ) -> tuple[float | None, float | None, float | None]:
        now = pd.Timestamp.now(tz=energy.index.tz)
        today = now.date()
        first_month = today.replace(day=1)
        first_year = date(today.year, 1, 1)

        local_dates = pd.Series(interval_midpoints.date, index=energy.index)

        def value_for(period_start: date, period_end: date) -> float | None:
            if start > period_start or end < period_end:
                return None
            mask = (local_dates >= period_start) & (local_dates <= period_end)
            return float(energy.loc[mask.to_numpy()].sum())

        return (
            value_for(today, today),
            value_for(first_month, today),
            value_for(first_year, today),
        )

    @staticmethod
    def _append_model_notes(notes: list[str], request: SimulationRequest | NowRequest) -> None:
        notes.extend(
            [
                "POA-Transposition: pvlib Hay-Davies mit isotroper Bodenreflexion.",
                "Zelltemperatur: pvlib-Faiman-Modell mit Umgebungstemperatur und Wind.",
                "Stündliche Open-Meteo-Strahlung gilt als rückwärts gemittelter Intervallwert; "
                "die Sonnengeometrie wird in der Intervallmitte ausgewertet.",
                "Die 10-m-Windgeschwindigkeit des Providers geht ohne Höhenkorrektur in Faiman ein.",
                "Leistung: Modul-Wp bei STC, skaliert mit POA und Temperatur, danach Systemverluste.",
                "Verschattung, Schnee, detaillierte Verschmutzung und Inverter-Clipping sind in V1 nicht modelliert.",
            ]
        )
        implied_efficiency = request.panel.power_wp / (request.panel.area_m2 * 1000)
        if abs(implied_efficiency - request.panel.efficiency) > 0.02:
            notes.append(
                "Der eingegebene Modulwirkungsgrad weicht vom aus Wp und Fläche abgeleiteten Wert ab; "
                "Wp bleibt maßgeblich, damit der Wirkungsgrad nicht doppelt berücksichtigt wird."
            )

