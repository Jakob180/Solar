# Solar Potential

Solar Potential ist eine lokal laufende Webanwendung zur physikalisch nachvollziehbaren Simulation von PV-Erträgen. Der Standort wird per Karte oder exakten Koordinaten gewählt, Dachflächen und Module werden frei konfiguriert. Die Anwendung lädt historische beziehungsweise aktuelle Strahlungs- und Wettermodelldaten, berechnet jede Dachfläche separat und visualisiert Leistung und Energie.

Die Anwendung erkennt **keine** Gebäude und führt **keine** automatische Verschattungs-, Speicher-, Verbrauchs- oder Wirtschaftlichkeitsrechnung durch.

## Funktionsumfang

- interaktive OpenStreetMap-Karte mit Kartenklick, verschiebbarem Marker, Browser-Standort und weiterhin direkt editierbaren Koordinaten
- animierte, schematische 3D-Hausansicht für Dachneigung, Azimut, PV-Module, Sonnenstand und Energiefluss
- automatisch bestimmte Standort-Zeitzone aus den exakten Koordinaten
- beliebig viele Dachflächen mit Fläche, Neigung, Azimut und PV-Belegung
- automatische, flächenbasierte Modulanzahl und manueller Override mit Kapazitätsprüfung
- frei konfigurierbares Modul: Wp, Abmessungen, Wirkungsgrad und Temperaturkoeffizient
- historische Tages- bis Jahressimulation (maximal 367 Tage pro Lauf)
- aktuelle Leistung über den Endpunkt „Jetzt berechnen“
- GHI, DNI, DHI, Umgebungstemperatur und Wind aus Open-Meteo
- SQLite-Cache für wiederholte Datenabfragen
- explizit gekennzeichnetes pvlib-Clear-Sky-Modell bei Daten-/Netzausfall
- Sonnenhöhe, Sonnenazimut, Sonnenaufgang, Sonnenuntergang und Tageslänge
- Kennzahlen, Tages-/Zeitraumkurve, Monatsbalken und Dachflächenvergleich
- deutsche, responsive Benutzeroberfläche ohne rohe `NaN`-/`Infinity`-Werte
- OpenAPI-Dokumentation und automatisierte Backendtests

## Architektur und Tech-Stack

```text
Browser (React + TypeScript + Vite + Recharts + Leaflet)
          │                         │
          │                         └── OpenStreetMap-Kartenkacheln
          ▼
lokale FastAPI-API ──┬── Open-Meteo Historical/Forecast API
                     ├── SQLite-Wettercache
                     └── pvlib / pandas / NumPy
```

React/TypeScript sorgt für typisierte, dynamische Formulare, die interaktive Leaflet-Karte, das animierte Hausmodell und ein responsives Dashboard. FastAPI/Pydantic übernimmt die strikte Eingabevalidierung. Die wissenschaftlichen Berechnungen liegen in Python, weil pvlib etablierte Solarpositions-, Transpositions-, Temperatur- und PV-Leistungsmodelle bereitstellt. Berechnung, Dach- und Moduldaten bleiben lokal; Internet wird für Open-Meteo-Daten und die OpenStreetMap-Kartenkacheln verwendet.

## Voraussetzungen

- Python 3.11 oder neuer
- Node.js 20.19 oder neuer (beziehungsweise 22.12+) und npm
- Internet für reale historische/aktuelle Modelldaten und Kartenkacheln; ohne Internet arbeitet die Berechnung mit dem gekennzeichneten Clear-Sky-Fallback und der Standort bleibt per Koordinaten wählbar

Getestete Entwicklungsumgebung: Python 3.11 und Node.js 24 unter Windows.

## Schnellstart

### Windows

```powershell
Set-Location C:\Pfad\zu\Solar
.\start.ps1
```

Beim ersten Start werden die Python-Umgebung und npm-Pakete automatisch eingerichtet. Danach öffnen:

- Oberfläche: <http://localhost:5173>
- API-Dokumentation: <http://localhost:8000/docs>

Beenden mit `Strg+C`.

### macOS / Linux

```bash
chmod +x start.sh
./start.sh
```

### Manuell

```powershell
npm run setup
npm start
```

Der Startbefehl baut das Frontend und startet den lokalen Produktions-Preview auf Port 5173 sowie das Backend auf Port 8000. Für die Entwicklung steht `npm run dev` zur Verfügung; beide Varianten leiten `/api` lokal an FastAPI weiter.

## Konfiguration

Optional `.env.example` nach `.env` kopieren. Unterstützte Werte:

```dotenv
SOLAR_CACHE_PATH=backend/data/solar_cache.sqlite3
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
SOLAR_OFFLINE=false
SOLAR_HTTP_TIMEOUT=20
```

