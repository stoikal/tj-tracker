# TJ Tracker — TransJakarta live bus positions (routes 4K & 10)

A static single-page tracker that shows realtime TransJakarta bus positions for
route **4K** (Pulo Gadung – Kejaksaan Agung) and route **10** (Tanjung Priok –
PGC), with shortcuts that snap the map to 2 watched shelters.

- Bus markers: **blue = 4K**, **red = 10**, arrow rotates to the bus heading.
- **Direction filter (on by default)**: only buses whose current run heads to
  Kejaksaan Agung (4K) or PGC (10) are shown — the other direction is hidden
  from the map and list. Uncheck "Only buses toward …" in the legend to show
  all buses; destinations are configured in `ROUTE_DIRECTION_FILTER` (js/app.js).
- Shelter shortcuts (buttons + keyboard `1`–`2`) snap the map to:
  1. Ahmad Yani Bea Cukai 1 — 4K bound Kejaksaan Agung
  2. Pisangan — 10 bound PGC
- Each shelter popup lists approaching buses with live ETAs (taken from the
  feed's per-stop ETA data, matched by direction-specific gate stop).
- `0` or `R` resets the view to fit both corridors.

## Run

Any static file server works:

```bash
cd tj-tracker
python3 -m http.server 8756
# open http://127.0.0.1:8756/
```

No build step. External dependencies are CDN-loaded: Leaflet 1.9.4 and
mqtt.js 5.x.

## Data sources (TransJakarta public endpoints)

| Data | Source |
|------|--------|
| Live bus positions | Public MQTT broker `wss://mqtt.tj.co.id:8084/mqtt`, topic `/mobile_armada/#` (anonymous, MQTT 3.1.1 over WSS). Payload includes GPS + road-snapped position, bearing, trip/headsign, and a remaining-stops list with per-stop ETA. |
| Routes, shapes, shelters | Official GTFS static feed `https://gtfs.transjakarta.co.id/files/file_gtfs.zip` |

The page subscribes to the whole armada feed and keeps only messages whose
`route_code` is `4K` or `10`.

## Files

```
index.html            page shell
css/style.css         UI styling
js/app.js             map, MQTT client, markers, ETAs
js/data.js            generated static data (shelters + route polylines)
scripts/build_data.py regenerates js/data.js from a GTFS feed
```

Regenerate `js/data.js` (e.g. when TJ republishes GTFS):

```bash
curl -sL https://gtfs.transjakarta.co.id/files/file_gtfs.zip -o tj_gtfs.zip
unzip -o tj_gtfs.zip -d tj_gtfs
python3 scripts/build_data.py --gtfs tj_gtfs
```

## How shelter ETAs are computed

Each shelter is bound to a direction-specific gate stop from GTFS (e.g.
Cawang Sentral bound Tanjung Priok is gate `G00722`, only served by trips whose
stop headsign is "Tanjung Priok"). When a bus message arrives, the app looks
that gate up in the bus's remaining-stops list and shows its ETA, so a bus that
already passed the shelter (or is going the other way) is never counted.

## Notes

- The broker occasionally drops connections server-side; mqtt.js reconnects
  automatically and the status pill shows data freshness rather than socket
  state.
- Buses not heard from for 45 s are dimmed, and removed after 120 s.
- Unofficial project, not affiliated with PT Transportasi Jakarta.
