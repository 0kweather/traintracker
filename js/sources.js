// Railroads and the feeds that locate their trains.
//
// Every source turns its feed into a list of plain "train" objects:
//   { id, agency, number, route, routeColor, lat, lon, bearing, speedMph,
//     origin, destination, nextStop, delayMin, statusText, updated,
//     estimated, stops: [{ key, name, time, status, arr, dep, ... }] }
//
// "direct" sources send CORS headers, so the browser can read them from any
// site. "relay" sources don't (or need an API key), so they go through the
// small Cloudflare Worker in /relay when one is configured.

import { decodeFeed } from "./gtfsrt.js?v=dev";

export const AGENCIES = {
  amtrak:     { name: "Amtrak",              short: "Amtrak",   region: "Nationwide",          color: "#1f5fad", kind: "intercity" },
  brightline: { name: "Brightline",          short: "Brightline", region: "Florida",           color: "#d9a400", kind: "intercity" },
  via:        { name: "VIA Rail",            short: "VIA",      region: "Canada",              color: "#c8102e", kind: "intercity" },
  mbta:       { name: "MBTA Commuter Rail",  short: "MBTA",     region: "Boston",              color: "#80276c", kind: "commuter" },
  lirr:       { name: "Long Island Rail Road", short: "LIRR",   region: "New York",            color: "#0b8a7e", kind: "commuter" },
  mnr:        { name: "Metro-North",         short: "Metro-North", region: "New York",         color: "#d7263d", kind: "commuter" },
  njt:        { name: "NJ Transit Rail",     short: "NJT",      region: "New Jersey",          color: "#f47b20", kind: "commuter" },
  septa:      { name: "SEPTA Regional Rail", short: "SEPTA",    region: "Philadelphia",        color: "#5b6e7f", kind: "commuter" },
  metra:      { name: "Metra",               short: "Metra",    region: "Chicago",             color: "#0096d6", kind: "commuter" },
  rtd:        { name: "RTD Commuter Rail",   short: "RTD",      region: "Denver",              color: "#2e9bd6", kind: "commuter" },
  frontrunner:{ name: "UTA FrontRunner",     short: "FrontRunner", region: "Salt Lake City",   color: "#8e44ad", kind: "commuter" },
  capmetro:   { name: "CapMetro Rail",       short: "CapMetro", region: "Austin",              color: "#e0218a", kind: "commuter" },
  trirail:    { name: "Tri-Rail",            short: "Tri-Rail", region: "South Florida",       color: "#2ba84a", kind: "commuter" },
  caltrain:   { name: "Caltrain",            short: "Caltrain", region: "San Francisco",       color: "#e31837", kind: "commuter" },
  smart:      { name: "SMART",               short: "SMART",    region: "Sonoma–Marin",        color: "#3f9b3f", kind: "commuter" },
  metrolink:  { name: "Metrolink",           short: "Metrolink", region: "Los Angeles",        color: "#00a3ad", kind: "commuter" },
};

const STALE_SECONDS = 20 * 60;
const nowSec = () => Date.now() / 1000;

// ---------- helpers ----------

const COMPASS = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