Alternativ wird `SOLAR_CACHE_DB` akzeptiert. Open-Meteo benötigt für die standardmäßig verwendete öffentliche, nicht-kommerzielle API keinen Schlüssel. Zugangsdaten dürfen bei einer späteren kommerziellen Provider-Anbindung nur in einer lokalen `.env` liegen und gehören nicht ins Repository.

`SOLAR_OFFLINE=true` unterbindet Netzabfragen. Ergebnisse verwenden dann den deutlich markierten Clear-Sky-Fallback. Der Cache liegt standardmäßig unter `backend/data/weather_cache.sqlite3`.

## Bedienung

1. Breitengrad und Längengrad eingeben.
2. Simulationszeitraum und die lokale Referenzuhrzeit für den angezeigten Sonnenstand wählen (Tag, letzte 30 Tage, laufendes Jahr oder eigene Daten).
3. Eine oder mehrere Dachflächen anlegen. Die interne Azimutkonvention ist `0° = Nord`, `90° = Ost`, `180° = Süd`, `270° = West`.
4. PV-Belegung festlegen. „Automatisch“ verwendet das theoretische Flächenmaximum; „Manuell“ erlaubt kleinere Werte.
5. Moduldaten und pauschale Systemverluste konfigurieren.
6. „Simulation starten“ oder „Jetzt berechnen“ wählen.
7. Datenquelle, Auflösung, Qualität, Zeitraum und mögliche Fallback-Hinweise im Ergebnis prüfen.

Die flächenbasierte Modulzahl ist keine Verlegeplanung: Dachform, Randabstände, Wartungsgänge und Hoch-/Querformat sind ohne Dachabmessungen nicht bestimmbar.

## Lokale API

### `POST /api/simulation`

```json
{
  "location": {
    "name": "Salzburg",
    "latitude": 47.8095,
    "longitude": 13.055
  },
  "roofs": [
    {
      "id": "south",
      "name": "Süddach",
      "area_m2": 80,
      "tilt_deg": 35,
      "azimuth_deg": 180,
      "panel_coverage_percent": 75,
      "panel_count": 24
    }
  ],
  "panel": {
    "name": "Monokristallin 450 Wp",
    "power_wp": 450,
    "width_m": 1.134,
    "height_m": 1.762,
    "efficiency": 0.22,
    "temperature_coefficient": -0.0035
  },
  "simulation": {
    "start": "2025-01-01",
    "end": "2025-12-31",
    "reference_time": "12:00"
  },
  "system_loss_percent": 14,
  "allow_modeled_fallback": true
}
```

`panel_count` kann ausgelassen beziehungsweise `null` sein; dann setzt das Backend das theoretische Maximum ein. Ein manueller Wert oberhalb der Flächenkapazität wird abgelehnt.

### `POST /api/now`

Verwendet dieselbe Anlagenkonfiguration; `simulation` ist optional und wird ignoriert. Die Antwort enthält Zeitpunkt, momentane Leistung, Sonnenstand, Einstrahlung, Temperaturen, Ergebnisse je Dach und Datenmetadaten.

### Weitere Endpunkte

- `GET /api/health` – Status und Version
- `GET /docs` – interaktive OpenAPI-Oberfläche
- `GET /openapi.json` – maschinenlesbares Schema

## Berechnungsmodell

### 1. Belegbare Fläche und Module

```text
A_PV = A_Dach × Belegung / 100
N_max = floor(A_PV / (Modulbreite × Modulhöhe))
```

Die Wp-Angabe ist die autoritative STC-Leistung. `Wirkungsgrad × Modulfläche × 1000 W/m²` dient als Plausibilitätsprüfung und wird nicht noch einmal mit Wp multipliziert.

### 2. Sonnenposition

pvlib berechnet die zeitzonenbewusste Sonnenposition mit NREL-SPA (`nrel_numpy`). Sonnenaufgang und -untergang stammen aus `sun_rise_set_transit_spa`. Polarer Tag beziehungsweise Polarnacht ergeben leere Auf-/Untergangswerte statt ungültiger Zahlen.

Die optionale `reference_time` wird als lokale Uhrzeit am Startdatum interpretiert und steuert den im Dashboard angezeigten Sonnenstand. Ohne Angabe verwendet die Simulation bei einem Zeitraum mit dem heutigen Datum die aktuelle Uhrzeit, sonst 12:00 Uhr. „Jetzt berechnen“ verwendet immer den aktuellen Zeitpunkt am Standort.

### 3. Einstrahlung auf die Modulebene

GHI, DNI und DHI werden pro Zeitschritt mit Sonnenzenit, Sonnenazimut, Dachneigung und Dachazimut auf die geneigte Ebene (POA) transponiert. Verwendet wird pvlibs Hay-Davies-Modell inklusive diffuser und bodenreflektierter Strahlung (konfigurierbare Albedo, Standard `0,2`). Dies ist keine pauschale Orientierungstabelle.

