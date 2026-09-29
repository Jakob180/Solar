from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .cache import SQLiteWeatherCache
from .config import get_settings
from .geocoding import (
    GeocodingService,
    GeocodingUnavailable,
    GeocodingUpstreamError,
)
from .models import (
    GeocodingResponse,
    HealthResponse,
    NowRequest,
    NowResponse,
    SimulationRequest,
    SimulationResponse,
)
from .solar import SolarCalculator
from .weather import WeatherService, WeatherUnavailable


settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.weather_service = WeatherService(
        settings=settings,
        cache=SQLiteWeatherCache(settings.cache_db),
    )
    app.state.geocoding_service = GeocodingService(
        endpoint=settings.nominatim_endpoint,
        user_agent=settings.nominatim_user_agent,
        timeout_seconds=settings.nominatim_timeout_seconds,
        min_interval_seconds=settings.nominatim_min_interval_seconds,
        cache_ttl_seconds=settings.nominatim_cache_ttl_seconds,
        cache_max_entries=settings.nominatim_cache_max_entries,
        offline=settings.offline,
    )
    try:
        yield
    finally:
        app.state.geocoding_service.close()
        app.state.weather_service.close()


app = FastAPI(
    title="Local Solar Potential API",
    version=__version__,
    description=(
        "Local PV simulation using Open-Meteo irradiance, pvlib solar position, "
        "Hay-Davies plane-of-array transposition and Faiman cell temperature, "
        "plus submit-only OpenStreetMap Nominatim place search."
    ),
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

router = APIRouter(prefix="/api")
calculator = SolarCalculator()


def get_weather_service(request: Request) -> WeatherService:
    return request.app.state.weather_service


def get_geocoding_service(request: Request) -> GeocodingService:
    return request.app.state.geocoding_service


@app.exception_handler(WeatherUnavailable)
async def weather_unavailable_handler(
    _request: Request, exc: WeatherUnavailable
) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "detail": {
                "code": "weather_unavailable",
                "message": str(exc),
                "hint": "Enable allow_modeled_fallback or retry when online.",
            }
        },
    )


@app.exception_handler(GeocodingUnavailable)
async def geocoding_unavailable_handler(
    _request: Request, exc: GeocodingUnavailable
) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "detail": {
                "code": "geocoding_unavailable",
                "message": str(exc),
                "hint": "Enter latitude and longitude manually or retry later.",
            }
        },
    )


@app.exception_handler(GeocodingUpstreamError)
async def geocoding_upstream_error_handler(
    _request: Request, exc: GeocodingUpstreamError
) -> JSONResponse:
    return JSONResponse(
        status_code=502,
        content={
            "detail": {
                "code": "geocoding_upstream_error",
                "message": str(exc),
                "hint": "Enter latitude and longitude manually or retry later.",
            }
        },
    )


@router.get("/health", response_model=HealthResponse, tags=["system"])
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="solar-potential-api", version=__version__)


@router.get("/geocode", response_model=GeocodingResponse, tags=["location"])
def geocode(
    q: Annotated[str, Query(min_length=2, max_length=200)],
    limit: Annotated[int, Query(ge=1, le=5)] = 5,
    geocoding_service: GeocodingService = Depends(get_geocoding_service),
) -> GeocodingResponse:
    # This endpoint is intentionally submit-driven. The frontend must not call
    # it for each keypress or use it as an autocomplete source.
    normalized_query = " ".join(q.split())
    if len(normalized_query) < 2:
        raise HTTPException(
            status_code=422,
            detail="Search query must contain at least two non-space characters",
        )
    return geocoding_service.search(normalized_query, limit)


@router.post("/simulation", response_model=SimulationResponse, tags=["solar"])
def create_simulation(
    payload: SimulationRequest,
    weather_service: WeatherService = Depends(get_weather_service),
) -> SimulationResponse:
    weather = weather_service.get_range(
        location=payload.location,
        start=payload.simulation.start,
        end=payload.simulation.end,
        allow_fallback=payload.allow_modeled_fallback,
    )
    return calculator.simulate(payload, weather)


@router.post("/now", response_model=NowResponse, tags=["solar"])
def calculate_now(
    payload: NowRequest,
    weather_service: WeatherService = Depends(get_weather_service),
) -> NowResponse:
    weather = weather_service.get_current(
        location=payload.location,
        allow_fallback=payload.allow_modeled_fallback,
    )
    return calculator.now(payload, weather)


app.include_router(router)


@app.get("/health", response_model=HealthResponse, include_in_schema=False)
def root_health() -> HealthResponse:
    return health()


@app.get("/", include_in_schema=False)
def root() -> dict[str, str]:
    return {
        "service": "Local Solar Potential API",
        "docs": "/docs",
        "health": "/api/health",
    }

