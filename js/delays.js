// Unreported delays: catching late trains the railroad still shows on time.
//
// A GPS fix proves where a train was at one moment. Two things it can show
// that a railroad's predictions often miss:
//   - Held at a station: a fix taken after the posted departure still has the
//     train stopped at the platform. It can't have left before that fix.
//   - Stuck on the line: a fix taken after the posted arrival at the next stop
//     still has it farther out than it could cover in the time, even running
//     well above its scheduled pace.
// Either way the train is at least that much later than posted. The extra
// delay is only what the GPS proves: nothing is extrapolated past the last
// fix, so a train whose feed updates rarely is never assumed to still be
// sitting there. Later stops are pushed back to what the timetable's running
// times allow from there; where the feed already shows a later time, it wins.

import { delayText } from "./sources.js?v=dev";

const AT_STATION_M = 500;      // long platforms, and station points aren't always where trains stop
const GRACE_MS = 2 * 60000;    // posted times are to the minute; doors take a moment
const MOVING_MPH = 8;          // faster than this, it's already pulling out
const PACE = 1.5;              // how far above its scheduled pace it could close a gap
const MIN_MPH = 25, MAX_MPH = 150;
const MAX_OVER_MS = 3 * 3600000; // further off than this, the feed's stop list is probably stale

function meters(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const iso = (t) => new Date(t).toISOString();

// Puts back what the feed said, so this can run again on every refresh, or
// not at all when the setting is off.
export function restoreFeed(t) {
  const f = t._feed;
  t.inferred = null;
  if (!f) return;
  t.delayMin = f.delayMin;
  t.statusText = f.statusText;
  t.stops?.forEach((s, i) => Object.assign(s, f.stops[i]));
}

// Fastest plausible speed (m/ms) between two stops: well above the pace the
// timetable allows for that stretch, within sensible limits.
function topSpeed(from, to, pFrom, pTo) {
  const mph = (v) => v * 2236.94;
  const dur = ms(to.schArr || to.arr || to.time) - ms(from.schDep || from.dep || from.time);
  const v = dur > 0 ? meters(pFrom, pTo) / dur : 0;
  return Math.min(MAX_MPH, Math.max(MIN_MPH, mph(v) * PACE)) / 2236.94;
}

function find(t, stopPos) {
  const stops = t.stops, fix = t.fixAt, pos = { lat: t.lat, lon: t.lon };
  const first = stops.findIndex((s) => s.status !== "past");
  if (first < 0) return null; // trip's over
  const near = (s) => {
    if (s.here) return true; // the feed says it's standing there
    const p = stopPos.get(s.key);
    return p ? meters(p, pos) <= AT_STATION_M : false;
  };

  // Held: at the stop it last left (by the feed's account) or the one it's at.
  for (const i of [first - 1, first]) {
    const s = stops[i];
    if (!s || !near(s)) continue;
    const dep = ms(s.dep);
    if (i === stops.length - 1 || !dep) return null; // the end of the line, or no departure posted
    if (t.speedMph != null && t.speedMph > MOVING_MPH) return null;
    return fix > dep + GRACE_MS && fix < dep + MAX_OVER_MS ? { kind: "held", i, extra: fix - dep, posted: dep } : null;
  }

  // Stuck: past its posted arrival at the next stop and still out on the line.
  const next = stops[first], prev = stops[first - 1];
  const pNext = stopPos.get(next.key);
  const arr = ms(next.arr || next.time);
  if (!pNext || !(fix > arr + GRACE_MS) || fix > arr + MAX_OVER_MS) return null;
  const d = meters(pos, pNext);
  const pPrev = prev && stopPos.get(prev.key);
  const speed = pPrev ? topSpeed(prev, next, pPrev, pNext) : MAX_MPH / 2236.94;
  const earliest = fix + d / speed;
  return earliest > arr + GRACE_MS ? { kind: "stuck", i: first, extra: earliest - arr, posted: arr, meters: d } : null;
}

export function inferDelay(t, stopPos) {
  if (!t.stops?.length || t.estimated) return;
  t._feed ??= {
    delayMin: t.delayMin,
    statusText: t.statusText,
    stops: t.stops.map((s) => ({ time: s.time, arr: s.arr, dep: s.dep, status: s.status, here: s.here, scheduled: s.scheduled })),
  };
  restoreFeed(t);
  if (!t.fixAt) return; // no GPS fix we can trust the time of
  const hit = find(t, stopPos);
  if (!hit) return;
  const { i } = hit, stop = t.stops[i];
  const held = hit.kind === "held";
  // From here on it runs no faster than the timetable allows: each later time
  // is the new departure (or arrival) plus the scheduled running time to it,
  // unless the feed already shows something later. Feeds without timetable
  // times (LIRR) use the gaps between their own predictions instead.
  const ref = hit.posted + hit.extra;
  const schRef = ms(held ? stop.schDep : stop.schArr);
  const move = (v, sch) => {
    if (!v) return v;
    const cand = schRef && sch ? ref + (ms(sch) - schRef) : ms(v) + hit.extra;
    return iso(Math.max(ms(v), cand));
  };
  t.stops.forEach((s, j) => {
    if (j < i) return;
    if (j > i || !held) {
      s.arr = move(s.arr, s.schArr);
      s.time = move(s.time, s.scheduled);
      if (s.status === "next") s.status = "future";
    }
    s.dep = move(s.dep, s.schDep);
  });
  stop.status = "next";
  if (held) {
    // Still at the platform: show when it can leave, not when it arrived.
    stop.here = true;
    stop.time = stop.dep;
    stop.scheduled = stop.schDep || stop.scheduled;
  }
  // How late it really is, against the timetable where the feed gives one.
  const late = schRef ? (ref - schRef) / 60000 : (t._feed.delayMin ?? 0) + hit.extra / 60000;
  t.delayMin = Math.max(late, t._feed.delayMin ?? -Infinity);
  t.statusText = delayText(t.delayMin);
  t.inferred = { kind: hit.kind, stop: stop.name, tz: stop.tz, posted: hit.posted, earliest: ref, meters: hit.meters ?? null, fix: t.fixAt };
}