### 4. Zelltemperatur

Die Zelltemperatur wird mit dem Faiman-Modell aus POA, 2-m-Umgebungstemperatur und 10-m-Wind angenähert. Die Übertragung der Windgeschwindigkeit auf Modulhöhe und die Montageart werden in Version 1 nicht separat modelliert; das ist eine dokumentierte Unsicherheit.

### 5. Leistung

Die DC-Leistung folgt dem PVWatts-Grundmodell:

```text
P_DC = P_STC × (POA / 1000) × (1 + γ × (T_cell − 25 °C))
P_netto = max(0, P_DC) × (1 − Systemverluste)
```

`γ` wird intern relativ pro °C gespeichert (`-0,0035` entspricht `-0,35 %/°C`). Die Leistungen aller Dächer werden summiert. Der pauschale Verlustfaktor deckt Wechselrichter, Kabel und sonstige Systemverluste ab, modelliert aber keine konkrete Inverterkennlinie oder Clipping-Grenze.

### 6. Energie

Open-Meteo liefert historische Strahlung als Mittelwert des vorhergehenden Zeitintervalls. Die Energie ist deshalb die Summe `P_i × Δt_i`; Zeitdifferenzen werden in UTC bestimmt, damit 23-/25-Stunden-Tage korrekt bleiben. Monatssummen werden in der Standort-Zeitzone gruppiert.

## Datenquellen und Datenqualität

### Open-Meteo Historical Weather API

- historische, gerasterte Reanalyse-/Modelldaten; keine Messung auf dem Haus
- stündliche GHI-, DNI-, DHI-, Temperatur- und Windwerte
- API: <https://open-meteo.com/en/docs/historical-weather-api>

### Open-Meteo Forecast API

- aktuelle numerische Wettermodelldaten für „Jetzt“ und aktuelle Zeiträume
- je nach Modell aktuelle Strahlung in bis zu 15-minütiger Auflösung
- API: <https://open-meteo.com/en/docs>

Die zugrunde liegenden offenen Daten erfordern Attribution; Bedingungen und kommerzielle Optionen stehen unter <https://open-meteo.com/en/terms> und <https://open-meteo.com/en/pricing>.

Im Onlinebetrieb werden ausschließlich Koordinaten, Zeitraum, Zeitzone und die angeforderten Wetterfelder an Open-Meteo übertragen. Die Karte lädt Kacheln für den sichtbaren Kartenausschnitt direkt von OpenStreetMap; „Mein Standort“ fragt nur nach einem ausdrücklichen Klick die Browser-Geolokalisierung ab. Dach-, Modul- und Ergebnisdaten verlassen den lokalen Rechner nicht. Mit `SOLAR_OFFLINE=true` werden keine Wetterdaten von Open-Meteo abgerufen; Kartenkacheln bleiben davon unabhängig. Ohne Kartenverbindung funktionieren die direkten Koordinatenfelder weiterhin.

### Warum diese Quelle?

| Quelle | Zeit / Raum | Vorteile | Entscheidung für Version 1 |
|---|---|---|---|
| Open-Meteo Historical (ERA5/ERA5-Land/IFS) | stündlich; je nach Modell etwa 9–25 km; lange Historie | GHI, DNI, DHI, Temperatur und Wind in einer konsistenten, schlüssellosen API; weltweite Abdeckung | **Primärquelle** für historische Simulationen |
| Open-Meteo Forecast | stündlich, regional 15-minütig | gleiche Felder und Antwortstruktur; aktuelle Instant-Strahlung | **Primärquelle** für „Jetzt“ |
| Open-Meteo Satellite Radiation / SARAH3 | in Europa/Afrika typischerweise 30 min und deutlich feineres Raster | hochwertige satellitenbasierte Einstrahlung | sehr geeignete nächste Provider-Erweiterung; regional begrenzt und benötigt eine zweite Quelle für Temperatur/Wind |
| PVGIS 5.3 | abhängig von Strahlungsdatenbank und Region | etablierte PV-Referenz, TMY und Zeitreihen | gute Validierungs-/Fallbackquelle; nicht als Hauptquelle gewählt, weil beliebige historische Zeiträume und aktuelle Daten nicht so einheitlich sind |
| NASA POWER | weltweit, stündlich/täglich, gröberes Raster | robuste Langzeitabdeckung, einfacher API-Zugang | mögliche globale Rückfallebene; für lokale Dächer gröber als die gewählte Best-Match-Kette |
| direkter ERA5/ERA5-Land-Abruf | stündlich, Reanalyse | wissenschaftlich etabliert und konsistent | für eine lokal leicht installierbare Anwendung wegen großer Downloads und komplexerer Zugangskette nicht direkt integriert |

