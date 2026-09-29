import { memo, useId, useMemo, type CSSProperties } from 'react';
import './SolarHouse3D.css';

type Point = { x: number; y: number };

export interface SolarHouse3DProps {
  /** Dachausrichtung: 0° = Nord, 90° = Ost, 180° = Süd. */
  roofAzimuthDeg?: number;
  /** Dachneigung in Grad. */
  roofTiltDeg?: number;
  /** Konfigurierte Module; bis zu 16 werden schematisch gezeichnet. */
  panelCount?: number;
  /** Installierte Anlagenleistung. */
  installedKwp?: number;
  /** Momentanleistung für die Energiefluss-Anzeige. */
  currentPowerKw?: number;
  /** Sonnenhöhe; Werte unter 0 setzen die Sonne unter den Horizont. */
  sunElevationDeg?: number;
  /** Sonnenazimut für die Position auf der Sonnenbahn. */
  sunAzimuthDeg?: number;
  locationName?: string;
  /** Unterscheidet die Konfigurationsvorschau von berechneten Ergebnisdaten. */
  hasResult?: boolean;
  loading?: boolean;
  className?: string;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

const normalizeDegrees = (value: number) => ((value % 360) + 360) % 360;

const formatNumber = (value: number, digits = 1) =>
  new Intl.NumberFormat('de-AT', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

const directionLabel = (azimuth: number) => {
  const directions = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  return directions[Math.round(normalizeDegrees(azimuth) / 45) % directions.length];
};

const interpolate = (start: Point, end: Point, amount: number): Point => ({
  x: start.x + (end.x - start.x) * amount,
  y: start.y + (end.y - start.y) * amount,
});

const bilinear = (
  topLeft: Point,
  topRight: Point,
  bottomRight: Point,
  bottomLeft: Point,
  u: number,
  v: number,
): Point => {
  const top = interpolate(topLeft, topRight, u);
  const bottom = interpolate(bottomLeft, bottomRight, u);
  return interpolate(top, bottom, v);
};

const polygonPoints = (points: Point[]) => points.map(({ x, y }) => `${x},${y}`).join(' ');

function SolarHouse3DComponent({
  roofAzimuthDeg = 180,
  roofTiltDeg = 35,
  panelCount = 12,
  installedKwp,
  currentPowerKw,
  sunElevationDeg = 38,
  sunAzimuthDeg = 180,
  locationName,
  hasResult = false,
  loading = false,
  className = '',
}: SolarHouse3DProps) {
  const rawId = useId();
  const id = rawId.replace(/:/g, '');
  const safeAzimuth = normalizeDegrees(roofAzimuthDeg);
  const safeTilt = clamp(roofTiltDeg, 0, 90);
  const safeElevation = clamp(sunElevationDeg, -15, 90);
  const safeSunAzimuth = normalizeDegrees(sunAzimuthDeg);
  const safePanelCount = Math.max(0, Math.floor(Number.isFinite(panelCount) ? panelCount : 0));
  const visualPanelCount = Math.min(safePanelCount, 16);
  const isDaylight = safeElevation > 0;
  const powerActive = (currentPowerKw ?? (isDaylight ? 1 : 0)) > 0.01;

  const scene = useMemo(() => {
    // The back roof edge rises with the configured tilt. Perspective depth is
    // retained at 0° so even a flat roof remains spatially legible.
    const tiltLift = (safeTilt / 90) * 46;
    const roof = {
      topLeft: { x: 294, y: 181 - tiltLift },
      topRight: { x: 498, y: 235 - tiltLift },
      bottomRight: { x: 398, y: 289 },
      bottomLeft: { x: 190, y: 233 },
    };

    const columnCount = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(visualPanelCount * 1.35))));
    const rowCount = Math.max(1, Math.ceil(visualPanelCount / columnCount));
    const cells: Point[][] = [];
    const insetU = 0.055;
    const insetV = 0.105;
    const usableU = 1 - insetU * 2;
    const usableV = 0.82 - insetV;
    const gapU = 0.014;
    const gapV = 0.025;

    for (let index = 0; index < visualPanelCount; index += 1) {
      const column = index % columnCount;
      const row = Math.floor(index / columnCount);
      const u0 = insetU + (column / columnCount) * usableU + gapU;
      const u1 = insetU + ((column + 1) / columnCount) * usableU - gapU;
      const v0 = insetV + (row / rowCount) * usableV + gapV;
      const v1 = insetV + ((row + 1) / rowCount) * usableV - gapV;
      cells.push([
        bilinear(roof.topLeft, roof.topRight, roof.bottomRight, roof.bottomLeft, u0, v0),
        bilinear(roof.topLeft, roof.topRight, roof.bottomRight, roof.bottomLeft, u1, v0),
        bilinear(roof.topLeft, roof.topRight, roof.bottomRight, roof.bottomLeft, u1, v1),
        bilinear(roof.topLeft, roof.topRight, roof.bottomRight, roof.bottomLeft, u0, v1),
      ]);
    }

    const sunRadians = ((safeSunAzimuth - 180) * Math.PI) / 180;
    const horizonFactor = clamp(safeElevation / 90, 0, 1);
    const sun = {
      x: 324 + Math.sin(sunRadians) * 242 * (1 - horizonFactor * 0.28),
      y: isDaylight ? 260 - horizonFactor * 205 : 278,
    };

    return { roof, cells, sun };
  }, [isDaylight, safeElevation, safeSunAzimuth, safeTilt, visualPanelCount]);

  const computedKwp = installedKwp ?? safePanelCount * 0.45;
  const statusText = loading
    ? 'Modell wird aktualisiert'
    : !hasResult
      ? 'Animierte Konfigurationsvorschau'
    : powerActive && isDaylight
      ? 'Solarertrag aktiv'
      : isDaylight
        ? 'Sonnenlicht verfügbar'
        : 'Sonne unter dem Horizont';
  const accessibleLabel = [
    `3D-Solarmodell mit ${safePanelCount} Modulen`,
    `Dachausrichtung ${directionLabel(safeAzimuth)} bei ${formatNumber(safeAzimuth, 0)} Grad`,
    `Dachneigung ${formatNumber(safeTilt, 0)} Grad`,
    `Sonnenhöhe ${formatNumber(safeElevation)} Grad`,
    `${statusText}.`,
  ].join('. ');

  const style = {
    '--house-sun-strength': isDaylight ? clamp(0.35 + safeElevation / 90, 0.35, 1) : 0.12,
    '--house-compass-rotation': `${safeAzimuth}deg`,
  } as CSSProperties;

  return (
    <figure
      className={`solar-house-3d ${loading ? 'solar-house-3d--loading' : ''} ${className}`.trim()}
      style={style}
      role="img"
      aria-label={accessibleLabel}
      aria-busy={loading}
    >
      <div className="solar-house-3d__viewport">
        <svg
          className="solar-house-3d__scene"
          viewBox="0 0 620 420"
          aria-hidden="true"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fbfcf4" />
              <stop offset="1" stopColor="#edf1e3" />
            </linearGradient>
            <linearGradient id={`${id}-roof`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#34483c" />
              <stop offset="1" stopColor="#17261e" />
            </linearGradient>
            <linearGradient id={`${id}-panel`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#648298" />
              <stop offset="0.45" stopColor="#263e4e" />
              <stop offset="1" stopColor="#132833" />
            </linearGradient>
            <linearGradient id={`${id}-wall-front`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#fffdf1" />
              <stop offset="1" stopColor="#e2ddc9" />
            </linearGradient>
            <linearGradient id={`${id}-wall-side`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#d8d4c1" />
              <stop offset="1" stopColor="#bdb9a8" />
            </linearGradient>
            <radialGradient id={`${id}-sun`}>
              <stop offset="0" stopColor="#fff7b0" />
              <stop offset="0.65" stopColor="#dbee72" />
              <stop offset="1" stopColor="#efb326" />
            </radialGradient>
            <filter id={`${id}-shadow`} x="-40%" y="-40%" width="180%" height="180%">
              <feDropShadow dx="0" dy="16" stdDeviation="15" floodColor="#182019" floodOpacity="0.18" />
            </filter>
            <filter id={`${id}-glow`} x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="9" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <clipPath id={`${id}-viewport`}><rect width="620" height="420" rx="28" /></clipPath>
          </defs>

          <g clipPath={`url(#${id}-viewport)`}>
            <rect width="620" height="420" fill={`url(#${id}-sky)`} />
            <path className="solar-house-3d__sun-path" d="M52 271 C116 30 490 13 573 270" />
            <path className="solar-house-3d__sun-path solar-house-3d__sun-path--dash" d="M52 271 C116 30 490 13 573 270" />

            <g
              className={`solar-house-3d__sun ${isDaylight ? '' : 'solar-house-3d__sun--night'}`}
              style={{ transform: `translate(${scene.sun.x}px, ${scene.sun.y}px)` }}
            >
              <g className="solar-house-3d__sun-rays" opacity={isDaylight ? 0.72 : 0.18}>
                {Array.from({ length: 12 }, (_, index) => (
                  <line key={index} x1="0" y1="-31" x2="0" y2="-42" transform={`rotate(${index * 30})`} />
                ))}
              </g>
              <circle r="25" fill={`url(#${id}-sun)`} filter={`url(#${id}-glow)`} />
              <circle r="31" fill="none" stroke="#efb326" strokeOpacity="0.2" />
            </g>

            <g className="solar-house-3d__cloud solar-house-3d__cloud--one">
              <ellipse cx="77" cy="102" rx="27" ry="12" />
              <circle cx="65" cy="95" r="12" /><circle cx="87" cy="91" r="16" /><circle cx="103" cy="101" r="10" />
            </g>
            <g className="solar-house-3d__cloud solar-house-3d__cloud--two">
              <ellipse cx="510" cy="94" rx="22" ry="10" />
              <circle cx="499" cy="89" r="10" /><circle cx="517" cy="85" r="13" /><circle cx="529" cy="94" r="8" />
            </g>

            {isDaylight && powerActive && visualPanelCount > 0 && (
              <g className="solar-house-3d__energy-rays">
                <line x1={scene.sun.x} y1={scene.sun.y} x2="335" y2="211" />
                <line x1={scene.sun.x} y1={scene.sun.y} x2="395" y2="226" />
                <line x1={scene.sun.x} y1={scene.sun.y} x2="276" y2="207" />
              </g>
            )}

            <ellipse cx="341" cy="349" rx="232" ry="46" fill="#cbd5b7" opacity="0.45" />
            <ellipse cx="344" cy="348" rx="188" ry="31" fill="#758e68" opacity="0.18" />

            <g className="solar-house-3d__house" filter={`url(#${id}-shadow)`}>
              <polygon
                points={`190,233 398,289 398,355 190,299`}
                fill={`url(#${id}-wall-front)`}
              />
              <polygon
                points={`${scene.roof.bottomRight.x},${scene.roof.bottomRight.y} ${scene.roof.topRight.x},${scene.roof.topRight.y} 498,301 398,355`}
                fill={`url(#${id}-wall-side)`}
              />
              <polygon
                points={polygonPoints([
                  scene.roof.topLeft,
                  scene.roof.topRight,
                  scene.roof.bottomRight,
                  scene.roof.bottomLeft,
                ])}
                fill={`url(#${id}-roof)`}
                stroke="#17261e"
                strokeWidth="4"
                strokeLinejoin="round"
              />

              <g className="solar-house-3d__panels">
                {scene.cells.map((cell, index) => (
                  <polygon
                    key={index}
                    points={polygonPoints(cell)}
                    fill={`url(#${id}-panel)`}
                    stroke="#92b4c2"
                    strokeWidth="1.25"
                    strokeLinejoin="round"
                  />
                ))}
                {scene.cells.map((cell, index) => {
                  const leftMid = interpolate(cell[0], cell[3], 0.5);
                  const rightMid = interpolate(cell[1], cell[2], 0.5);
                  return (
                    <line
                      key={`grid-${index}`}
                      x1={leftMid.x}
                      y1={leftMid.y}
                      x2={rightMid.x}
                      y2={rightMid.y}
                      stroke="#91b2bf"
                      strokeOpacity="0.48"
                      strokeWidth="0.8"
                    />
                  );
                })}
              </g>

              <polygon points="214,273 252,283 252,324 214,314" fill="#71858a" stroke="#ffffff" strokeWidth="3" />
              <line x1="233" y1="279" x2="233" y2="319" stroke="#ffffff" strokeWidth="2" />
              <line x1="216" y1="294" x2="251" y2="303" stroke="#ffffff" strokeWidth="2" />
              <polygon points="325,301 365,312 365,346 325,335" fill="#7a5f43" />
              <circle cx="356" cy="329" r="2" fill="#e9d985" />
              <polygon points="425,279 464,260 464,297 425,317" fill="#61777a" stroke="#f4f2e8" strokeWidth="3" />
              <line x1="444" y1="270" x2="444" y2="306" stroke="#f4f2e8" strokeWidth="2" />
            </g>

            <g className="solar-house-3d__plant solar-house-3d__plant--left">
              <path d="M153 338 Q150 312 163 293 M158 317 Q145 307 144 294 M157 309 Q170 297 172 285" />
              <circle cx="144" cy="292" r="8" /><circle cx="173" cy="283" r="9" /><circle cx="164" cy="292" r="7" />
            </g>
            <g className="solar-house-3d__plant solar-house-3d__plant--right">
              <path d="M509 329 Q507 307 518 292 M512 310 Q501 301 501 289 M513 305 Q526 295 527 283" />
              <circle cx="501" cy="287" r="7" /><circle cx="528" cy="281" r="8" /><circle cx="519" cy="291" r="7" />
            </g>

            <g className="solar-house-3d__compass" transform="translate(96 326)">
              <circle r="42" />
              <circle r="28" className="solar-house-3d__compass-inner" />
              <text x="0" y="-49" textAnchor="middle">N</text>
              <g className="solar-house-3d__compass-arrow">
                <path d="M0 -27 L7 8 L0 4 L-7 8 Z" />
                <circle r="4" />
              </g>
            </g>
          </g>
        </svg>

        <div className="solar-house-3d__topline" aria-hidden="true">
          <span className="solar-house-3d__live"><i /> {hasResult ? 'Live-Modell' : 'Vorschau'}</span>
          {locationName && <span className="solar-house-3d__location">{locationName}</span>}
        </div>

        <div className="solar-house-3d__metrics" aria-hidden="true">
          <span><small>Ausrichtung</small><strong>{directionLabel(safeAzimuth)} · {formatNumber(safeAzimuth, 0)}°</strong></span>
          <span><small>Dachneigung</small><strong>{formatNumber(safeTilt, 0)}°</strong></span>
          <span><small>PV-Anlage</small><strong>{formatNumber(computedKwp)} kWp</strong></span>
          {currentPowerKw !== undefined && (
            <span className="solar-house-3d__power"><small>Jetzt</small><strong>{formatNumber(currentPowerKw)} kW</strong></span>
          )}
        </div>

        {safePanelCount > visualPanelCount && (
          <span className="solar-house-3d__panel-note" aria-hidden="true">
            {visualPanelCount} von {safePanelCount} Modulen schematisch
          </span>
        )}
        <span className="solar-house-3d__status" aria-hidden="true">
          <i className={powerActive && isDaylight ? 'is-active' : ''} /> {statusText}
        </span>
      </div>
      <figcaption className="solar-house-3d__sr-only">{accessibleLabel}</figcaption>
    </figure>
  );
}

export const SolarHouse3D = memo(SolarHouse3DComponent);
export default SolarHouse3D;
