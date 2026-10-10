// Stations: loading, merging and "what's coming" lookups.
//
// data/stations.json lists each railroad's stations separately. Stations that
// sit within a few hundred meters of each other (New York Penn for Amtrak, LIRR
// and NJ Transit; Boston South Station for Amtrak and the MBTA) are merged so
// the map shows one stop with everything that serves it.

import { AGENCIES } from "./sources.js?v=dev";

const MERGE_METERS = 450;
const TOP_INTERCITY = 55; // busiest intercity stations named at every zoom
const INTERCITY = new Set(["amtrak", "via", "brightline"]);
// Order members (and pick the station's color) intercity first.
const PRIORITY = Object.keys(AGENCIES);

// Amtrak, VIA and Brightline share Amtraker station codes, so their stop keys
// use one namespace.
export const stopKey = (agency, id) => `${INTERCITY.has(agency) ? "ic" : agency}:${id}`;

const norm = (s) => String(s || "").toLowerCase().replace(/\b(station|sta|st|street|ave|avenue)\b/g, "").replace(/[^a-z0-9]/g, "");

function meters(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function loadStations() {
  const raw = await (await fetch("data/stations.json?v=dev")).json();
  const members = [];
  for (const [agency, list] of Object.entries(raw)) {
    if (!AGENCIES[agency]) continue;
    // Busyness is counted differently per railroad; compare within each one.
    const maxBusy = Math.max(1, ...list.map((r) => r[7] || 0));
    for (const [id, name, lat, lon, lines, place, code, busy] of list) {
      members.push({ agency, id, key: stopKey(agency, id), name, lat, lon, lines, place, norm: norm(name),
                     code: code || "", busy: (busy || 0) / maxBusy, trips: busy || 0 });
    }
  }
  members.sort((a, b) => PRIORITY.indexOf(a.agency) - PRIORITY.indexOf(b.agency));

  // Grid buckets (~550 m, searched with neighbors) so merging doesn't compare every pair.
  const cell = (lat, lon) => `${Math.floor(lat * 200)}:${Math.floor(lon * 150)}`;
  const grid = new Map();
  const stations = [];
  for (const m of members) {
    let home = null;
    const gx = Math.floor(m.lat * 200), gy = Math.floor(m.lon * 150);
    for (let dx = -1; dx <= 1 && !home; dx++) {
      for (let dy = -1; dy <= 1 && !home; dy++) {
        for (const s of grid.get(`${gx + dx}:${gy + dy}`) || []) {
          // Never merge two stops of the same railroad.
          if (!s.members.some((x) => x.agency === m.agency) && meters(s, m) <= MERGE_METERS) {
            home = s;
            break;
          }
        }
      }
    }
    if (home) {
      home.members.push(m); // keeps the highest-priority railroad's name
      home.place ||= m.place;
    } else {
      const s = { id: m.key, name: m.name, lat: m.lat, lon: m.lon, place: m.place, members: [m] };
      stations.push(s);
      const c = cell(m.lat, m.lon);
      if (!grid.has(c)) grid.set(c, []);
      grid.get(c).push(s);
    }
  }
  for (const s of stations) {
    s.keys = new Set(s.members.map((m) => m.key));
    s.agencies = [...new Set(s.members.map((m) => m.agency))];
    s.major = s.agencies.some((a) => INTERCITY.has(a));
    s.names = new Set(s.members.map((m) => m.norm));
    // Label priority: how busy its busiest railroad says it is, nudged up
    // for intercity service and for hubs shared by several railroads.
    s.rank = Math.max(...s.members.map((m) => m.busy)) + (s.major ? 0.3 : 0) + 0.25 * (s.agencies.length - 1);
  }
  // Named even when zoomed out: the intercity stations with the most trains
  // (Amtrak, VIA and Brightline count trains the same way, so they compare
  // fairly), plus each commuter railroad's busiest station.
  const icTrains = (s) => Math.max(0, ...s.members.filter((m) => INTERCITY.has(m.agency)).map((m) => m.trips));
  [...stations].filter((s) => s.major).sort((a, b) => icTrains(b) - icTrains(a))
    .slice(0, TOP_INTERCITY).forEach((s) => (s.top = true));
  const busiest = new Map(); // commuter railroad -> its busiest station
  for (const s of stations) {
    for (const m of s.members) {
      if (INTERCITY.has(m.agency)) continue;
      if (!busiest.has(m.agency) || m.trips > busiest.get(m.agency)[1]) busiest.set(m.agency, [s, m.trips]);
    }
  }
  // Only when it really stands out (on a single line, every stop sees the same trains).
  const typical = new Map();
  for (const m of members) if (!INTERCITY.has(m.agency)) (typical.get(m.agency) || typical.set(m.agency, []).get(m.agency)).push(m.trips);
  for (const [agency, [s, trips]] of busiest) {
    const t = typical.get(agency).sort((a, b) => a - b);
    if (trips >= 1.5 * t[Math.floor(t.length / 2)]) s.top = true;
  }
  return new Map(stations.map((s) => [s.id, s]));
}

export { meters };

// Trains due at a station, from data already on the map:
//  - trains with full stop lists (Amtrak/VIA/Brightline, LIRR, Metro-North)
//  - trains whose feed only names the next stop (SEPTA, MBTA)
export function trainsDue(station, trains, now = Date.now()) {
  const due = [];
  for (const t of trains) {
    if (!station.agencies.includes(t.agency)) continue;
    if (t.stops?.length) {
      const stop = t.stops.find((s) => s.key && station.keys.has(s.key));
      if (!stop || stop.status === "past") continue;
      const time = Date.parse(stop.time);
      if (Number.isNaN(time) || time < now - 5 * 60000) continue;
      // Without a timetable time (LIRR, Metro-North), a delay Milepost spotted
      // still shows.
      const lateMin = stop.scheduled ? Math.round((time - Date.parse(stop.scheduled)) / 60000) : t.inferred ? t.delayMin : null;
      due.push({
        train: t, time, tz: stop.tz, lateMin,
        here: stop.here || (stop.status === "next" && t.statusText?.startsWith("At ")),
        terminates: stop === t.stops[t.stops.length - 1],
      });
    } else if (t.currentStop && station.names.has(norm(t.currentStop))) {
      due.push({ train: t, time: null, lateMin: t.delayMin, here: true });
    } else if (t.nextStop && station.names.has(norm(t.nextStop))) {
      due.push({ train: t, time: null, lateMin: t.delayMin, here: /^stopped at/i.test(t.statusText || "") });
    }
  }
  due.sort((a, b) => (a.time ?? now) - (b.time ?? now));
  return due;
}

// Live MBTA commuter rail predictions for a station (parent "place-…" id).
export async function mbtaPredictions(placeId) {
  const url = `https://api-v3.mbta.com/predictions?filter%5Bstop%5D=${encodeURIComponent(placeId)}` +
    "&filter%5Broute_type%5D=2&include=trip,route&sort=departure_time";
  const json = await (await fetch(url)).json();
  const inc = new Map((json.included || []).map((x) => [`${x.type}:${x.id}`, x]));
  const now = Date.now();
  return json.data
    .map((p) => {
      const a = p.attributes;
      const time = Date.parse(a.departure_time || a.arrival_time);
      const trip = inc.get(`trip:${p.relationships.trip?.data?.id}`);
      const route = inc.get(`route:${p.relationships.route?.data?.id}`);
      const vehicle = p.relationships.vehicle?.data?.id;
      return {
        time,
        tz: "America/New_York",
        number: trip?.attributes?.name,
        headsign: trip?.attributes?.headsign,
        route: route?.attributes?.long_name,
        status: a.status,
        trainId: vehicle ? `mbta:${vehicle}` : null,
        departing: !a.departure_time ? false : true,
      };
    })
    .filter((p) => p.time && p.time > now - 60000 && p.departing)
    .slice(0, 10);
}