Entscheidend waren globale Verfügbarkeit, stündliche GHI/DNI/DHI-Werte, eine identische historische/aktuelle Struktur, automatische Standort-Zeitzonen, kein Pflicht-API-Key und einfache lokale Zwischenspeicherung. Die Anwendung bezeichnet diese Rasterwerte ausdrücklich als Reanalyse-/Modellwerte und nicht als Messdaten am Gebäude. Die Provider-Abgrenzung in `weather.py` erlaubt später eine satellitenbasierte Quelle, ohne das PV-Modell oder die UI zu ändern.

### Offline-/Fehlerfallback

Wenn die API ausfällt und `allow_modeled_fallback` aktiv ist, erzeugt pvlib standortspezifische Ineichen-Clear-Sky-Strahlung. Dieses Modell enthält keine aktuelle Bewölkung und kann den Ertrag deutlich überschätzen. Die UI kennzeichnet Quelle, `is_fallback`, Qualität, Zeitauflösung und Hinweise. Fehlende Providerfelder werden repariert und als gemischte Datenqualität ausgewiesen; es werden niemals stillschweigend `NaN`-Werte ausgeliefert.

Der SQLite-Schlüssel umfasst URL und alle Requestparameter. Historische Daten werden länger, aktuelle Daten kurz zwischengespeichert. Cache-Nutzung wird separat von der fachlichen Datenqualität ausgewiesen.

## Tests

Alle Prüfungen inklusive Frontend-Typecheck/Produktionsbuild:

```powershell
npm test
```

Nur Backend:

```powershell
backend\.venv\Scripts\python.exe -m pytest backend
```

Nur Frontend:

```powershell
npm --prefix frontend run build
```

Die Tests decken unter anderem Koordinatenvalidierung, Modulkapazität, Himmelsrichtungen, Neigungen, Breitengrade/Jahreszeiten, Sonnenauf-/untergang, Skalierung mit Modulzahl/Wp, Temperaturwirkung, Energieintegration, Datenlücken, Cache, API-Fehler und Offline-Fallback ab. Normale Tests benötigen kein Internet.

## Projektstruktur

```text
Solar/
├── backend/
│   ├── app/            FastAPI, Modelle, Cache, Wetter und Solarphysik
│   ├── tests/          Unit- und API-Tests
│   └── requirements.txt
├── frontend/
│   ├── src/            React-Dashboard, API-Adapter und Styles
│   └── package.json
├── scripts/            plattformübergreifendes Setup, Start und Tests
├── .env.example
├── start.ps1
├── start.sh
└── README.md
```

## Bekannte Einschränkungen

- keine Verschattung durch Häuser, Vegetation, Gelände oder Eigenverschattung
- keine Schnee-, Verschmutzungs-, Degradations- oder Mismatch-Detailmodelle
- keine geometrische Modulbelegung, Randabstände oder Dachform
- das 3D-Haus ist eine schematische Visualisierung und kein maßstabgetreues Gebäude- oder Verschattungsmodell
- kein konkretes Wechselrichtermodell und kein Clipping
- kein Batteriespeicher, Eigenverbrauch, Strompreis oder Wirtschaftlichkeit
- Rasterdaten können lokale Wolken und Mikroklima nicht exakt abbilden
- Clear-Sky-Fallback ist ein Notmodell, keine Wetterprognose
- Modulmontage und Wind auf Modulebene werden angenähert
- maximal 367 Tage pro Simulationslauf, damit API- und Browserantworten beherrschbar bleiben

Die Resultate sind belastbare Modellschätzungen im Rahmen dieser Eingaben und Datenauflösung, aber keine Ertragsgarantie oder bankfähige Anlagenplanung.

## Fehlerbehebung

- **Frontend meldet, das Backend sei nicht erreichbar:** prüfen, ob Port 8000 frei ist und <http://localhost:8000/api/health> antwortet.
- **Port 5173/8000 belegt:** den anderen Prozess beenden oder Ports in `scripts/dev.mjs` und `frontend/vite.config.ts` konsistent ändern.
- **API nicht erreichbar/kein Internet:** der Fallback muss in der Ergebnisquelle sichtbar sein; mit `allow_modeled_fallback=false` antwortet die API stattdessen mit HTTP 503.
- **Karte bleibt leer:** Internetzugang zu `tile.openstreetmap.org` prüfen; Breitengrad und Längengrad können weiterhin direkt eingetragen werden.
- **Alte Abhängigkeiten:** `npm run setup` erneut ausführen.
- **Cache zurücksetzen:** Backend beenden und nur die konfigurierte SQLite-Datei unter `backend/data/` entfernen; sie wird beim nächsten Start neu angelegt.