function bearingBetween(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x =
    Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
    Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function delayText(min) {
  if (min == null || Number.isNaN(min)) return null;
  if (min <= 1) return "On time";
  if (min < 60) return `${Math.round(min)} min late`;
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${h} h ${m} min late`;
}

const mps2mph = (v) => (v == null ? null : v * 2.23694);
const valid = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0);

function train(fields) {
  return { bearing: null, speedMph: null, origin: null, destination: null, nextStop: null,
           delayMin: null, statusText: null, estimated: false, stops: null, route: null,
           routeColor: null, updated: Date.now(), ...fields };
}

// ---------- Amtrak, VIA, Brightline (Amtraker) ----------

function departureDay(first) {
  const iso = first?.schDep || first?.dep;
  if (!iso) return null;
  try {
    const opts = { weekday: "short", month: "short", day: "numeric", timeZone: first.tz };
    const day = new Date(iso).toLocaleDateString([], opts);
    return day === new Date().toLocaleDateString([], opts) ? null : day; // only worth showing for multi-day trips
  } catch {
    return null;
  }
}

// When the train's GPS position was taken, if the feed says so reliably.
// Some Amtrak trains report local time under the wrong offset (hours in the
// future), and Brightline's time is just when the data was fetched.
function fixTime(agency, ts) {
  const t = Date.parse(ts);
  if (agency === "brightline" || !t || t > Date.now() + 60000) return null;
  return t;
}

const AMTRAKER_PROVIDERS = { Amtrak: "amtrak", Via: "via", Brightline: "brightline" };

function parseAmtraker(json) {
  const out = [];
  for (const list of Object.values(json)) {
    for (const t of list) {
      const agency = AMTRAKER_PROVIDERS[t.provider];
      if (!agency || t.trainState !== "Active" || !valid(t.lat, t.lon)) continue;
      const stations = t.stations || [];
      const next = stations.find((s) => s.status === "Enroute" || s.status === "Station");
      let delayMin = null;
      if (next && next.arr && next.schArr) delayMin = (Date.parse(next.arr) - Date.parse(next.schArr)) / 60000;
      else if (next && next.dep && next.schDep) delayMin = (Date.parse(next.dep) - Date.parse(next.schDep)) / 60000;
      out.push(train({
        id: `${agency}:${t.trainID}`,
        agency,
        number: agency === "via" ? String(t.trainNum).replace(/^v/i, "") : t.trainNum, // Amtraker prefixes VIA numbers with "v"
        route: t.routeName,
        lat: t.lat, lon: t.lon,
        bearing: COMPASS[t.heading] ?? null,
        speedMph: t.velocity,
        origin: t.origName,
        destination: t.destName,
        nextStop: next ? next.name : null,
        delayMin,
        statusText: delayText(delayMin),
        updated: Math.min(Date.parse(t.lastValTS) || Date.now(), Date.now()),
        fixAt: fixTime(agency, t.lastValTS),
        alerts: (t.alerts || []).map((a) => a.message).filter(Boolean), // official notices for this train
        // Long-distance trains run for days, so the same number can be on the map twice.
        departedOn: departureDay(stations[0]),
        stops: stations.map((s) => ({
          key: `ic:${s.code}`,
          name: s.name,
          tz: s.tz,
          time: s.status === "Departed" ? s.dep || s.arr : s.arr || s.dep,
          scheduled: s.schArr || s.schDep,
          arr: s.arr || null, dep: s.dep || null, schArr: s.schArr || null, schDep: s.schDep || null,
          status: s.status === "Departed" ? "past" : s === next ? "next" : "future",
          here: s.status === "Station", // standing at this station right now
        })),
      }));
    }
  }
  return out;
}

// ---------- MBTA ----------

const MBTA_ROUTES = {
  "CR-NewBedford": "Fall River/New Bedford Line",
  "CR-Foxboro": "Foxboro Event Service",
  "CR-Worcester": "Framingham/Worcester Line",
  "CR-Needham": "Needham Line",
};

function parseMbta(json) {
  const included = new Map((json.included || []).map((x) => [`${x.type}:${x.id}`, x]));
  const out = [];
  for (const v of json.data) {
    const a = v.attributes;
    if (!valid(a.latitude, a.longitude)) continue;
    const routeId = v.relationships.route?.data?.id || "";
    const trip = included.get(`trip:${v.relationships.trip?.data?.id}`);
    const stop = included.get(`stop:${v.relationships.stop?.data?.id}`);
    const stopName = stop?.attributes?.name || null;
    out.push(train({
      id: `mbta:${v.id}`,
      agency: "mbta",
      routeId,
      tripId: v.relationships.trip?.data?.id || null,
      number: trip?.attributes?.name || a.label,
      route: MBTA_ROUTES[routeId] || routeId.replace(/^CR-/, "").replace(/([a-z])([A-Z])/g, "$1 $2") + " Line",
      routeColor: "#80276c",
      lat: a.latitude, lon: a.longitude,
      bearing: a.bearing,
      speedMph: mps2mph(a.speed),
      destination: trip?.attributes?.headsign || null,
      nextStop: stopName,
      statusText: a.current_status === "STOPPED_AT" && stopName ? `Stopped at ${stopName}` : null,
      updated: Date.parse(a.updated_at) || Date.now(),
    }));
  }
  return out;
}

// ---------- MTA (LIRR + Metro-North) ----------

let mtaStatic = null;
async function loadMtaStatic() {
  mtaStatic ??= fetch("data/mta.json?v=dev").then((r) => r.json());
  return mtaStatic;
}

const evTime = (s) => s.departure?.time || s.arrival?.time || 0;
const arrTime = (s) => s.arrival?.time || s.departure?.time || 0;

// Works out where a trip is from its (predicted) stop times: at a station, or
// part-way between the last stop it left and the next one it will reach.
function tripProgress(stops, now, lookup) {
  const list = stops.filter((s) => !s.skipped && lookup[s.stopId] && evTime(s));
  if (list.length < 2) return null;
  if (now < evTime(list[0]) - 60 || now > arrTime(list[list.length - 1]) + 60) return null;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const here = lookup[s.stopId];
    if (now >= arrTime(s) && now <= evTime(s)) {
      return { at: s, lat: here[1], lon: here[2], prev: s, next: list[i + 1] || s, list, dwelling: true };
    }
    const n = list[i + 1];
    if (n && now > evTime(s) && now < arrTime(n)) {
      const there = lookup[n.stopId];
      const f = (now - evTime(s)) / Math.max(1, arrTime(n) - evTime(s));
      return {
        lat: here[1] + (there[1] - here[1]) * f,
        lon: here[2] + (there[2] - here[2]) * f,
        bearing: bearingBetween([here[1], here[2]], [there[1], there[2]]),
        // The stations it's between, so the map can follow the track.
        leg: { from: [here[2], here[1]], to: [there[2], there[1]], f },
        prev: s, next: n, list,
      };
    }
  }
  // Before first departure or right at the end.
  const s = now < evTime(list[0]) ? list[0] : list[list.length - 1];
  const p = lookup[s.stopId];
  return { at: s, lat: p[1], lon: p[2], prev: s, next: s, list, dwelling: true };
}

function mtaStops(agency, list, lookup, now, nextStop, dwellingAt) {
  return list.map((s) => ({
    here: s === dwellingAt,
    key: `${agency}:${s.stopId}`,
    name: lookup[s.stopId][0],
    tz: "America/New_York",
    time: new Date(evTime(s) * 1000).toISOString(),
    arr: s.arrival?.time ? new Date(s.arrival.time * 1000).toISOString() : null,
    dep: s.departure?.time ? new Date(s.departure.time * 1000).toISOString() : null,
    status: s === nextStop ? "next" : evTime(s) < now ? "past" : "future",
  }));
}

function parseMta(agency, buf, meta) {
  const feed = decodeFeed(buf);
  const now = nowSec();
  const { stops: lookup, routes } = meta;
  const vpByTrip = new Map();
  for (const v of feed.vehicles) if (v.trip?.tripId) vpByTrip.set(v.trip.tripId, v);

  const out = [];
  for (const tu of feed.tripUpdates) {
    const tripId = tu.trip?.tripId;
    const prog = tripProgress(tu.stops, now, lookup);
    if (!prog) continue;
    const vp = tu.entityVehicle || vpByTrip.get(tripId);
    const fresh = vp?.position && valid(vp.position.lat, vp.position.lon) && now - (vp.timestamp || 0) < STALE_SECONDS;
    // Metro-North lists bus substitutions as letter-prefixed trips ("EB1973",
    // "LB1973"); they're buses on roads, not trains.
    const label = vp?.vehicle?.label || tu.vehicle?.label || "";
    if (agency === "mnr" && /^[A-Z]+\d/.test(label)) continue;
    const route = routes[tu.trip.routeId];
    const last = prog.list[prog.list.length - 1];
    const nextStop = prog.dwelling ? prog.at : prog.next;
    const delaySec = nextStop.arrival?.delay ?? nextStop.departure?.delay;
    // LIRR trip ids carry the train number after the schedule prefix
    // ("GO202_26_6754", sometimes with a suffix like "_1" or "_2953_METS");
    // Metro-North puts it in the vehicle label.
    const number = agency === "mnr"
      ? vp?.vehicle?.label || tu.vehicle?.label || tripId
      : (tripId || "").match(/^[A-Z]+\d*_\d+_(\d+)/)?.[1] || (tripId || "").split("_").pop();
    out.push(train({
      id: `${agency}:${tripId}`,
      agency,
      routeId: tu.trip.routeId || null,
      tripId,
      number,
      route: route ? route[0] : null,
      routeColor: route ? route[1] : null,
      lat: fresh ? vp.position.lat : prog.lat,
      lon: fresh ? vp.position.lon : prog.lon,
      bearing: fresh && vp.position.bearing ? vp.position.bearing : prog.bearing ?? null,
      speedMph: fresh ? mps2mph(vp.position.speed) : null,
      origin: lookup[prog.list[0].stopId][0],
      destination: lookup[last.stopId][0],
      nextStop: lookup[nextStop.stopId][0],
      delayMin: delaySec != null ? delaySec / 60 : null,
      statusText: prog.dwelling ? `At ${lookup[prog.at.stopId][0]}` : delaySec != null ? delayText(delaySec / 60) : null,
      updated: fresh ? vp.timestamp * 1000 : (feed.timestamp || now) * 1000,
      fixAt: fresh ? vp.timestamp * 1000 : null,
      estimated: !fresh,
      leg: fresh ? null : prog.leg || null,
      stops: mtaStops(agency, prog.list, lookup, now, nextStop, prog.dwelling ? prog.at : null),
      // Kept so estimated positions can be advanced between refreshes.
      _progress: fresh ? null : { stops: tu.stops, lookup },
    }));
  }
  return out;
}

// Recomputes estimated (schedule-interpolated) positions so they keep moving
// between feed refreshes.
export function advanceEstimated(t) {
  if (!t._progress) return false;
  const p = tripProgress(t._progress.stops, nowSec(), t._progress.lookup);
  if (!p) return false;
  t.lat = p.lat;
  t.lon = p.lon;
  t.leg = p.leg || null;
  if (p.bearing != null) t.bearing = p.bearing;
  return true;
}

// ---------- Generic GTFS-realtime vehicle feeds ----------

function gtfsVehicles(agency, buf, { keep = () => true, route, number, destination } = {}) {
  const feed = decodeFeed(buf);
  const now = nowSec();
  const seen = new Set();
  const out = [];
  for (const v of feed.vehicles) {
    const p = v.position;
    if (!p || !valid(p.lat, p.lon) || !keep(v)) continue;
    if (v.timestamp && now - v.timestamp > STALE_SECONDS) continue;
    const key = v.vehicle?.id || v.trip?.tripId || `${p.lat},${p.lon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(train({
      id: `${agency}:${key}`,
      agency,
      number: number ? number(v) : v.vehicle?.label || v.vehicle?.id || null,
      route: route ? route(v) : v.trip?.routeId || null,
      lat: p.lat, lon: p.lon,
      bearing: p.bearing || null,
      speedMph: mps2mph(p.speed),
      destination: destination ? destination(v) : null,
      updated: (v.timestamp || feed.timestamp || now) * 1000,
    }));
  }
  return out;
}

// ---------- SEPTA ----------

function parseSepta(json) {
  return json
    // TrainView keeps some parked trains listed as many hours "late"; skip them.
    .filter((t) => valid(+t.lat, +t.lon) && !(t.late > 600))
    .map((t) => train({
      id: `septa:${t.trainno}`,
      agency: "septa",
      number: t.trainno,
      route: /line$/i.test(t.line) ? t.line : `${t.line} Line`,
      lat: +t.lat, lon: +t.lon,
      bearing: t.heading != null && t.heading !== "" ? +t.heading : null,
      origin: t.SOURCE,
      destination: t.dest,
      nextStop: t.nextstop,
      currentStop: t.currentstop,
      delayMin: t.late,
      statusText: delayText(t.late),
      detail: t.consist ? `Cars ${t.consist.replace(/,/g, ", ")}` : null,
    }));
}

// ---------- Source table ----------

const RTD_LINES = { A: "A Line", "113B": "B Line", "113G": "G Line", "117N": "N Line" };

export const SOURCES = [
  {
    id: "amtraker", agencies: ["amtrak", "via", "brightline"], format: "json", interval: 60,
    url: "https://api-v3.amtraker.com/v3/trains",
    credit: { label: "Amtraker", href: "https://amtraker.com" },
    parse: parseAmtraker,
  },
  {
    id: "mbta", agencies: ["mbta"], format: "json", interval: 20,
    url: "https://api-v3.mbta.com/vehicles?filter%5Broute_type%5D=2&include=trip,stop",
    credit: { label: "MBTA V3 API", href: "https://www.mbta.com/developers" },
    parse: parseMbta,
  },
  {
    id: "lirr", agencies: ["lirr"], format: "pb", interval: 30,
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr",
    credit: { label: "MTA", href: "https://api.mta.info" },
    parse: async (buf) => parseMta("lirr", buf, (await loadMtaStatic()).lirr),
  },
  {
    id: "mnr", agencies: ["mnr"], format: "pb", interval: 30,
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr",
    credit: { label: "MTA", href: "https://api.mta.info" },
    parse: async (buf) => parseMta("mnr", buf, (await loadMtaStatic()).mnr),
  },
  // ----- through the relay (no CORS headers upstream) -----
  {
    id: "septa", agencies: ["septa"], format: "json", interval: 30, relay: true,
    credit: { label: "SEPTA", href: "https://www3.septa.org/developer/" },
    parse: parseSepta,
  },
  {
    id: "rtd", agencies: ["rtd"], format: "pb", interval: 30, relay: true,
    credit: { label: "RTD", href: "https://www.rtd-denver.com/open-records/open-spatial-information/real-time-feeds" },
    parse: (buf) => gtfsVehicles("rtd", buf, {
      keep: (v) => v.trip?.routeId in RTD_LINES,
      route: (v) => RTD_LINES[v.trip.routeId],
      number: () => null, // the feed has no public train numbers
    }),
  },
  {
    id: "uta", agencies: ["frontrunner"], format: "pb", interval: 30, relay: true,
    credit: { label: "UTA", href: "https://developer.rideuta.com" },
    parse: (buf) => gtfsVehicles("frontrunner", buf, {
      // FrontRunner consists report as L1, L2, ...; TRAX and buses use numeric ids.
      keep: (v) => /^L\d+$/.test(v.vehicle?.id || ""),
      route: () => "FrontRunner",
      number: () => null,
    }),
  },
  {
    id: "capmetro", agencies: ["capmetro"], format: "pb", interval: 30, relay: true,
    credit: { label: "CapMetro", href: "https://data.texas.gov" },
    parse: (buf) => gtfsVehicles("capmetro", buf, {
      keep: (v) => v.trip?.routeId === "550",
      route: () => "Red Line",
      number: () => null,
    }),
  },
  {
    id: "trirail", agencies: ["trirail"], format: "pb", interval: 30, relay: true,
    credit: { label: "Tri-Rail", href: "https://www.tri-rail.com" },
    parse: (buf) => gtfsVehicles("trirail", buf, {
      route: () => "Tri-Rail",
      number: (v) => (v.vehicle?.label || "").replace(/^P/, "") || null, // "P625" is train 625
    }),
  },
  // ----- through the relay, with an API key stored on the relay -----
  {
    id: "metra", agencies: ["metra"], format: "pb", interval: 30, relay: true, needsKey: "METRA_API_TOKEN",
    credit: { label: "Metra", href: "https://metra.com/developers" },
    parse: (buf) => gtfsVehicles("metra", buf, {
      route: (v) => v.trip?.routeId,
      // Metra trip ids look like "UP-N_UN303_V3_A"; the train number is in the middle.
      number: (v) => (v.trip?.tripId || "").split("_")[1]?.replace(/^\D+/, "") || v.vehicle?.label,
    }),
  },
  {
    id: "njt", agencies: ["njt"], format: "pb", interval: 30, relay: true, needsKey: "NJT_USERNAME",
    credit: { label: "NJ Transit", href: "https://developer.njtransit.com" },
    parse: (buf) => gtfsVehicles("njt", buf),
  },
  {
    id: "caltrain", agencies: ["caltrain"], format: "pb", interval: 30, relay: true, needsKey: "API_511_KEY",
    credit: { label: "511 SF Bay", href: "https://511.org/open-data" },
    parse: (buf) => gtfsVehicles("caltrain", buf, { route: (v) => v.trip?.routeId || "Caltrain" }),
  },
  {
    id: "smart", agencies: ["smart"], format: "pb", interval: 30, relay: true, needsKey: "API_511_KEY",
    credit: { label: "511 SF Bay", href: "https://511.org/open-data" },
    parse: (buf) => gtfsVehicles("smart", buf, { route: () => "SMART" }),
  },
  {
    id: "metrolink", agencies: ["metrolink"], format: "pb", interval: 30, relay: true, needsKey: "METROLINK_API_KEY",
    credit: { label: "Metrolink", href: "https://metrolinktrains.com/about/gtfs/" },
    parse: (buf) => gtfsVehicles("metrolink", buf, { route: (v) => v.trip?.routeId }),
  },
];

export async function fetchSource(src, relayBase) {
  // A per-feed address in config.js wins (for feeds that block the relay).
  const override = (window.MILEPOST_FEEDS || {})[src.id];
  const url = override || (src.relay ? `${relayBase.replace(/\/$/, "")}/feed/${src.id}` : src.url);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = src.format === "pb" ? await res.arrayBuffer() : await res.json();
  return src.parse(body);
}
