import { useEffect, useRef, useState } from 'react';
import { Crosshair, LocateFixed, MapPin } from 'lucide-react';
import L, { type LeafletMouseEvent, type Map as LeafletMap, type Marker } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './LocationMap.css';

export interface MapCoordinates {
  latitude: number;
  longitude: number;
}

export interface LocationMapProps extends MapCoordinates {
  onChange: (latitude: number, longitude: number) => void;
  className?: string;
}

const DEFAULT_POSITION: L.LatLngTuple = [47.8095, 13.055];
const DEFAULT_ZOOM = 13;

function isValidPosition(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180
  );
}

function roundCoordinate(value: number): number {
  return Number(value.toFixed(6));
}

function normalizeLongitude(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

const selectedLocationIcon = L.divIcon({
  className: 'location-map__marker-container',
  html: '<span class="location-map__marker" aria-hidden="true"><span></span></span>',
  iconSize: [34, 44],
  iconAnchor: [17, 42],
});

/**
 * Interaktive, API-Key-freie Standortkarte.
 *
 * Die Koordinaten bleiben bewusst kontrollierte Props: So sind Marker, Karte
 * und die numerischen Eingabefelder des Elternformulars immer synchron.
 */
export function LocationMap({
  latitude,
  longitude,
  onChange,
  className = '',
}: LocationMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const onChangeRef = useRef(onChange);
  const [tileStatus, setTileStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const initialPosition: L.LatLngTuple = isValidPosition(latitude, longitude)
      ? [latitude, longitude]
      : DEFAULT_POSITION;

    const map = L.map(container, {
      center: initialPosition,
      zoom: DEFAULT_ZOOM,
      minZoom: 2,
      maxZoom: 19,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
      keyboard: true,
      // Keep the page scroll usable inside the narrow configuration column.
      // Zoom controls, touch gestures and double-click zoom remain available.
      scrollWheelZoom: false,
    });

    const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>-Mitwirkende',
      maxZoom: 19,
    });
    tileLayer.on('tileload', () => setTileStatus('ready'));
    tileLayer.on('tileerror', () => {
      setTileStatus((current) => current === 'ready' ? current : 'error');
    });
    tileLayer.addTo(map);

    const marker = L.marker(initialPosition, {
      icon: selectedLocationIcon,
      draggable: true,
      autoPan: true,
      keyboard: true,
      title: 'Ausgewählten Standort verschieben',
      alt: 'Marker des ausgewählten Standorts',
    }).addTo(map);

    const publishPosition = (nextLatitude: number, nextLongitude: number) => {
      onChangeRef.current(
        roundCoordinate(nextLatitude),
        roundCoordinate(normalizeLongitude(nextLongitude)),
      );
    };

    const handleMapClick = (event: LeafletMouseEvent) => {
      marker.setLatLng(event.latlng);
      publishPosition(event.latlng.lat, event.latlng.lng);
    };

    const handleMarkerMove = () => {
      const position = marker.getLatLng();
      publishPosition(position.lat, position.lng);
    };

    map.on('click', handleMapClick);
    marker.on('dragend', handleMarkerMove);
    mapRef.current = map;
    markerRef.current = marker;

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => map.invalidateSize({ pan: false }));
    resizeObserver?.observe(container);

    // Leaflet berechnet die Größe beim ersten Paint. In Karten innerhalb von
    // responsiven Grids kann direkt danach noch eine Korrektur nötig sein.
    const resizeFrame = window.requestAnimationFrame(() => map.invalidateSize({ pan: false }));

    return () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeObserver?.disconnect();
      marker.off('dragend', handleMarkerMove);
      map.off('click', handleMapClick);
      map.remove();
      markerRef.current = null;
      mapRef.current = null;
    };
    // Die Karte wird genau einmal aufgebaut. Prop-Änderungen verarbeitet der
    // nachfolgende Effekt, ohne Zoom und Nutzerinteraktion zurückzusetzen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isValidPosition(latitude, longitude)) return;

    const position = L.latLng(latitude, longitude);
    markerRef.current?.setLatLng(position);

    const map = mapRef.current;
    if (map && !map.getCenter().equals(position, 1e-7)) {
      map.panTo(position, { animate: true, duration: 0.45 });
    }
  }, [latitude, longitude]);

  const focusSelectedLocation = () => {
    if (!isValidPosition(latitude, longitude)) return;
    const map = mapRef.current;
    if (!map) return;
    map.flyTo([latitude, longitude], Math.max(map.getZoom(), DEFAULT_ZOOM), {
      animate: true,
      duration: 0.65,
    });
  };

  const useBrowserLocation = () => {
    if (!('geolocation' in navigator)) {
      setLocationError('Die Standortfreigabe wird von diesem Browser nicht unterstützt.');
      return;
    }

    setLocationError(null);
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextLatitude = roundCoordinate(position.coords.latitude);
        const nextLongitude = roundCoordinate(normalizeLongitude(position.coords.longitude));
        onChangeRef.current(nextLatitude, nextLongitude);
        mapRef.current?.flyTo([nextLatitude, nextLongitude], 15, {
          animate: true,
          duration: 0.7,
        });
        setIsLocating(false);
      },
      (error) => {
        const message = error.code === error.PERMISSION_DENIED
          ? 'Standortfreigabe wurde nicht erteilt.'
          : 'Der aktuelle Standort konnte nicht bestimmt werden.';
        setLocationError(message);
        setIsLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  const coordinatesAreValid = isValidPosition(latitude, longitude);
  const rootClassName = ['location-map', className].filter(Boolean).join(' ');

  return (
    <div className={rootClassName}>
      <div className="location-map__toolbar">
        <span><MapPin size={14} /> In die Karte klicken oder den Marker ziehen</span>
        <div className="location-map__actions">
          <button
            type="button"
            onClick={useBrowserLocation}
            disabled={isLocating}
            title="Aktuellen Browser-Standort verwenden"
          >
            <Crosshair size={14} className={isLocating ? 'is-spinning' : ''} />
            <span>{isLocating ? 'Suche …' : 'Mein Standort'}</span>
          </button>
          <button
            type="button"
            onClick={focusSelectedLocation}
            disabled={!coordinatesAreValid}
            title="Ausgewählten Standort zentrieren"
          >
            <LocateFixed size={14} />
            <span>Zentrieren</span>
          </button>
        </div>
      </div>

      {locationError && (
        <p className="location-map__message is-error" role="status">{locationError}</p>
      )}

      <div className="location-map__viewport">
        <div
          ref={containerRef}
          className="location-map__canvas"
          role="application"
          aria-label="Interaktive Karte zur Auswahl des Anlagenstandorts"
        />
        {tileStatus !== 'ready' && (
          <div
            className={`location-map__tile-status${tileStatus === 'error' ? ' is-error' : ''}`}
            role="status"
          >
            {tileStatus === 'loading'
              ? 'Kartendaten werden geladen …'
              : 'Kartendarstellung nicht verfügbar – Koordinateneingabe bleibt möglich.'}
          </div>
        )}
        <output className={`location-map__coordinates${coordinatesAreValid ? '' : ' is-invalid'}`}>
          {coordinatesAreValid
            ? `${latitude.toFixed(5)}°, ${longitude.toFixed(5)}°`
            : 'Bitte gültige Koordinaten eingeben'}
        </output>
      </div>
    </div>
  );
}

