import type {
  DataMetadata,
  MonthlyPoint,
  RoofResult,
  SimulationRequest,
  SimulationResponse,
  TimeSeriesPoint,
} from './types';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const record = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

const numberValue = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const optionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const stringValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const firstDefined = (...values: unknown[]): unknown =>
  values.find((value) => value !== undefined && value !== null);

function normalizeTimeSeries(value: unknown): TimeSeriesPoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((point) => ({
      timestamp: stringValue(firstDefined(point.timestamp, point.time, point.datetime)),
      powerKw: numberValue(firstDefined(point.power_kw, point.powerKw, point.power)),
      energyKwh: numberValue(firstDefined(point.energy_kwh, point.energyKwh, point.energy)),
      ghiWm2: optionalNumber(firstDefined(point.ghi_wm2, point.ghi, point.global_irradiance)),
      dniWm2: optionalNumber(firstDefined(point.dni_wm2, point.dni, point.direct_irradiance)),
      dhiWm2: optionalNumber(firstDefined(point.dhi_wm2, point.dhi, point.diffuse_irradiance)),
    }))
    .filter((point) => point.timestamp);
}

function normalizeMonthly(value: unknown): MonthlyPoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((point) => ({
      month: stringValue(firstDefined(point.month, point.label, point.period)),
      energyKwh: numberValue(firstDefined(point.energy_kwh, point.energyKwh, point.energy)),
    }))
    .filter((point) => point.month);
}

function normalizeRoofs(value: unknown): RoofResult[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((roof, index) => ({
    id: stringValue(roof.id, `roof-${index + 1}`),
    name: stringValue(roof.name, `Dachfläche ${index + 1}`),
    panelCount: Math.max(0, Math.round(numberValue(firstDefined(roof.panel_count, roof.panelCount)))),
    installedKwp: numberValue(firstDefined(roof.installed_kwp, roof.installedKwp, roof.kwp)),
    energyKwh: optionalNumber(firstDefined(roof.energy_kwh, roof.energyKwh, roof.energy)),
    powerKw: optionalNumber(firstDefined(roof.power_kw, roof.powerKw, roof.power)),
  }));
}

function deriveMonthly(points: TimeSeriesPoint[]): MonthlyPoint[] {
  const totals = new Map<string, number>();
  points.forEach((point) => {
    const date = new Date(point.timestamp);
    if (Number.isNaN(date.getTime())) return;
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    totals.set(key, (totals.get(key) ?? 0) + point.energyKwh);
  });
  return Array.from(totals, ([month, energyKwh]) => ({ month, energyKwh })).sort((a, b) =>
    a.month.localeCompare(b.month),
  );
}

