from __future__ import annotations

from datetime import date, datetime, time
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
    field_validator,
)


Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class APIModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        allow_inf_nan=False,
        populate_by_name=True,
    )


class LocationInput(APIModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    name: Name | None = None
    timezone: str | None = Field(
        default=None,
        description="Optional IANA timezone, e.g. Europe/Vienna.",
        max_length=80,
    )

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(f"Unknown IANA timezone '{value}'") from exc
        return value


class RoofInput(APIModel):
    id: str | None = Field(default=None, min_length=1, max_length=80)
    name: Name
    area_m2: float = Field(gt=0, le=1_000_000)
    tilt_deg: float = Field(ge=0, le=90)
    azimuth_deg: float = Field(
        ge=0,
        lt=360,
        description="0° north, 90° east, 180° south, 270° west.",
    )
    panel_coverage_percent: float = Field(
        default=100,
        gt=0,
        le=100,
        validation_alias=AliasChoices("panel_coverage_percent", "coverage_percent"),
    )
    panel_count: int | None = Field(
        default=None,
        ge=0,
        le=1_000_000,
        description="If omitted, the maximum fitting count is used.",
    )


class PanelInput(APIModel):
    name: Name = "Standard 450 Wp"
    power_wp: float = Field(default=450, gt=0, le=5_000)
    width_m: float = Field(default=1.134, gt=0, le=20)
    height_m: float = Field(default=1.762, gt=0, le=20)
    efficiency: float = Field(
        default=0.22,
        gt=0,
        le=1,
        description="Module efficiency as a fraction (0.22 = 22%).",
    )
    temperature_coefficient: float = Field(
        default=-0.0035,
        ge=-0.02,
        le=0,
        description="Relative power coefficient per degree Celsius.",
    )

    @property
    def area_m2(self) -> float:
        return self.width_m * self.height_m


class SimulationWindow(APIModel):
    start: date
    end: date
    reference_time: time | None = Field(
        default=None,
        description=(
            "Optional local time used for the displayed solar-position snapshot. "
            "If omitted, current time is used when the range includes today; otherwise noon."
        ),
    )

    @model_validator(mode="after")
    def validate_window(self) -> "SimulationWindow":
        if self.end < self.start:
            raise ValueError("simulation.end must be on or after simulation.start")
        if (self.end - self.start).days > 366:
            raise ValueError("A simulation may span at most 367 inclusive days")
        return self


class SystemInput(APIModel):
    location: LocationInput
    roofs: list[RoofInput] = Field(min_length=1)
    panel: PanelInput
    system_losses_percent: float = Field(
        default=14,
        ge=0,
        lt=100,
        validation_alias=AliasChoices(
            "system_losses_percent",
            "system_loss_percent",
            "loss_percent",
        ),
    )
    albedo: float = Field(default=0.2, ge=0, le=1)
    allow_modeled_fallback: bool = True

    @model_validator(mode="after")
    def validate_roofs_and_capacity(self) -> "SystemInput":
        seen_ids: set[str] = set()
        total_panels = 0
        module_area = self.panel.area_m2
        for position, roof in enumerate(self.roofs, start=1):
            roof_id = roof.id or f"roof-{position}"
            if roof_id in seen_ids:
                raise ValueError(f"Duplicate roof id: {roof_id}")
            seen_ids.add(roof_id)
            usable_area = roof.area_m2 * roof.panel_coverage_percent / 100
            capacity = int((usable_area + 1e-9) // module_area)
            if roof.panel_count is not None and roof.panel_count > capacity:
                raise ValueError(
                    f"Roof '{roof.name}' fits at most {capacity} modules with the "
                    "configured area and coverage"
                )
            total_panels += capacity if roof.panel_count is None else roof.panel_count
        if total_panels < 1:
            raise ValueError("At least one PV module must be installed")
        return self


class SimulationRequest(SystemInput):
    simulation: SimulationWindow


class NowRequest(SystemInput):
    # Accepted for compatibility with clients that reuse the simulation form.
    # The current endpoint deliberately ignores this optional interval.
    simulation: SimulationWindow | None = None


class DataMetadata(APIModel):
    source: str
    retrieved_at: datetime
    resolution: str
    data_type: str
    quality: Literal["observed", "modeled", "mixed", "cached"]
    is_fallback: bool
    from_cache: bool = False
    location: str | None = None
    timezone: str | None = None
    observation_start: datetime | None = None
    observation_end: datetime | None = None
    notes: list[str] = Field(default_factory=list)


class SummaryResult(APIModel):
    total_modules: int
    installed_kwp: float
    total_energy_kwh: float
    specific_yield_kwh_per_kwp: float
    peak_power_kw: float
    production_today_kwh: float | None = None
    production_month_kwh: float | None = None
    production_year_kwh: float | None = None


class TimeSeriesPoint(APIModel):
    timestamp: datetime
    power_kw: float
    energy_kwh: float
    ghi_wm2: float
    dni_wm2: float
    dhi_wm2: float
    ambient_temperature_c: float
    module_temperature_c: float


class MonthlyResult(APIModel):
    month: str
    energy_kwh: float


class RoofResult(APIModel):
    id: str
    name: str
    panel_count: int
    max_panel_count: int
    pv_area_m2: float
    installed_kwp: float
    energy_kwh: float
    peak_power_kw: float


class SolarResult(APIModel):
    reference_timestamp: datetime
    sunrise: datetime | None
    sunset: datetime | None
    day_length_hours: float | None
    current_elevation_deg: float
    current_azimuth_deg: float


class SimulationResponse(APIModel):
    summary: SummaryResult
    time_series: list[TimeSeriesPoint]
    monthly: list[MonthlyResult]
    roofs: list[RoofResult]
    solar: SolarResult
    metadata: DataMetadata


class CurrentIrradiance(APIModel):
    ghi_wm2: float
    dni_wm2: float
    dhi_wm2: float
    ambient_temperature_c: float
    module_temperature_c: float


class NowRoofResult(APIModel):
    id: str
    name: str
    panel_count: int
    installed_kwp: float
    power_kw: float


class NowResponse(APIModel):
    timestamp: datetime
    current_power_kw: float
    total_modules: int
    installed_kwp: float
    irradiance: CurrentIrradiance
    roofs: list[NowRoofResult]
    solar: SolarResult
    metadata: DataMetadata


class HealthResponse(APIModel):
    status: Literal["ok"]
    service: str
    version: str


class GeocodingResult(APIModel):
    id: str
    display_name: str
    short_name: str
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    type: str | None = None
    bounding_box: tuple[float, float, float, float] | None = Field(
        default=None,
        description="South, north, west and east bounds in decimal degrees.",
    )


class GeocodingResponse(APIModel):
    results: list[GeocodingResult]
    attribution: str = "© OpenStreetMap contributors (ODbL)"

