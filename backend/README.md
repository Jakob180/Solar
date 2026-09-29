# Solar Potential Backend

Local FastAPI service for physically based PV simulation. It uses Open-Meteo
historical/forecast irradiance when available and marks a deterministic pvlib
clear-sky estimate as a fallback when the provider cannot be reached.

## Install and run

From the project root (Python 3.11 recommended):

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r backend/requirements-dev.txt
python -m uvicorn backend.app.main:app --reload --port 8000
```

Interactive OpenAPI documentation is available at
`http://127.0.0.1:8000/docs`; health checks are served at `/api/health` and
`/health`.

## Endpoints

- `POST /api/simulation`: hourly simulation for an inclusive date range of up
  to 367 days.
- `POST /api/now`: current expected power; an optional `simulation` object is
  accepted and ignored so clients may reuse the same form payload.
- `GET /api/health`: lightweight process health check.

Azimuth follows the navigation convention: 0° north, 90° east, 180° south,
270° west. If `panel_count` is omitted, the service uses
`floor(area × coverage / module area)`. Explicit counts exceeding that limit
are rejected with HTTP 422.

## Calculation model

1. pvlib's NREL solar-position implementation calculates apparent zenith,
   elevation and azimuth.
2. GHI, DNI and DHI are transposed to each roof plane with pvlib's Hay-Davies
   model, including ground-reflected irradiance.
3. Faiman estimates cell temperature from POA irradiance, ambient temperature
   and Open-Meteo's 10 m wind speed (used without height correction).
4. PVWatts DC scales configured nameplate Wp by POA/STC irradiance and the
   temperature coefficient. Module efficiency is used for area plausibility;
   it is not multiplied again because Wp already contains STC efficiency.
5. The configured system-loss percentage is applied once. Shading, snow,
   detailed soiling and inverter clipping are deliberately outside v1.

Open-Meteo hourly radiation is treated as a mean over the preceding interval;
solar geometry is evaluated at the interval midpoint and energy is integrated
over that interval. Results are estimates and are rounded to useful precision.

## Data, cache, and offline behavior

Historical requests use the Open-Meteo Archive API; current/future requests
use the Forecast API. These values are gridded model/reanalysis products rather
than measurements on the roof. Successful payloads are cached in SQLite for 30
days (archive), 30 minutes (forecast), or 10 minutes (current).

Set `SOLAR_OFFLINE=true` to avoid network calls. In offline mode, pvlib's
Ineichen clear-sky model supplies GHI/DNI/DHI and a documented synthetic
temperature/wind profile is used. Every response exposes source, retrieval and
observation times, resolution, timezone, quality, cache and fallback flags,
plus explanatory notes. Set `allow_modeled_fallback=false` in a request to get
HTTP 503 instead of substitute data.

Configuration is read from a root `.env` and then `backend/.env`. See
`.env.example`; no API key is required. `SOLAR_CACHE_PATH` and the legacy
`SOLAR_CACHE_DB` are both supported. `CORS_ORIGINS` accepts a comma-separated
list and defaults to local ports 3000 and 5173 (both `localhost` and
`127.0.0.1`).

## Tests

Tests never require the network:

```powershell
python -m pytest backend/tests
```

They cover validation, panel fitting, latitude and seasonal solar geometry,
sunrise/sunset, roof directions and tilts, Wp/panel scaling, energy integration,
fallback and cache behavior, and all public API routes.
