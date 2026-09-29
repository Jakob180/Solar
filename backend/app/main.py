from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .cache import SQLiteWeatherCache
from .config import get_settings
from .models import (
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
    try:
        yield
    finally:
        app.state.weather_service.close()


app = FastAPI(
    title="Local Solar Potential API",
    version=__version__,
    description=(
        "Local PV simulation using Open-Meteo irradiance, pvlib solar position, "
        "Hay-Davies plane-of-array transposition and Faiman cell temperature."
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


@router.get("/health", response_model=HealthResponse, tags=["system"])
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="solar-potential-api", version=__version__)


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

