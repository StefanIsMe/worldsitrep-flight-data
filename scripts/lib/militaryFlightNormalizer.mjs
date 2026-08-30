import { readFile } from "node:fs/promises";

export const ADSB_MIL_URL = "https://api.adsb.lol/v2/mil";
export const SOURCE_ID = "adsb.lol";
export const SCHEMA_VERSION = 1;

const CLASSIFICATION_RULES = [
  ["fighter", /\b(f[- ]?(15|16|18|22|35)[a-z0-9-]*|su[- ]?(27|30|33|34|35|57)|mig[- ]?(29|31)|jas[- ]?39|rafale|typhoon|eurofighter|gripen)\b/i],
  ["bomber", /\b(b[- ]?1|b[- ]?2|b[- ]?52|tu[- ]?(22|95|160)|h[- ]?6|bomb(er)?)\b/i],
  ["tanker", /\b(kc[- ]?10|kc[- ]?135|a330[ -]?mrtt|il[- ]?78|tanker|aerial refuel)\b/i],
  ["transport", /\b(c[- ]?17|c[- ]?130|a400m|an[- ]?124|an[- ]?225|il[- ]?76|transport)\b/i],
  ["awacs", /\b(e[- ]?2|e[- ]?3|e[- ]?7|e[- ]?8|a[- ]?50|awacs|aew|early warning)\b/i],
  ["maritime-patrol", /\b(p[- ]?3|p[- ]?8|atlantique|maritime patrol|asw)\b/i],
  ["helicopter", /\b(ah[- ]?64|ch[- ]?47|ch[- ]?53|mh[- ]?60|uh[- ]?60|mi[- ]?[238]|ka[- ]?52|helicopter)\b/i],
  ["uav", /\b(mq[- ]?1|mq[- ]?9|rq[- ]?4|rq[- ]?170|tb2|uav|drone|reaper|global hawk)\b/i],
  ["trainer", /\b(t[- ]?[67]|tornado|hawk|trainer)\b/i],
];

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function nullableText(value) { const result = text(value); return result || null; }
function finiteNumber(value) {
  if (typeof value === "string" && value.trim() === "") return null;
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : null;
}
function rounded(value, digits = 0) {
  const number = finiteNumber(value); if (number === null) return null;
  const factor = 10 ** digits; return Math.round(number * factor) / factor;
}
function isoDate(value, fallback) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}
function sourceMetadata(sourceUrl = ADSB_MIL_URL) { return { id: SOURCE_ID, url: sourceUrl }; }

export function classifyAircraft(record) {
  const haystack = [record.type, record.description, record.operator, record.category].map(text).filter(Boolean).join(" ");
  for (const [classification, rule] of CLASSIFICATION_RULES) {
    if (rule.test(haystack)) return { classification, classificationMethod: "model-designation-rule", classificationConfidence: "medium" };
  }
  return { classification: "unknown", classificationMethod: "insufficient-evidence", classificationConfidence: "unknown" };
}

export function normalizeAircraft(record, { collectedAt, sourceUrl = ADSB_MIL_URL } = {}) {
  if (!record || typeof record !== "object") return null;
  const hex = text(record.hex).toLowerCase();
  const lat = finiteNumber(record.lat); const lng = finiteNumber(record.lon ?? record.lng);
  if (!hex || lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const collectionTime = isoDate(collectedAt, new Date(0));
  const seenPosition = finiteNumber(record.seen_pos ?? record.seen);
  const observedAt = seenPosition !== null && seenPosition >= 0 ? new Date(new Date(collectionTime).getTime() - seenPosition * 1000).toISOString() : collectionTime;
  const operator = nullableText(record.ownop ?? record.operator ?? record.owner);
  const type = nullableText(record.t ?? record.type); const description = nullableText(record.desc ?? record.description);
  const country = nullableText(record.country); const classification = classifyAircraft({ type, description, operator, category: record.category });
  return {
    id: hex, hex, callsign: nullableText(record.flight ?? record.callsign), registration: nullableText(record.r), type, description, operator,
    operatorConfidence: operator ? "reported" : "unknown", country, countryConfidence: country ? "reported" : "unknown",
    classification: classification.classification, classificationMethod: classification.classificationMethod, classificationConfidence: classification.classificationConfidence,
    lat: rounded(lat, 5), lng: rounded(lng, 5), observedAt, ageSeconds: seenPosition !== null && seenPosition >= 0 ? rounded(seenPosition, 1) : null,
    telemetry: { altitudeFeet: rounded(record.alt_baro ?? record.altitude, 0), groundSpeedKnots: rounded(record.gs ?? record.speed, 1), headingDegrees: rounded(record.track ?? record.heading, 1), verticalRateFeetPerMinute: rounded(record.baro_rate ?? record.verticalRate, 0), squawk: nullableText(record.squawk) },
    source: sourceMetadata(sourceUrl),
  };
}

export function normalizeMilitaryFeed(payload, { collectedAt = new Date().toISOString(), sourceUrl = ADSB_MIL_URL } = {}) {
  // adsb.lol's /v2/mil endpoint returns { ac: [...] }; retain support for
  // normalized fixtures/envelopes that already use { aircraft: [...] }.
  const records = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.ac)
      ? payload.ac
      : payload && Array.isArray(payload.aircraft)
        ? payload.aircraft
        : null;
  if (!records) throw new TypeError("adsb.lol response must contain an aircraft array");
  const aircraft = records.map((record) => normalizeAircraft(record, { collectedAt, sourceUrl })).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
  return { schemaVersion: SCHEMA_VERSION, collectedAt: isoDate(collectedAt, new Date(0)), source: sourceMetadata(sourceUrl), count: aircraft.length, aircraft };
}

export async function readJsonInput(filePath) {
  const raw = await readFile(filePath, "utf8");
  try { return JSON.parse(raw); } catch (error) { throw new Error("Invalid JSON input " + filePath + ": " + error.message, { cause: error }); }
}
