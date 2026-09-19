# Kenya · El Niño 2026 fork

This fork of [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view)
adds a Kenya flood-watch layer group for the October to December 2026 rains.
Everything in it is public data fetched live from the browser or bundled with
its licence noted in `DATA_SOURCES.md`. No API key is needed for any of it.

## Run it

```bash
npm ci
npm run dev
```

Open the printed localhost URL. In the **DATA LAYERS** panel there is a new
group, **Kenya · El Niño 2026**, with five toggles:

| Toggle               | What it shows                                                                                                                                                                                                                              | Where the data comes from                              | Refresh                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------- |
| River Gauges         | 24 river sites (Nzoia at Budalangi, Nyando at Ahero, Tana at Garissa, Nairobi River at Kariobangi, and so on) as ground discs coloured by how far the 10-day forecast peak sits above the last 30 days' median. Click one for the numbers. | GloFAS v4 (Copernicus) via the Open-Meteo Flood API    | 30 min (the model itself updates daily) |
| County Rainfall (7d) | All 47 counties painted by their 7-day rainfall forecast total, with a card per county and a click readout of the daily millimetres.                                                                                                       | Open-Meteo forecast API at each county centroid        | hourly                                  |
| Rainfall Now         | A satellite rainfall-rate picture draped on the globe, half-hourly slots. Needs a globe basemap: switch off Google 3D (Esri or OSM) to see it.                                                                                             | NASA GIBS, GPM IMERG Early run                         | hourly                                  |
| Flood Hotspots       | 33 pins: the Narok hotspots KMD named in August 2026 and the places that flooded in 1997-98, 2019, 2023-24 and March 2026 (Budalangi, Kano Plains, Garissa, Tana Delta, Mandera, Mathare, Mombasa Road, JKIA, Mai Mahiu, and more).        | Hand-compiled from KMD advisories and public reporting | bundled                                 |
| Matatu Routes        | Nairobi's 136 matatu routes in both directions plus 175 termini, so you can see which corridors a flooded river or road cuts.                                                                                                              | Digital Matatus GTFS (2019 survey)                     | bundled                                 |

Location presets now include **Nairobi** (CBD, Mathare, Kariobangi, South C /
Mombasa Road, JKIA) and **Kenya** (whole country, Budalangi, Kano Plains,
Garissa, Tana Delta, Narok, Mandera). Voice understands "show river gauges",
"county rainfall", "rainfall now", "flood hotspots", "matatus", and the named
view "Kenya flood watch".

## What "severity" means on a river gauge

GloFAS is a global hydrological model on a 0.05° grid (about 5 km), not a
physical gauge. For each site the layer takes the median discharge over the
past 30 days as the baseline, finds the largest ensemble-maximum discharge in
the next 10 days, and divides:

| Band        | Peak ÷ 30-day median |
| ----------- | -------------------- |
| STEADY      | under ×1.3           |
| RISING      | ×1.3 to ×2           |
| HIGH        | ×2 to ×4             |
| SEVERE RISE | ×4 and up            |

A channel whose median is under 2 m³/s is treated as dry season and held at
STEADY unless the forecast peak clears 8 m³/s, so a trickle doubling does not
light up the map. These are relative rises, not return periods and not flood
thresholds: a ×4 rise on the Tana is a very different thing from ×4 on the
Voi. Treat the colours as "look here first", then read the numbers.

On first load the layer probes the 3×3 neighbourhood of every site and snaps
to the cell with the most water, because a hand-placed coordinate a few
hundred metres off the channel lands in a dry cell. The snapped coordinates
are cached in the browser for a week. The click readout shows the cell the
model actually answered for.

## Verify it is real

Open the browser developer console after enabling the layers. You should see
requests to `flood-api.open-meteo.com` (two on first load: probe, then the
snapshot), `api.open-meteo.com` (one, with 47 coordinates) and
`gibs.earthdata.nasa.gov` (tiles). The console logs
`[Data:KenyaRiverGauges] Updated: 24 gauges, N rising or worse` and
`[Data:KenyaCountyRain] Updated: 47 counties, N heavy or worse`.

Offline browser proof with fixtures (used in development, where the cloud
sandbox could not reach Open-Meteo):

```bash
npm run build
npx vite preview --port 4173 &
node scripts/qa-kenya.mjs            # fixtures
QA_KENYA_LIVE=1 node scripts/qa-kenya.mjs   # real APIs, needs internet
```

## Known limits

- Coordinates for the gauge sites and hotspots come from public maps and
  reporting, not surveyed positions. `approximate: true` marks the hotspots
  where a settlement was named rather than a point. Fix any in
  `src/layers/kenyaRiverGauges/sites.js` and
  `src/data/local_data/kenya/flood_hotspots.geojsonl`.
- Small urban rivers (Nairobi, Ngong, Mathare) are coarse at 5 km. The
  discharge is indicative; the direction of change is the useful signal.
- There is no live matatu position feed anywhere in Kenya; the routes are the
  2019 network as surveyed. Termini names are as Digital Matatus recorded them.
- Open-Meteo's free tier is for non-commercial use, about 10,000 calls a day.
  A public deployment for paying customers needs their API subscription (or a
  small server-side cache: one fetch per hour serves every visitor).
- The Google 3D Tiles basemap hides the globe, so the IMERG overlay only shows
  on Esri or OSM. The layer row says so.
- KMD publishes no API; its advisories are PDFs and posts. The hotspot file is
  the manual bridge and needs updating when KMD names new places.

## What is not in the upstream repo's licence

The MIT licence covers the code. `DATA_SOURCES.md` lists every dataset and
feed with its own terms. Two things to remember before a commercial launch:
the Nepal event pack (`public/events/bhote-koshi-2026` and
`src/data/bhoteKoshiFloodPath.js`) is CC BY-NC and has to be stripped, and the
Cesium ion free plan and OpenSky free API are non-commercial. The Kenya layers
themselves use CC BY 4.0 and NASA open data.

## Next steps that turn this into a product

1. Done: the fork deploys to GitHub Pages in keyless mode at
   <https://nickyguants.github.io/gods-eye-view/> on every push to
   `kenya-el-nino-2026` (`.github/workflows/deploy-pages.yml`). The Kenya
   layers need no server; the voice agent and the keyed basemaps do.
2. Add Google's Flood Forecasting API gauges (needs a Google Cloud API key)
   as a second, independent river source with real flood thresholds and
   return periods, next to GloFAS.
3. Add Copernicus Global Flood Monitoring (Sentinel-1) flooded-area polygons
   after each satellite pass, so the map shows water that is actually there,
   not only forecast.
4. Cut the matatu network against flooded polygons and closed roads to list
   the routes and termini affected. That list is the sellable thing.
