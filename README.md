# Milepost

A live map of passenger trains across the United States: Amtrak and Brightline plus the commuter railroads that publish real-time positions, all on one map.

**Live site:** https://0kweather.github.io/milepost/

## What's on the map

| Railroad | Region | Feed | Needs |
| --- | --- | --- | --- |
| Amtrak, Brightline, VIA Rail | Nationwide | [Amtraker API](https://amtraker.com) | — |
| MBTA Commuter Rail | Boston | MBTA V3 API | — |
| Long Island Rail Road | New York | MTA GTFS-realtime | — |
| Metro-North | New York | MTA GTFS-realtime (positions estimated from predicted times) | — |
| SEPTA Regional Rail | Philadelphia | SEPTA TrainView | relay |
| RTD commuter rail (A, B, G, N) | Denver | RTD GTFS-realtime | relay |
| FrontRunner | Salt Lake City | UTA GTFS-realtime | relay |
| CapMetro Rail | Austin | CapMetro GTFS-realtime | relay |
| Tri-Rail | South Florida | Tri-Rail GTFS-realtime | relay |
| Metra | Chicago | Metra GTFS-realtime | relay + free key |
| NJ Transit Rail | New Jersey | NJT GTFS-realtime | relay + free account |
| Caltrain, SMART | Bay Area | 511 SF Bay | relay + free key |
| Metrolink | Los Angeles | Metrolink GTFS-realtime | relay + free key |

"Relay" feeds don't send the CORS headers a browser needs, and keyed feeds can't put their key in a public web page, so both go through a tiny Cloudflare Worker (below). Without it, the site still shows everything in the first four rows.

Northstar (Minneapolis) ended rail service; its route is now a bus, so it isn't shown. Not yet covered, because they don't publish public vehicle positions: MARC, VRE, Coaster, SunRail, South Shore Line, Rail Runner, and others. Their trains that Amtrak runs or that share Amtrak's feed (e.g., Hartford Line Amtrak trips) do show up.

## Using it

- **Stations:** every station on these railroads is on the map (intercity stops from regional zoom, commuter stops once you zoom into a metro area). Click one, or search for it, to see which railroads and lines serve it and the next trains due, with live predicted times and delays. Stations shared by several railroads, like New York Penn or Boston South Station, appear as one stop. MBTA stations show the MBTA's own live predictions. For railroads whose feeds don't list stops, the panel shows the trains nearby.
- **Settings** (gear button): light/dark/auto appearance, **Units** (miles or kilometers, for speeds and distances; the default follows your browser's language), **Show stations**, and **Catch unreported delays**.
- **Unreported delays.** Railroads often keep showing a train on time well after it's fallen behind. Milepost checks each GPS fix against the posted times: a train still at the platform after its posted departure (and not moving), or still too far from its next stop to make the posted arrival even running at 1.5× its scheduled pace, is at least that late. Milepost only counts delay the GPS proves, never extrapolates past the last fix, and pushes later stops back by the timetable's running times unless the feed already shows them later. These delays are underlined with dots, and the train page says what the GPS showed. Works for Amtrak, VIA and LIRR trains reporting GPS. Brightline is skipped because its feed doesn't say when a position was taken. It's on by default and can be turned off in Settings (`js/delays.js`).
- **Rail lines are colored by network.** Each stretch of track takes the color of the railroads that run passenger trains on it, and shared track (Amtrak and Metro-North on the New Haven Line, for example) is drawn as side-by-side strands, one per railroad. Hover a line to see who runs on it. Railroads come from USDOT's track ownership and trackage-rights codes, plus the nearest commuter station for commuter trains on freight-owned track.
- **Trains sit on the track.** Reported positions are snapped to the nearest rail line within 1.5 km, preferring the train's own railroad when it's about as close. The rail lines form a graph, so trains placed from the timetable (Metro-North) and slide animations follow the track between two points (a shortest-path route) instead of cutting across curves.
- **Stations sit on the track** too: each is drawn at the nearest point on its railroad's track within 400 m. Terminals like Boston South Station, whose tracks end short of the building, sit at the end of the platforms.
- **Main line only.** Yard tracks, sidings and spurs are left out (from both the passenger network and the basemap), so big terminals don't turn into a tangle.
- Zoomed out, trains are plain dots so the map stays readable; names appear once you zoom in, and labels that would overlap are hidden instead of piling up.
- Search by train number, line, or city. Click a train for its status, next stop, speed and full stop list. The URL updates so you can share a specific train.
- Toggle railroads on or off and filter to intercity or commuter.

## Running locally

It's a static site with no build step:

```bash
python3 -m http.server 8000
```

then open http://localhost:8000. To try the relay feeds locally, run `python3 scripts/dev_relay.py` and set `window.MILEPOST_RELAY = "http://127.0.0.1:8787"` in `config.js`.

## Turning on the relay feeds

1. Create a free Cloudflare account and install Wrangler (`npm i -g wrangler`), or paste `relay/worker.js` into a new Worker in the Cloudflare dashboard.
2. From `relay/`, run `wrangler deploy`.
3. Optional keys (all free), set with `wrangler secret put NAME`:
   - `METRA_API_TOKEN`: https://metra.com/developers
   - `API_511_KEY`: https://511.org/open-data/token (Caltrain + SMART)
   - `METROLINK_API_KEY`: https://metrolinktrains.com/about/gtfs/
   - `NJT_USERNAME` and `NJT_PASSWORD`: https://developer.njtransit.com
4. Put the Worker's URL in `config.js` (`window.MILEPOST_RELAY = "https://milepost-relay.<you>.workers.dev"`) and push.

The relay only serves the feeds listed in `relay/worker.js` (it is not an open proxy) and caches each one for 15 seconds.

## Project layout

```
index.html, css/, js/     the site (MapLibre GL + OpenFreeMap basemap)
js/sources.js             one adapter per feed → common train objects
js/gtfsrt.js              small dependency-free GTFS-realtime decoder
data/mta.json             LIRR/Metro-North station + branch lookups
data/rail.geojson         US and Canadian passenger main lines (USDOT NTAD) tagged by network, merged into continuous lines
data/stations.json        stations for every railroad (NTAD, Amtraker, agency GTFS)
js/stations.js            station merging and "next trains" lookups
js/delays.js              delays the GPS proves but the railroad hasn't posted
js/estimate.js            rail index: snapping to track and routing along it
js/networks.js            rail network names and colors
scripts/                  rebuild the data files; local dev relay
relay/                    Cloudflare Worker for CORS-less and keyed feeds
```

Deploys run through `.github/workflows/pages.yml`, which stamps every file reference (`?v=dev` in the source) with the commit ID so browsers never mix cached files from different versions.

Refresh the static data occasionally with `python3 scripts/build_static.py`, `python3 scripts/build_stations.py`, then `python3 scripts/build_rail.py` (it uses the stations).

Map data © OpenStreetMap contributors, tiles by OpenFreeMap. Train data from the agencies listed above. Rail lines from the USDOT/BTS National Transportation Atlas Database.