function normalizeResponse(payload: unknown): SimulationResponse {
  const outer = record(payload);
  const data = record(firstDefined(outer.result, outer.data, outer));
  const summary = record(data.summary);
  const solar = record(firstDefined(data.solar, data.solar_position));
  const rawMetadata = record(firstDefined(data.metadata, data.data_source));
  const rawTimeSeries = firstDefined(data.time_series, data.timeSeries, data.hourly);
  let timeSeries = normalizeTimeSeries(rawTimeSeries);
  const currentIrradiance = record(data.irradiance);
  if (timeSeries.length === 0 && typeof data.timestamp === 'string') {
    timeSeries = [{
      timestamp: data.timestamp,
      powerKw: numberValue(data.current_power_kw),
      energyKwh: 0,
      ghiWm2: optionalNumber(currentIrradiance.ghi_wm2),
      dniWm2: optionalNumber(currentIrradiance.dni_wm2),
      dhiWm2: optionalNumber(currentIrradiance.dhi_wm2),
    }];
  }
  const monthlyFromApi = normalizeMonthly(firstDefined(data.monthly, data.monthly_series, data.monthly_data));

  const metadata: DataMetadata = {
    source: stringValue(firstDefined(rawMetadata.source, data.source), 'Nicht angegeben'),
    retrievedAt: optionalString(firstDefined(rawMetadata.retrieved_at, rawMetadata.timestamp)),
    resolution: optionalString(firstDefined(rawMetadata.resolution, rawMetadata.time_resolution)),
    dataType: optionalString(firstDefined(rawMetadata.data_type, rawMetadata.type)),
    quality: optionalString(firstDefined(rawMetadata.quality, rawMetadata.data_quality)),
    timezone: optionalString(firstDefined(rawMetadata.timezone, data.timezone)),
    location: optionalString(firstDefined(rawMetadata.location, data.location)),
    fromCache: Boolean(firstDefined(rawMetadata.from_cache, rawMetadata.fromCache, false)),
    observationStart: optionalString(firstDefined(rawMetadata.observation_start, rawMetadata.observationStart)),
    observationEnd: optionalString(firstDefined(rawMetadata.observation_end, rawMetadata.observationEnd)),
    isFallback: Boolean(firstDefined(rawMetadata.is_fallback, rawMetadata.fallback, false)),
    notes: Array.isArray(rawMetadata.notes)
      ? rawMetadata.notes.filter((note): note is string => typeof note === 'string').join(' · ') || undefined
      : optionalString(firstDefined(rawMetadata.notes, rawMetadata.note, rawMetadata.message)),
  };

  return {
    summary: {
      totalModules: Math.max(
        0,
        Math.round(numberValue(firstDefined(summary.total_modules, summary.totalModules, data.total_modules))),
      ),
      installedKwp: numberValue(firstDefined(summary.installed_kwp, summary.installedKwp, data.installed_kwp)),
      totalEnergyKwh: optionalNumber(
        firstDefined(summary.total_energy_kwh, summary.totalEnergyKwh, summary.energy_kwh, data.total_energy_kwh),
      ),
      specificYieldKwhPerKwp: optionalNumber(
        firstDefined(
          summary.specific_yield_kwh_per_kwp,
          summary.specificYieldKwhPerKwp,
          summary.specific_yield,
        ),
      ),
      peakPowerKw: optionalNumber(
        firstDefined(summary.peak_power_kw, summary.peakPowerKw, summary.peak_kw, data.current_power_kw),
      ),
      currentPowerKw: optionalNumber(
        firstDefined(summary.current_power_kw, summary.currentPowerKw, data.current_power_kw),
      ),
      todayEnergyKwh: optionalNumber(
        firstDefined(summary.production_today_kwh, summary.today_energy_kwh, summary.todayEnergyKwh),
      ),
      monthEnergyKwh: optionalNumber(
        firstDefined(summary.production_month_kwh, summary.month_energy_kwh, summary.monthEnergyKwh),
      ),
      yearEnergyKwh: optionalNumber(
        firstDefined(summary.production_year_kwh, summary.year_energy_kwh, summary.yearEnergyKwh),
      ),
    },
    timeSeries,
    monthly: monthlyFromApi.length > 0
      ? monthlyFromApi
      : Array.isArray(rawTimeSeries)
        ? deriveMonthly(timeSeries)
        : [],
    roofs: normalizeRoofs(firstDefined(data.roofs, data.roof_results, data.surfaces)),
    solar: {
      sunrise: optionalString(solar.sunrise),
      sunset: optionalString(solar.sunset),
      dayLengthHours: optionalNumber(firstDefined(solar.day_length_hours, solar.dayLengthHours)),
      currentElevationDeg: optionalNumber(
        firstDefined(solar.current_elevation_deg, solar.elevation_deg, solar.elevation),
      ),
      currentAzimuthDeg: optionalNumber(
        firstDefined(solar.current_azimuth_deg, solar.azimuth_deg, solar.azimuth),
      ),
    },
    metadata,
  };
}

async function request(
  endpoint: '/api/simulation' | '/api/now',
  body: SimulationRequest | Omit<SimulationRequest, 'simulation'>,
) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') ?? '';
    const payload: unknown = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      const detail = isRecord(payload)
        ? firstDefined(payload.detail, payload.message, payload.error)
        : payload;
      const nestedDetail = isRecord(detail)
        ? firstDefined(detail.message, detail.hint, detail.code)
        : detail;
      const validationMessages = Array.isArray(detail)
        ? detail
            .filter(isRecord)
            .map((item) => {
              const location = Array.isArray(item.loc)
                ? item.loc.filter((part) => part !== 'body').join(' → ')
                : '';
              const message = stringValue(item.msg);
              return [location, message].filter(Boolean).join(': ');
            })
            .filter(Boolean)
            .join(' · ')
        : '';
      const message = typeof nestedDetail === 'string'
        ? nestedDetail
        : validationMessages || (response.status === 422
          ? 'Einige Eingaben konnten vom Server nicht verarbeitet werden.'
          : `Die Anfrage ist fehlgeschlagen (HTTP ${response.status}).`);
      throw new ApiError(message, response.status);
    }

    return normalizeResponse(payload);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('Die Berechnung hat zu lange gedauert. Bitte Zeitraum verkleinern und erneut versuchen.');
    }
    throw new ApiError(
      'Der lokale Berechnungsdienst ist nicht erreichbar. Läuft das Backend auf Port 8000?',
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

export const runSimulation = (body: SimulationRequest) => request('/api/simulation', body);

export const runNowSimulation = (body: SimulationRequest) => {
  const { simulation: _simulation, ...nowBody } = body;
  return request('/api/now', nowBody);
};
