import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Crosshair, LoaderCircle, LocateFixed, MapPin, Search } from 'lucide-react';
import L, { type LeafletMouseEvent, type Map as LeafletMap, type Marker } from 'leaflet';
import { ApiError, searchLocations } from '../api';
import type { GeocodeResult } from '../types';
import 'leaflet/dist/leaflet.css';
import './LocationMap.css';

export interface MapCoordinates {
  latitude: number;
  longitude: number;
}

export interface LocationMapProps extends MapCoordinates {
  onChange: (latitude: number, longitude: number) => void;
  onLocationNameChange?: (name: string) => void;
  locationName?: string;
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
  onLocationNameChange,
  locationName = '',
  className = '',
}: LocationMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const onChangeRef = useRef(onChange);
  const onLocationNameChangeRef = useRef(onLocationNameChange);
  const searchRootRef = useRef<HTMLDivElement | null>(null);
  const searchRequestRef = useRef(0);
  const [tileStatus, setTileStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([]);
  const [searchAttribution, setSearchAttribution] = useState('© OpenStreetMap contributors (ODbL)');
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'results' | 'empty' | 'error'>('idle');
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onLocationNameChangeRef.current = onLocationNameChange;
  }, [onLocationNameChange]);

  useEffect(() => {
    if (locationName.trim()) return;
    searchRequestRef.current += 1;
    setSearchQuery('');
    setSearchResults([]);
    setSearchState('idle');
    setSearchError(null);
  }, [locationName]);

  useEffect(() => {
    const closeResults = (event: PointerEvent) => {
      if (!searchRootRef.current?.contains(event.target as Node)) {
        setSearchState((current) => (
          current === 'results' || current === 'empty' || current === 'error'
            ? 'idle'
            : current
        ));
      }
    };
    document.addEventListener('pointerdown', closeResults);
    return () => document.removeEventListener('pointerdown', closeResults);
  }, []);

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
      onLocationNameChangeRef.current?.('');
      searchRequestRef.current += 1;
      setSearchQuery('');
      setSearchResults([]);
      setSearchState('idle');
      setSearchError(null);
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

  const submitSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearchState('error');
      setSearchError('Bitte mindestens zwei Zeichen eingeben.');
      return;
    }

    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setSearchState('loading');
    setSearchError(null);

    try {
      const response = await searchLocations(query, 5);
      if (searchRequestRef.current !== requestId) return;
      const { results } = response;
      setSearchAttribution(response.attribution);
      setSearchResults(results);
      setSearchState(results.length > 0 ? 'results' : 'empty');
    } catch (error) {
      if (searchRequestRef.current !== requestId) return;
      setSearchResults([]);
      setSearchState('error');
      setSearchError(
        error instanceof ApiError && error.status === 503
          ? 'Die Adresssuche ist derzeit nicht verfügbar. Koordinaten können weiterhin direkt eingegeben werden.'
          : error instanceof ApiError && error.status === 502
            ? 'Der Adressdienst hat ungültig geantwortet. Bitte später erneut versuchen.'
            : error instanceof ApiError
              ? error.message
          : 'Die Adresse konnte nicht gesucht werden.',
      );
    }
  };

  const selectSearchResult = (result: GeocodeResult) => {
    const nextLatitude = roundCoordinate(result.latitude);
    const nextLongitude = roundCoordinate(normalizeLongitude(result.longitude));
    onChangeRef.current(nextLatitude, nextLongitude);
    onLocationNameChangeRef.current?.(result.shortName);
    markerRef.current?.setLatLng([nextLatitude, nextLongitude]);

    const map = mapRef.current;
    if (map) {
      if (result.boundingBox) {
        const [south, north, west, east] = result.boundingBox;
        map.fitBounds([[south, west], [north, east]], {
          animate: true,
          padding: [28, 28],
          maxZoom: 18,
        });
      } else {
        map.flyTo([nextLatitude, nextLongitude], 17, { animate: true, duration: 0.7 });
      }
    }

    setSearchQuery(result.displayName);
    setSearchState('idle');
    setSearchResults([]);
    setSearchError(null);
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
        onLocationNameChangeRef.current?.('');
        searchRequestRef.current += 1;
        setSearchQuery('');
        setSearchResults([]);
        setSearchState('idle');
        setSearchError(null);
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
      <div className="location-map__search" ref={searchRootRef}>
        <form className="location-map__search-form" role="search" onSubmit={submitSearch}>
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => {
              if (searchState === 'loading') searchRequestRef.current += 1;
              setSearchQuery(event.target.value);
              setSearchState('idle');
              setSearchError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearchState('idle');
                setSearchResults([]);
                event.currentTarget.blur();
              }
            }}
            placeholder="Ort, Straße und Hausnummer suchen"
            aria-label="Adresse oder Ort suchen"
            aria-controls="location-search-results"
            aria-expanded={searchState === 'results' || searchState === 'empty'}
            autoComplete="off"
          />
          <button type="submit" disabled={searchState === 'loading'}>
            {searchState === 'loading' ? <LoaderCircle className="is-spinning" size={15} /> : <Search size={15} />}
            <span>{searchState === 'loading' ? 'Suche …' : 'Suchen'}</span>
          </button>
        </form>

        {(searchState === 'results' || searchState === 'empty') && (
          <div className="location-map__search-popover" id="location-search-results">
            {searchState === 'results' ? (
              <ul aria-label="Gefundene Adressen">
                {searchResults.map((result) => (
                  <li key={`${result.id}-${result.latitude}-${result.longitude}`}>
                    <button type="button" onClick={() => selectSearchResult(result)}>
                      <MapPin size={16} />
                      <span>
                        <strong>{result.shortName}</strong>
                        <small>{result.displayName}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Keine passende Adresse gefunden. Versuchen Sie Ort, Straße und Hausnummer gemeinsam.</p>
            )}
            <a
              className="location-map__search-attribution"
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
            >
              Suche: {searchAttribution}
            </a>
          </div>
        )}

        {searchState === 'error' && searchError && (
          <p className="location-map__search-error" role="alert">{searchError}</p>
        )}
        <span className="location-map__sr-only" role="status" aria-live="polite">
          {searchState === 'loading' && 'Adresse wird gesucht.'}
          {searchState === 'results' && `${searchResults.length} Suchergebnisse gefunden.`}
          {searchState === 'empty' && 'Keine Suchergebnisse gefunden.'}
        </span>
      </div>

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

