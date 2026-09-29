import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock3,
  CloudSun,
  Compass,
  Database,
  Gauge,
  Info,
  Leaf,
  LoaderCircle,
  MapPin,
  PanelsTopLeft,
  Plus,
  Settings2,
  Sparkles,
  Sun,
  Sunrise,
  Sunset,
  Trash2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ApiError, runNowSimulation, runSimulation } from './api';
import { LocationMap } from './components/LocationMap';
import type {
  LocationConfig,
  PanelConfig,
  PeriodConfig,
  RoofConfig,
  SimulationRequest,
  SimulationResponse,
} from './types';

const SolarHouse3D = lazy(async () => {
  const module = await import('./components/SolarHouse3D');
  return { default: module.SolarHouse3D };
});

const numberFormatter = new Intl.NumberFormat('de-AT', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const preciseNumberFormatter = new Intl.NumberFormat('de-AT', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const formatNumber = (value: number | undefined, digits = 1): string => {
  if (value === undefined || !Number.isFinite(value)) return '–';
  return (digits === 2 ? preciseNumberFormatter : numberFormatter).format(value);
};

const toDateInput = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getInitialPeriod = (): PeriodConfig => {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(0, 1);
  return { start: toDateInput(start), end: toDateInput(end), referenceTime: '12:00' };
};

const makeId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `roof-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const createRoof = (index: number, overrides: Partial<RoofConfig> = {}): RoofConfig => ({
  id: makeId(),
  name: `Dachfläche ${index}`,
  areaM2: 60,
  tiltDeg: 35,
  azimuthDeg: 180,
  coveragePercent: 70,
  panelCountMode: 'auto',
  manualPanelCount: 20,
  ...overrides,
});

const initialPanel: PanelConfig = {
  name: 'Monokristallin 450 Wp',
  powerWp: 450,
  widthM: 1.134,
  heightM: 1.762,
  efficiencyPercent: 22,
  temperatureCoefficientPercent: -0.35,
};

const azimuthDirections = [
  { label: 'N', value: 0 },
  { label: 'NO', value: 45 },
  { label: 'O', value: 90 },
  { label: 'SO', value: 135 },
  { label: 'S', value: 180 },
  { label: 'SW', value: 225 },
  { label: 'W', value: 270 },
  { label: 'NW', value: 315 },
];

function getDirection(azimuth: number): string {
  if (!Number.isFinite(azimuth)) return '–';
  const normalized = ((azimuth % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return azimuthDirections[index].label;
}

function getAutoPanelCount(roof: RoofConfig, panel: PanelConfig): number {
  const panelArea = panel.widthM * panel.heightM;
  if (!Number.isFinite(panelArea) || panelArea <= 0) return 0;
  const usableArea = roof.areaM2 * (roof.coveragePercent / 100);
  if (!Number.isFinite(usableArea) || usableArea <= 0) return 0;
  return Math.max(0, Math.floor((usableArea + 1e-9) / panelArea));
}

function getPanelCount(roof: RoofConfig, panel: PanelConfig): number {
  return roof.panelCountMode === 'auto'
    ? getAutoPanelCount(roof, panel)
    : Math.max(0, Math.floor(roof.manualPanelCount));
}

function formatChartTimestamp(timestamp: string, multiDay: boolean, timezone?: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  try {
    return new Intl.DateTimeFormat('de-AT', {
      ...(multiDay ? { day: '2-digit', month: '2-digit' } : {}),
      hour: '2-digit',
      minute: '2-digit',
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(date);
  } catch {
    return timestamp;
  }
}

function formatMonth(month: string): string {
  const match = /^(\d{4})-(\d{1,2})/.exec(month);
  if (!match) return month;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return new Intl.DateTimeFormat('de-AT', { month: 'short', year: '2-digit' }).format(date);
}

function formatDateTime(value?: string, timezone?: string): string {
  if (!value) return 'Nicht angegeben';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat('de-AT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(date);
  } catch {
    return value;
  }
}

function formatSolarTime(value?: string, timezone?: string): string {
  if (!value) return '–';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 5);
  try {
    return new Intl.DateTimeFormat('de-AT', {
      hour: '2-digit',
      minute: '2-digit',
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(date);
  } catch {
    return value.slice(11, 16) || value.slice(0, 5);
  }
}

function formatDataQuality(quality: string | undefined, isFallback: boolean): string {
  if (isFallback) return quality === 'mixed' ? 'Gemischte Modell-/Ersatzwerte' : 'Modellierter Ersatzwert';
  if (quality === 'observed') return 'Messdaten';
  if (quality === 'modeled') return 'Reanalyse-/Modellwert';
  if (quality === 'mixed') return 'Gemischte Datenqualität';
  if (quality === 'cached') return 'Zwischengespeicherter Wert';
  return quality || 'Nicht bewertet';
}

function App() {
  const [location, setLocation] = useState<LocationConfig>({
    name: 'Salzburg',
    latitude: 47.8095,
    longitude: 13.055,
  });
  const [period, setPeriod] = useState<PeriodConfig>(getInitialPeriod);
  const [roofs, setRoofs] = useState<RoofConfig[]>([
    createRoof(1, { name: 'Süddach', areaM2: 80, azimuthDeg: 180 }),
  ]);
  const [panel, setPanel] = useState<PanelConfig>(initialPanel);
  const [systemLossPercent, setSystemLossPercent] = useState(14);
  const [result, setResult] = useState<SimulationResponse | null>(null);
  const [resultConfigurationSignature, setResultConfigurationSignature] = useState<string | null>(null);
  const [loadingMode, setLoadingMode] = useState<'simulation' | 'now' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRunMode, setLastRunMode] = useState<'simulation' | 'now' | null>(null);

  const configuredPanels = useMemo(
    () => roofs.reduce((sum, roof) => sum + getPanelCount(roof, panel), 0),
    [roofs, panel],
  );

  const configuredKwp = (configuredPanels * panel.powerWp) / 1000;
  const configurationSignature = useMemo(
    () => JSON.stringify({ location, period, roofs, panel, systemLossPercent }),
    [location, period, roofs, panel, systemLossPercent],
  );
  const displayedResult = resultConfigurationSignature === configurationSignature ? result : null;
  const visualizedRoof = roofs[0];
  const visualizedPanels = visualizedRoof ? getPanelCount(visualizedRoof, panel) : 0;
  const visualizedKwp = (visualizedPanels * panel.powerWp) / 1000;
  const visualizedPower = visualizedRoof
    ? displayedResult?.roofs.find((roof) => roof.id === visualizedRoof.id)?.powerKw
    : undefined;

  const updateRoof = (id: string, patch: Partial<RoofConfig>) => {
    setRoofs((current) => current.map((roof) => (roof.id === id ? { ...roof, ...patch } : roof)));
  };

  const addRoof = () => {
    setRoofs((current) => [...current, createRoof(current.length + 1)]);
  };

  const removeRoof = (id: string) => {
    setRoofs((current) => current.filter((roof) => roof.id !== id));
  };

  const setDatePreset = (preset: 'today' | '30days' | 'year') => {
    const end = new Date();
    const start = new Date(end);
    if (preset === '30days') start.setDate(start.getDate() - 29);
    if (preset === 'year') start.setMonth(0, 1);
    setPeriod((current) => ({
      ...current,
      start: toDateInput(start),
      end: toDateInput(end),
    }));
  };

  const validate = (): string[] => {
    const issues: string[] = [];
    if (!Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90) {
      issues.push('Der Breitengrad muss zwischen −90° und 90° liegen.');
    }
    if (!Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180) {
      issues.push('Der Längengrad muss zwischen −180° und 180° liegen.');
    }
    if (!period.start || !period.end) issues.push('Start- und Enddatum sind erforderlich.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(period.referenceTime)) {
      issues.push('Die Referenzzeit muss eine gültige Uhrzeit sein.');
    }
    if (period.start && period.end && period.start > period.end) {
      issues.push('Das Startdatum darf nicht nach dem Enddatum liegen.');
    }
    if (period.start && period.end && period.start <= period.end) {
      const startDate = new Date(`${period.start}T00:00:00Z`);
      const endDate = new Date(`${period.end}T00:00:00Z`);
      const inclusiveDays = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
      if (inclusiveDays > 367) {
        issues.push('Ein Simulationslauf darf höchstens 367 Tage umfassen.');
      }
    }
    if (period.start && period.end) {
      const durationDays = Math.round(
        (new Date(`${period.end}T12:00:00`).getTime() - new Date(`${period.start}T12:00:00`).getTime()) / 86_400_000,
      );
      if (durationDays > 366) issues.push('Ein Simulationszeitraum darf höchstens 367 Kalendertage umfassen.');
    }
    if (roofs.length === 0) issues.push('Mindestens eine Dachfläche ist erforderlich.');
    if (!panel.name.trim()) issues.push('Bitte einen Namen für den Modultyp eingeben.');
    if (!Number.isFinite(panel.powerWp) || panel.powerWp <= 0) {
      issues.push('Die Modulleistung muss größer als 0 Wp sein.');
    }
    if (!Number.isFinite(panel.widthM) || panel.widthM <= 0 || !Number.isFinite(panel.heightM) || panel.heightM <= 0) {
      issues.push('Modulbreite und -höhe müssen größer als 0 m sein.');
    }
    if (!Number.isFinite(panel.efficiencyPercent) || panel.efficiencyPercent <= 0 || panel.efficiencyPercent > 100) {
      issues.push('Der Modulwirkungsgrad muss zwischen 0 % und 100 % liegen.');
    }
    if (!Number.isFinite(panel.temperatureCoefficientPercent) || panel.temperatureCoefficientPercent < -2 || panel.temperatureCoefficientPercent > 0) {
      issues.push('Der Temperaturkoeffizient muss zwischen −2 und 0 %/°C liegen.');
    }
    if (!Number.isFinite(systemLossPercent) || systemLossPercent < 0 || systemLossPercent >= 100) {
      issues.push('Die Systemverluste müssen zwischen 0 % und unter 100 % liegen.');
    }

    roofs.forEach((roof, index) => {
      const label = roof.name.trim() || `Dachfläche ${index + 1}`;
      if (!roof.name.trim()) issues.push(`Dachfläche ${index + 1} benötigt einen Namen.`);
      if (!Number.isFinite(roof.areaM2) || roof.areaM2 <= 0) {
        issues.push(`${label}: Die Fläche muss größer als 0 m² sein.`);
      }
      if (!Number.isFinite(roof.tiltDeg) || roof.tiltDeg < 0 || roof.tiltDeg > 90) {
        issues.push(`${label}: Die Neigung muss zwischen 0° und 90° liegen.`);
      }
      if (!Number.isFinite(roof.azimuthDeg) || roof.azimuthDeg < 0 || roof.azimuthDeg >= 360) {
        issues.push(`${label}: Der Azimut muss zwischen 0° und unter 360° liegen.`);
      }
      if (!Number.isFinite(roof.coveragePercent) || roof.coveragePercent <= 0 || roof.coveragePercent > 100) {
        issues.push(`${label}: Die PV-Belegung muss zwischen über 0 % und 100 % liegen.`);
      }
      const capacity = getAutoPanelCount(roof, panel);
      const count = getPanelCount(roof, panel);
      if (capacity < 1) issues.push(`${label}: Auf der belegbaren Fläche findet kein Modul Platz.`);
      if (!Number.isInteger(count) || count < 1) issues.push(`${label}: Die Modulanzahl muss mindestens 1 sein.`);
      if (count > capacity) {
        issues.push(`${label}: ${count} Module überschreiten die rechnerische Kapazität von ${capacity}.`);
      }
    });

    return issues;
  };

  const buildRequest = (forNow: boolean): SimulationRequest => {
    const today = toDateInput(new Date());
    return {
      location: {
        name: location.name.trim() || undefined,
        latitude: location.latitude,
        longitude: location.longitude,
      },
      roofs: roofs.map((roof) => ({
        id: roof.id,
        name: roof.name.trim(),
        area_m2: roof.areaM2,
        tilt_deg: roof.tiltDeg,
        azimuth_deg: roof.azimuthDeg,
        panel_coverage_percent: roof.coveragePercent,
        panel_count: getPanelCount(roof, panel),
      })),
      panel: {
        name: panel.name.trim(),
        power_wp: panel.powerWp,
        width_m: panel.widthM,
        height_m: panel.heightM,
        efficiency: panel.efficiencyPercent / 100,
        temperature_coefficient: panel.temperatureCoefficientPercent / 100,
      },
      simulation: {
        start: forNow ? today : period.start,
        end: forNow ? today : period.end,
        reference_time: period.referenceTime,
      },
      system_loss_percent: systemLossPercent,
    };
  };

  const calculate = async (mode: 'simulation' | 'now') => {
    const issues = validate();
    if (issues.length > 0) {
      setError(issues.slice(0, 5).join(' '));
      document.getElementById('configuration')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    setError(null);
    setLoadingMode(mode);
    try {
      const response =
        mode === 'now'
          ? await runNowSimulation(buildRequest(true))
          : await runSimulation(buildRequest(false));
      setResult(response);
      setResultConfigurationSignature(configurationSignature);
      setLastRunMode(mode);
      window.setTimeout(() => {
        document.getElementById('results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    } catch (requestError) {
      setError(
        requestError instanceof ApiError
          ? requestError.message
          : 'Die Berechnung konnte unerwartet nicht abgeschlossen werden.',
      );
    } finally {
      setLoadingMode(null);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#top" aria-label="Solara Startseite">
            <span className="brand-mark"><Sun size={19} strokeWidth={2.4} /></span>
            <span>solara</span>
          </a>
          <div className="topbar-meta">
            <span className="local-badge"><span className="status-dot" /> Lokal berechnet</span>
            <a href="#configuration" className="topbar-link">Konfiguration</a>
            <a href="#results" className="topbar-link">Ergebnisse</a>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="hero page-width">
          <div className="hero-copy">
            <div className="eyebrow"><Sparkles size={15} /> Solarenergie, nachvollziehbar modelliert</div>
            <h1>Was kann Ihr Dach<br /><span>wirklich leisten?</span></h1>
            <p>
              Simulieren Sie Ihr PV-Potenzial mit Sonnenstand, Dachgeometrie und realen
              Strahlungsdaten – lokal, transparent und ohne versteckte Annahmen.
            </p>
          </div>
          <Suspense
            fallback={(
              <div className="hero-house-model house-model-loading" role="status">
                <LoaderCircle size={22} aria-hidden="true" />
                <span>3D-Modell wird geladen …</span>
              </div>
            )}
          >
            <SolarHouse3D
              className="hero-house-model"
              roofTiltDeg={visualizedRoof?.tiltDeg}
              roofAzimuthDeg={visualizedRoof?.azimuthDeg}
              panelCount={visualizedPanels}
              installedKwp={visualizedKwp}
              currentPowerKw={visualizedPower}
              sunElevationDeg={displayedResult?.solar.currentElevationDeg}
              sunAzimuthDeg={displayedResult?.solar.currentAzimuthDeg}
              locationName={location.name || 'Gewählter Standort'}
              loading={loadingMode !== null}
              hasResult={displayedResult !== null}
            />
          </Suspense>
        </section>

        <section className="workspace page-width">
          <aside id="configuration" className="configuration-column">
            <div className="section-intro">
              <div>
                <span className="section-kicker">Anlage konfigurieren</span>
                <h2>Ihre Parameter</h2>
              </div>
              <span className="config-count">{configuredPanels} Module</span>
            </div>

            {error && (
              <div className="error-banner" role="alert" aria-live="assertive">
                <AlertTriangle size={20} />
                <div><strong>Bitte prüfen</strong><span>{error}</span></div>
              </div>
            )}

            <div className="config-card">
              <ConfigHeading number="01" icon={MapPin} title="Standort" subtitle="Basis für Sonnenstand und Strahlungsdaten" />
              <div className="field-stack">
                <Field label="Standortname" hint="optional">
                  <input
                    value={location.name}
                    onChange={(event) => setLocation({ ...location, name: event.target.value })}
                    placeholder="z. B. Salzburg"
                  />
                </Field>
                <LocationMap
                  latitude={location.latitude}
                  longitude={location.longitude}
                  locationName={location.name}
                  onChange={(latitude, longitude) => {
                    setLocation((current) => ({ ...current, latitude, longitude }));
                  }}
                  onLocationNameChange={(name) => {
                    setLocation((current) => ({ ...current, name }));
                  }}
                />
                <div className="two-column-fields">
                  <Field label="Breitengrad" suffix="°">
                    <CoordinateInput
                      value={location.latitude}
                      min={-90}
                      max={90}
                      label="Breitengrad"
                      onValueChange={(latitude) => setLocation((current) => ({
                        ...current,
                        latitude,
                        name: '',
                      }))}
                    />
                  </Field>
                  <Field label="Längengrad" suffix="°">
                    <CoordinateInput
                      value={location.longitude}
                      min={-180}
                      max={180}
                      label="Längengrad"
                      onValueChange={(longitude) => setLocation((current) => ({
                        ...current,
                        longitude,
                        name: '',
                      }))}
                    />
                  </Field>
                </div>
              </div>
            </div>

            <div className="config-card">
              <ConfigHeading number="02" icon={CalendarDays} title="Zeitraum" subtitle="Historischen Zeitraum frei wählen" />
              <div className="preset-row">
                <button type="button" onClick={() => setDatePreset('today')}>Heute</button>
                <button type="button" onClick={() => setDatePreset('30days')}>30 Tage</button>
                <button type="button" onClick={() => setDatePreset('year')}>Dieses Jahr</button>
              </div>
              <div className="three-column-fields">
                <Field label="Von">
                  <input type="date" value={period.start} onChange={(event) => setPeriod({ ...period, start: event.target.value })} />
                </Field>
                <Field label="Bis">
                  <input type="date" value={period.end} onChange={(event) => setPeriod({ ...period, end: event.target.value })} />
                </Field>
                <Field label="Sonnenstand um" hint="Ortszeit">
                  <input type="time" value={period.referenceTime} onChange={(event) => setPeriod({ ...period, referenceTime: event.target.value })} />
                </Field>
              </div>
            </div>

            <div className="config-card roof-config-card">
              <ConfigHeading number="03" icon={Building2} title="Dachflächen" subtitle="Ausrichtung und nutzbare Fläche" />
              <div className="roof-list">
                {roofs.map((roof, index) => {
                  const capacity = getAutoPanelCount(roof, panel);
                  const selectedCount = getPanelCount(roof, panel);
                  return (
                    <article className="roof-editor" key={roof.id}>
                      <div className="roof-editor-header">
                        <div className="roof-number"><PanelsTopLeft size={16} /> {String(index + 1).padStart(2, '0')}</div>
                        <span className="orientation-badge">{getDirection(roof.azimuthDeg)}</span>
                        {roofs.length > 1 && (
                          <button
                            className="icon-button danger"
                            type="button"
                            onClick={() => removeRoof(roof.id)}
                            aria-label={`${roof.name} entfernen`}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                      <Field label="Bezeichnung">
                        <input value={roof.name} onChange={(event) => updateRoof(roof.id, { name: event.target.value })} />
                      </Field>
                      <div className="three-column-fields">
                        <Field label="Fläche" suffix="m²">
                          <input type="number" min="0.1" step="0.1" value={roof.areaM2} onChange={(event) => updateRoof(roof.id, { areaM2: Number(event.target.value) })} />
                        </Field>
                        <Field label="Neigung" suffix="°">
                          <input type="number" min="0" max="90" step="1" value={roof.tiltDeg} onChange={(event) => updateRoof(roof.id, { tiltDeg: Number(event.target.value) })} />
                        </Field>
                        <Field label="Azimut" suffix="°">
                          <input type="number" min="0" max="359.9" step="1" value={roof.azimuthDeg} onChange={(event) => updateRoof(roof.id, { azimuthDeg: Number(event.target.value) })} />
                        </Field>
                      </div>
                      <div className="direction-picker" aria-label="Dachausrichtung wählen">
                        {azimuthDirections.map((direction) => (
                          <button
                            type="button"
                            key={direction.value}
                            className={Math.abs(roof.azimuthDeg - direction.value) < 0.001 ? 'active' : ''}
                            onClick={() => updateRoof(roof.id, { azimuthDeg: direction.value })}
                            title={`${direction.value}°`}
                          >
                            {direction.label}
                          </button>
                        ))}
                      </div>
                      <div className="range-field">
                        <div className="range-label"><span>PV-Belegung</span><strong>{formatNumber(roof.coveragePercent, 1)} %</strong></div>
                        <input
                          type="range"
                          min="1"
                          max="100"
                          step="1"
                          value={roof.coveragePercent}
                          onChange={(event) => updateRoof(roof.id, { coveragePercent: Number(event.target.value) })}
                        />
                        <div className="range-scale"><span>1 %</span><span>{formatNumber(roof.areaM2 * roof.coveragePercent / 100)} m² nutzbar</span><span>100 %</span></div>
                      </div>
                      <div className="panel-count-box">
                        <div className="mode-switch" role="group" aria-label="Modulanzahl Modus">
                          <button type="button" className={roof.panelCountMode === 'auto' ? 'active' : ''} onClick={() => updateRoof(roof.id, { panelCountMode: 'auto' })}>Automatisch</button>
                          <button
                            type="button"
                            className={roof.panelCountMode === 'manual' ? 'active' : ''}
                            onClick={() => updateRoof(roof.id, { panelCountMode: 'manual', manualPanelCount: selectedCount || capacity })}
                          >Manuell</button>
                        </div>
                        {roof.panelCountMode === 'manual' ? (
                          <Field label="Modulanzahl" suffix={`max. ${capacity}`}>
                            <input
                              type="number"
                              min="1"
                              max={Math.max(1, capacity)}
                              step="1"
                              value={roof.manualPanelCount}
                              onChange={(event) => updateRoof(roof.id, { manualPanelCount: Number(event.target.value) })}
                            />
                          </Field>
                        ) : (
                          <div className="auto-count"><strong>{capacity}</strong><span>Module passen rechnerisch</span></div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              <button className="add-roof-button" type="button" onClick={addRoof}><Plus size={17} /> Dachfläche hinzufügen</button>
            </div>

            <div className="config-card">
              <ConfigHeading number="04" icon={PanelsTopLeft} title="PV-Modul" subtitle="Technische Eigenschaften" />
              <div className="field-stack">
                <Field label="Modultyp">
                  <input value={panel.name} onChange={(event) => setPanel({ ...panel, name: event.target.value })} />
                </Field>
                <div className="two-column-fields">
                  <Field label="Nennleistung" suffix="Wp">
                    <input type="number" min="1" step="1" value={panel.powerWp} onChange={(event) => setPanel({ ...panel, powerWp: Number(event.target.value) })} />
                  </Field>
                  <Field label="Wirkungsgrad" suffix="%">
                    <input type="number" min="0.1" max="100" step="0.1" value={panel.efficiencyPercent} onChange={(event) => setPanel({ ...panel, efficiencyPercent: Number(event.target.value) })} />
                  </Field>
                  <Field label="Breite" suffix="m">
                    <input type="number" min="0.1" step="0.001" value={panel.widthM} onChange={(event) => setPanel({ ...panel, widthM: Number(event.target.value) })} />
                  </Field>
                  <Field label="Höhe" suffix="m">
                    <input type="number" min="0.1" step="0.001" value={panel.heightM} onChange={(event) => setPanel({ ...panel, heightM: Number(event.target.value) })} />
                  </Field>
                </div>
                <Field label="Temperaturkoeffizient" suffix="% / °C">
                  <input type="number" min="-2" max="0" step="0.01" value={panel.temperatureCoefficientPercent} onChange={(event) => setPanel({ ...panel, temperatureCoefficientPercent: Number(event.target.value) })} />
                </Field>
                <div className="technical-note"><Info size={15} /><span>Modulfläche {formatNumber(panel.widthM * panel.heightM, 2)} m² · STC-Leistung {formatNumber(panel.powerWp)} Wp</span></div>
              </div>
            </div>

            <div className="config-card">
              <ConfigHeading number="05" icon={Settings2} title="System" subtitle="Technische Gesamtverluste" />
              <div className="range-field loss-range">
                <div className="range-label"><span>Systemverluste</span><strong>{formatNumber(systemLossPercent)} %</strong></div>
                <input type="range" min="0" max="40" step="0.5" value={systemLossPercent} onChange={(event) => setSystemLossPercent(Number(event.target.value))} />
                <div className="range-scale"><span>0 %</span><span>Wechselrichter, Kabel &amp; Technik</span><span>40 %</span></div>
              </div>
            </div>

            <div className="configuration-actions">
              <div className="configured-system">
                <span>Konfigurierte Anlage</span>
                <strong>{formatNumber(configuredKwp)} kWp <small>· {configuredPanels} Module</small></strong>
              </div>
              <button className="primary-button" type="button" disabled={loadingMode !== null} onClick={() => calculate('simulation')}>
                {loadingMode === 'simulation' ? <LoaderCircle className="spin" size={19} /> : <BarChart3 size={19} />}
                {loadingMode === 'simulation' ? 'Berechnung läuft …' : 'Zeitraum simulieren'}
                {loadingMode !== 'simulation' && <ArrowRight size={18} />}
              </button>
              <button className="secondary-button" type="button" disabled={loadingMode !== null} onClick={() => calculate('now')}>
                {loadingMode === 'now' ? <LoaderCircle className="spin" size={18} /> : <Sun size={18} />}
                {loadingMode === 'now' ? 'Moment wird berechnet …' : 'Jetzt berechnen'}
              </button>
            </div>
          </aside>

          <section id="results" className="results-column" aria-live="polite">
            {displayedResult ? (
              <ResultsDashboard result={displayedResult} mode={lastRunMode} loading={loadingMode !== null} period={period} locationName={location.name} />
            ) : (
              <EmptyResults configuredPanels={configuredPanels} configuredKwp={configuredKwp} onCalculate={() => calculate('simulation')} loading={loadingMode !== null} />
            )}
          </section>
        </section>
      </main>

      <footer className="footer page-width">
        <div className="brand footer-brand"><span className="brand-mark"><Sun size={17} /></span><span>solara</span></div>
        <p>Lokale PV-Simulation · Ergebnisse sind Modellwerte und ersetzen keine Anlagenplanung.</p>
        <span>Anlagen- und Ergebnisdaten bleiben lokal · Wetter-, Karten- und explizite Suchanfragen nutzen externe Dienste.</span>
      </footer>
    </div>
  );
}

function ConfigHeading({ number, icon: Icon, title, subtitle }: { number: string; icon: LucideIcon; title: string; subtitle: string }) {
  return (
    <div className="config-heading">
      <div className="config-icon"><Icon size={18} /></div>
      <div><div className="config-title-row"><span>{number}</span><h3>{title}</h3></div><p>{subtitle}</p></div>
    </div>
  );
}

function Field({ label, hint, suffix, children }: { label: string; hint?: string; suffix?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}{hint && <em>{hint}</em>}</span>
      <span className="input-wrap">{children}{suffix && <span className="input-suffix">{suffix}</span>}</span>
    </label>
  );
}

function CoordinateInput({
  value,
  min,
  max,
  label,
  onValueChange,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onValueChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(() => String(value));

  useEffect(() => {
    setDraft(Number.isFinite(value) ? String(value) : '');
  }, [value]);

  const parseDraft = (nextDraft: string): number | null => {
    const normalized = nextDraft.trim().replace(',', '.');
    if (!normalized || normalized === '-' || /[.,]$/.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
  };

  const commit = () => {
    const parsed = parseDraft(draft);
    if (parsed === null) {
      setDraft(String(value));
      return;
    }
    setDraft(String(parsed));
    if (parsed !== value) onValueChange(parsed);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      aria-label={label}
      onChange={(event) => {
        const nextDraft = event.target.value;
        setDraft(nextDraft);
        const parsed = parseDraft(nextDraft);
        if (parsed !== null && parsed !== value) onValueChange(parsed);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(String(value));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function KpiCard({ icon: Icon, label, value, unit, accent = false, detail }: { icon: LucideIcon; label: string; value: string; unit: string; accent?: boolean; detail?: string }) {
  return (
    <div className={`kpi-card${accent ? ' accent' : ''}`}>
      <div className="kpi-top"><span className="kpi-icon"><Icon size={18} /></span><span>{label}</span></div>
      <div className="kpi-value">{value}<small>{unit}</small></div>
      {detail && <span className="kpi-detail">{detail}</span>}
    </div>
  );
}

function EmptyResults({ configuredPanels, configuredKwp, onCalculate, loading }: { configuredPanels: number; configuredKwp: number; onCalculate: () => void; loading: boolean }) {
  return (
    <div className="empty-results">
      <div className="empty-visual" aria-hidden="true">
        <div className="empty-rays" />
        <Sun size={55} strokeWidth={1.25} />
        <div className="empty-roof"><span /><span /><span /><span /></div>
      </div>
      <span className="section-kicker">Bereit für die Simulation</span>
      <h2>Aus Parametern wird<br />ein Energieprofil.</h2>
      <p>Prüfen Sie links Ihre Anlage und starten Sie die physikalische Berechnung. Strahlungsquelle und Modellqualität werden mit jedem Ergebnis ausgewiesen.</p>
      <div className="empty-config-summary">
        <div><span>Module</span><strong>{configuredPanels}</strong></div>
        <div><span>Leistung</span><strong>{formatNumber(configuredKwp)} kWp</strong></div>
        <div><span>Daten</span><strong>transparent</strong></div>
      </div>
      <button className="primary-button empty-button" type="button" disabled={loading} onClick={onCalculate}>
        {loading ? <LoaderCircle className="spin" size={19} /> : <BarChart3 size={19} />}
        Simulation starten
      </button>
      <div className="model-steps">
        <span><CheckCircle2 size={14} /> Sonnenposition</span>
        <span><CheckCircle2 size={14} /> Einstrahlung</span>
        <span><CheckCircle2 size={14} /> Temperatur</span>
        <span><CheckCircle2 size={14} /> Systemverluste</span>
      </div>
    </div>
  );
}

function ResultsDashboard({ result, mode, loading, period, locationName }: { result: SimulationResponse; mode: 'simulation' | 'now' | null; loading: boolean; period: PeriodConfig; locationName: string }) {
  const { summary, timeSeries, monthly, roofs, solar, metadata } = result;
  const multiDay = period.start !== period.end;
  const displaySeries = useMemo(() => {
    const bucketSize = Math.max(1, Math.ceil(timeSeries.length / 1200));
    const reduced = [];
    for (let start = 0; start < timeSeries.length; start += bucketSize) {
      const bucket = timeSeries.slice(start, start + bucketSize);
      const representative = bucket[Math.floor(bucket.length / 2)];
      reduced.push({
        ...representative,
        // Averaging every contiguous bucket avoids the time-of-day aliasing
        // caused by selecting every nth hourly sample on long ranges.
        powerKw: bucket.reduce((sum, point) => sum + point.powerKw, 0) / bucket.length,
        energyKwh: bucket.reduce((sum, point) => sum + point.energyKwh, 0),
      });
    }
    return reduced.map((point) => ({
      ...point,
      label: formatChartTimestamp(point.timestamp, multiDay, metadata.timezone),
    }));
  }, [timeSeries, multiDay, metadata.timezone]);
  const monthlySeries = monthly.map((point) => ({ ...point, label: formatMonth(point.month) }));
  const latestPoint = timeSeries.length > 0 ? timeSeries[timeSeries.length - 1] : undefined;
  const roofMetric = (roof: SimulationResponse['roofs'][number]) =>
    mode === 'now' ? (roof.powerKw ?? 0) : (roof.energyKwh ?? 0);
  const maximumRoofMetric = Math.max(1, ...roofs.map(roofMetric));
  const periodLabel = mode === 'now'
    ? 'Aktueller Zeitpunkt'
    : `${new Intl.DateTimeFormat('de-AT').format(new Date(`${period.start}T12:00:00`))} – ${new Intl.DateTimeFormat('de-AT').format(new Date(`${period.end}T12:00:00`))}`;

  return (
    <div className={`results-dashboard${loading ? ' is-loading' : ''}`}>
      {loading && <div className="result-loading"><LoaderCircle className="spin" size={22} /> Neue Daten werden berechnet …</div>}
      <div className="results-header">
        <div><span className="section-kicker">Simulationsergebnis</span><h2>{mode === 'now' ? 'Leistung im Moment' : 'Ihr Solarprofil'}</h2><p><MapPin size={14} /> {locationName || 'Gewählter Standort'} · {periodLabel}</p></div>
        <div className={`quality-pill${metadata.isFallback ? ' fallback' : ''}`}>
          {metadata.isFallback ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          {metadata.isFallback ? 'Modell-/Ersatzwert' : metadata.quality || 'Daten verfügbar'}
        </div>
      </div>

      {metadata.isFallback && (
        <div className="fallback-notice"><CloudSun size={19} /><div><strong>Transparenter Fallback</strong><span>Für mindestens einen Wert waren keine direkten Daten verfügbar. Das Ergebnis enthält gekennzeichnete Modell- oder Ersatzwerte.</span></div></div>
      )}

      <div className="kpi-grid">
        <KpiCard icon={mode === 'now' ? Gauge : Zap} label={mode === 'now' ? 'Aktuelle Leistung' : 'Energie im Zeitraum'} value={formatNumber(mode === 'now' ? (summary.currentPowerKw ?? summary.peakPowerKw) : summary.totalEnergyKwh)} unit={mode === 'now' ? 'kW' : 'kWh'} accent detail={mode === 'now' ? 'Momentane Erwartung' : 'Simulierter Ertrag'} />
        <KpiCard icon={PanelsTopLeft} label="Anlagenleistung" value={formatNumber(summary.installedKwp)} unit="kWp" detail={`${summary.totalModules} Module`} />
        <KpiCard icon={BarChart3} label="Spezifischer Ertrag" value={formatNumber(summary.specificYieldKwhPerKwp)} unit="kWh/kWp" detail={summary.specificYieldKwhPerKwp === undefined ? 'Für Momentaufnahme nicht verfügbar' : 'Vergleichswert'} />
        <KpiCard icon={Gauge} label={mode === 'now' ? 'Leistung gesamt' : 'Spitzenleistung'} value={formatNumber(summary.peakPowerKw)} unit="kW" detail={mode === 'now' ? 'Alle Dachflächen' : 'Im gewählten Zeitraum'} />
      </div>

      <div className="period-kpis" aria-label="Erträge nach Zeitraum">
        <PeriodMetric label="Heute" value={summary.todayEnergyKwh} />
        <PeriodMetric label="Dieser Monat" value={summary.monthEnergyKwh} />
        <PeriodMetric label="Dieses Jahr" value={summary.yearEnergyKwh} />
      </div>

      {mode === 'now' && (
        <div className="now-grid">
          <SolarMetric icon={Sun} label="Sonnenhöhe" value={`${formatNumber(solar.currentElevationDeg)}°`} />
          <SolarMetric icon={Compass} label="Sonnenazimut" value={`${formatNumber(solar.currentAzimuthDeg)}°`} />
          <SolarMetric icon={CloudSun} label="Aktuelle Einstrahlung" value={latestPoint?.ghiWm2 === undefined ? '–' : `${formatNumber(latestPoint.ghiWm2)} W/m²`} />
        </div>
      )}

      <div className="chart-card wide-chart">
        <div className="card-title-row">
          <div><span className="card-kicker">Leistungsverlauf</span><h3>PV-Leistung</h3></div>
          <div className="chart-legend"><span className="legend-dot" /> Leistung in kW</div>
        </div>
        {displaySeries.length > 0 ? (
          <div className="chart-container">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={displaySeries} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="powerGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f3b51b" stopOpacity={0.42} />
                    <stop offset="100%" stopColor="#f3b51b" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#e6e9df" />
                <XAxis dataKey="label" tick={{ fill: '#7d8279', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={36} />
                <YAxis tick={{ fill: '#7d8279', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(value) => `${formatNumber(Number(value))}`} />
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e3e6dc', boxShadow: '0 12px 35px rgba(28,35,28,.12)', fontSize: 12 }} formatter={(value) => [`${formatNumber(Number(value), 2)} kW`, 'PV-Leistung']} labelStyle={{ color: '#6b7168', marginBottom: 5 }} />
                <Area type="monotone" dataKey="powerKw" stroke="#d79700" strokeWidth={2.5} fill="url(#powerGradient)" activeDot={{ r: 4, fill: '#d79700', stroke: '#fff', strokeWidth: 2 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : <NoData text="Keine Leistungszeitreihe für diesen Zeitraum verfügbar." />}
      </div>

      <div className="result-two-columns">
        <div className="chart-card">
          <div className="card-title-row"><div><span className="card-kicker">Energieverteilung</span><h3>Monatlicher Ertrag</h3></div><span className="unit-chip">kWh</span></div>
          {monthlySeries.length > 0 ? (
            <div className="chart-container small">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlySeries} margin={{ top: 12, right: 0, left: -24, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#e6e9df" />
                  <XAxis dataKey="label" tick={{ fill: '#7d8279', fontSize: 10 }} axisLine={false} tickLine={false} interval={0} />
                  <YAxis tick={{ fill: '#7d8279', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: 'rgba(243,181,27,.08)' }} contentStyle={{ borderRadius: 12, border: '1px solid #e3e6dc', fontSize: 12 }} formatter={(value) => [`${formatNumber(Number(value), 2)} kWh`, 'Energie']} />
                  <Bar dataKey="energyKwh" fill="#f0b323" radius={[5, 5, 1, 1]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <NoData text="Keine Monatsaggregation verfügbar." />}
        </div>

        <div className="chart-card solar-card">
          <div className="card-title-row"><div><span className="card-kicker">Astronomie</span><h3>Sonnenstand</h3></div><Sun size={20} className="sun-icon" /></div>
          <div className="sun-arc" aria-hidden="true"><span className="sun-track"><i /></span></div>
          <div className="solar-stats">
            <SolarMetric icon={Sunrise} label="Sonnenaufgang" value={formatSolarTime(solar.sunrise, metadata.timezone)} />
            <SolarMetric icon={Sunset} label="Sonnenuntergang" value={formatSolarTime(solar.sunset, metadata.timezone)} />
            <SolarMetric icon={Clock3} label="Tageslänge" value={solar.dayLengthHours === undefined ? '–' : `${formatNumber(solar.dayLengthHours)} h`} />
            <SolarMetric icon={Compass} label="Azimut" value={solar.currentAzimuthDeg === undefined ? '–' : `${formatNumber(solar.currentAzimuthDeg)}°`} />
          </div>
        </div>
      </div>

      <div className="chart-card roof-results-card">
        <div className="card-title-row"><div><span className="card-kicker">Flächenvergleich</span><h3>{mode === 'now' ? 'Leistung je Dachfläche' : 'Ertrag je Dachfläche'}</h3></div><span className="unit-chip">{roofs.length} Flächen</span></div>
        {roofs.length > 0 ? (
          <div className="roof-result-list">
            <div className="roof-table-head"><span>Dachfläche</span><span>Module</span><span>Installiert</span><span>{mode === 'now' ? 'Leistung' : 'Ertrag'}</span></div>
            {roofs.map((roof) => (
              <div className="roof-result-row" key={roof.id}>
                <div className="roof-result-name"><span className="roof-color" /><strong>{roof.name}</strong></div>
                <span>{roof.panelCount}</span>
                <span>{formatNumber(roof.installedKwp)} kWp</span>
                <strong>{formatNumber(roofMetric(roof))} {mode === 'now' ? 'kW' : 'kWh'}</strong>
                <div className="roof-progress"><span style={{ width: `${Math.max(1, roofMetric(roof) / maximumRoofMetric * 100)}%` }} /></div>
              </div>
            ))}
          </div>
        ) : <NoData text="Keine Ergebnisse pro Dachfläche übermittelt." />}
      </div>

      <div className="data-card">
        <div className="data-card-icon"><Database size={22} /></div>
        <div className="data-main"><span className="card-kicker">Datengrundlage</span><h3>{metadata.source}</h3><p>{metadata.notes || 'Quelle und Auflösung wurden vom lokalen Berechnungsdienst dokumentiert.'}</p></div>
        <dl className="data-details">
          <div><dt>Datenstand</dt><dd>{formatDateTime(metadata.observationEnd ?? metadata.retrievedAt, metadata.timezone)}</dd></div>
          <div><dt>Zeitauflösung</dt><dd>{metadata.resolution || 'Nicht angegeben'}</dd></div>
          <div><dt>Datentyp</dt><dd>{metadata.dataType || (metadata.isFallback ? 'Modelliert' : 'Strahlungsdaten')}</dd></div>
          <div><dt>Qualität</dt><dd>{formatDataQuality(metadata.quality, metadata.isFallback)}</dd></div>
          <div><dt>Standort</dt><dd>{metadata.location || 'Nicht angegeben'}</dd></div>
          <div><dt>Bereitstellung</dt><dd>{metadata.fromCache ? 'Lokaler SQLite-Cache' : 'Direkter Providerabruf'}</dd></div>
        </dl>
      </div>
    </div>
  );
}

function PeriodMetric({ label, value }: { label: string; value?: number }) {
  const available = value !== undefined;
  return (
    <div className={`period-metric${available ? '' : ' unavailable'}`}>
      <span>{label}</span>
      <strong>{available ? `${formatNumber(value)} kWh` : '–'}</strong>
      {!available && <small>außerhalb des berechneten Zeitraums</small>}
    </div>
  );
}

function SolarMetric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return <div className="solar-metric"><Icon size={17} /><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function NoData({ text }: { text: string }) {
  return <div className="no-data"><Info size={19} /><span>{text}</span></div>;
}

export default App;
