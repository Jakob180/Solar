export type PanelCountMode = 'auto' | 'manual';

export interface LocationConfig {
  name: string;
  latitude: number;
  longitude: number;
}

export interface GeocodeResult {
  id: string;
  displayName: string;
  shortName: string;
  latitude: number;
  longitude: number;
  type?: string;
  boundingBox?: [number, number, number, number];
}

export interface GeocodeSearchResponse {
  results: GeocodeResult[];
  attribution: string;
}

export interface RoofConfig {
  id: string;
  name: string;
  areaM2: number;
  tiltDeg: number;
  azimuthDeg: number;
  coveragePercent: number;
  panelCountMode: PanelCountMode;
  manualPanelCount: number;
}

export interface PanelConfig {
  name: string;
  powerWp: number;
  widthM: number;
  heightM: number;
  efficiencyPercent: number;
  temperatureCoefficientPercent: number;
}

export interface PeriodConfig {
  start: string;
  end: string;
  referenceTime: string;
}

export interface SimulationRequest {
  location: {
    name?: string;
    latitude: number;
    longitude: number;
  };
  roofs: Array<{
    id: string;
    name: string;
    area_m2: number;
    tilt_deg: number;
    azimuth_deg: number;
    panel_coverage_percent: number;
    panel_count: number;
  }>;
  panel: {
    name: string;
    power_wp: number;
    width_m: number;
    height_m: number;
    efficiency: number;
    temperature_coefficient: number;
  };
  simulation: {
    start: string;
    end: string;
    reference_time?: string;
  };
  system_loss_percent: number;
}

export interface SimulationSummary {
  totalModules: number;
  installedKwp: number;
  totalEnergyKwh?: number;
  specificYieldKwhPerKwp?: number;
  peakPowerKw?: number;
  currentPowerKw?: number;
  todayEnergyKwh?: number;
  monthEnergyKwh?: number;
  yearEnergyKwh?: number;
}

export interface TimeSeriesPoint {
  timestamp: string;
  powerKw: number;
  energyKwh: number;
  ghiWm2?: number;
  dniWm2?: number;
  dhiWm2?: number;
}

export interface MonthlyPoint {
  month: string;
  energyKwh: number;
}

export interface RoofResult {
  id: string;
  name: string;
  panelCount: number;
  installedKwp: number;
  energyKwh?: number;
  powerKw?: number;
}

export interface SolarResult {
  sunrise?: string;
  sunset?: string;
  dayLengthHours?: number;
  currentElevationDeg?: number;
  currentAzimuthDeg?: number;
}

export interface DataMetadata {
  source: string;
  retrievedAt?: string;
  resolution?: string;
  dataType?: string;
  quality?: string;
  timezone?: string;
  location?: string;
  fromCache?: boolean;
  observationStart?: string;
  observationEnd?: string;
  isFallback: boolean;
  notes?: string;
}

export interface SimulationResponse {
  summary: SimulationSummary;
  timeSeries: TimeSeriesPoint[];
  monthly: MonthlyPoint[];
  roofs: RoofResult[];
  solar: SolarResult;
  metadata: DataMetadata;
}
