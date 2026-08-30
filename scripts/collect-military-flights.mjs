#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ASDBDB_AIRCRAFT_URL, ADSB_MIL_URL, normalizeMilitaryFeed, readJsonInput } from "./lib/militaryFlightNormalizer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = resolve(ROOT, "flight-data");
const DEFAULT_TIMEOUT_MS = 15_000;
const ENRICHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days for identity facts
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours before retrying a miss
const ENRICHMENT_CONCURRENCY = 2;
const ENRICHMENT_MIN_DELAY_MS = 500; // stay gentle on a keyless public API

function option(name, fallback = null) {
  const prefix = "--" + name + "=";
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function parseTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout-ms must be a positive number");
  return timeout;
}

async function fetchJson(url, timeoutMs, { sourceLabel = "request" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        // adsb.lol rejects the default Node fetch user agent with HTTP 403.
        "user-agent": "WorldSITREP-military-flight-collector/1.0 (+https://worldsitrep.com)",
      },
    });
    if (!response.ok) throw new Error(sourceLabel + " request failed with HTTP " + response.status);
    try { return await response.json(); }
    catch (error) { throw new Error(sourceLabel + " returned invalid JSON: " + error.message, { cause: error }); }
  } catch (error) {
    if (error.name === "AbortError") throw new Error(sourceLabel + " request timed out after " + timeoutMs + " ms");
    if (error.message.startsWith(sourceLabel)) throw error;
    throw new Error(sourceLabel + " request failed: " + error.message, { cause: error });
  } finally { clearTimeout(timer); }
}

async function atomicJsonWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + process.pid + "." + Date.now() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function existingJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function archivePath(output, collectedAt) {
  const date = new Date(collectedAt);
  if (Number.isNaN(date.getTime())) throw new Error("--collected-at must be a valid ISO date");
  return resolve(output, "archive", String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0") + ".jsonl");
}

/**
 * Look up registered-owner/operator country for each hex using the free
 * adsbdb aircraft database. Results are cached in enrichment-cache.json so
 * repeated 30-minute runs stay gentle. Failures never block a snapshot.
 */
export async function loadEnrichment({ hexes, cachePath, timeoutMs, now = Date.now() }) {
  const cache = (await existingJson(cachePath)) || { schemaVersion: 1, entries: {} };
  const entries = cache.entries && typeof cache.entries === "object" ? cache.entries : {};
  const pending = [];
  for (const hex of hexes) {
    const key = String(hex || "").toLowerCase();
    if (!key) continue;
    const entry = entries[key];
    if (entry && entry.fetchedAt && entry.status === "ok" && now - Date.parse(entry.fetchedAt) < ENRICHMENT_TTL_MS) continue;
    if (entry && entry.fetchedAt && entry.status === "not-found" && now - Date.parse(entry.fetchedAt) < NEGATIVE_TTL_MS) continue;
    if (entry && entry.fetchedAt && entry.status === "error" && now - Date.parse(entry.fetchedAt) < NEGATIVE_TTL_MS) continue;
    pending.push(key);
  }
  let lastError = null;
  for (let index = 0; index < pending.length; index += ENRICHMENT_CONCURRENCY) {
    const batch = pending.slice(index, index + ENRICHMENT_CONCURRENCY);
    await Promise.all(batch.map(async (key) => {
      try {
        const payload = await fetchJson(ASDBDB_AIRCRAFT_URL + encodeURIComponent(key.toUpperCase()), timeoutMs, { sourceLabel: "adsbdb" });
        const aircraft = payload && payload.response && payload.response.aircraft ? payload.response.aircraft : null;
        entries[key] = aircraft
          ? { schemaVersion: 1, status: "ok", source: { id: "adsbdb", url: ASDBDB_AIRCRAFT_URL }, fetchedAt: new Date(now).toISOString(), aircraft }
          : { schemaVersion: 1, status: "not-found", source: { id: "adsbdb", url: ASDBDB_AIRCRAFT_URL }, fetchedAt: new Date(now).toISOString() };
      } catch (error) {
        lastError = error;
        entries[key] = { schemaVersion: 1, status: "error", source: { id: "adsbdb", url: ASDBDB_AIRCRAFT_URL }, fetchedAt: new Date(now).toISOString(), message: error.message };
      }
    }));
    if (index + ENRICHMENT_CONCURRENCY < pending.length) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, ENRICHMENT_MIN_DELAY_MS));
    }
  }
  await atomicJsonWrite(cachePath, { schemaVersion: 1, entries });
  return { entries, error: lastError };
}

export async function collect({ inputPath, output = DEFAULT_OUTPUT, collectedAt, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const collectionTime = collectedAt || new Date().toISOString();
  const sourceUrl = process.env.ADSB_MILITARY_URL || ADSB_MIL_URL;
  const payload = inputPath ? await readJsonInput(resolve(inputPath)) : await fetchJson(sourceUrl, parseTimeout(timeoutMs), { sourceLabel: "adsb.lol" });
  const latest = resolve(output, "latest.json");
  const previous = await existingFeed(latest);
  const cachePath = resolve(output, "enrichment-cache.json");
  const hexes = (Array.isArray(payload?.ac) ? payload.ac : Array.isArray(payload?.aircraft) ? payload.aircraft : Array.isArray(payload) ? payload : [])
    .map((record) => String(record?.hex || "").toLowerCase())
    .filter(Boolean);
  const enrichment = await loadEnrichment({ hexes, cachePath, timeoutMs: parseTimeout(timeoutMs), now: Date.parse(collectionTime) || Date.now() });
  const feed = normalizeMilitaryFeed(payload, {
    collectedAt: collectionTime,
    sourceUrl,
    enrichmentByHex: enrichment.entries,
    previousAircraft: previous && Array.isArray(previous.aircraft) ? previous.aircraft : [],
  });
  const archive = archivePath(output, feed.collectedAt);
  if (previous && JSON.stringify(previous.aircraft) === JSON.stringify(feed.aircraft)) {
    return { latest, archive: null, feed: previous, changed: false };
  }
  await atomicJsonWrite(latest, feed);
  await mkdir(dirname(archive), { recursive: true });
  await appendFile(archive, JSON.stringify(feed) + "\n", "utf8");
  return { latest, archive, feed, changed: true };
}

async function existingFeed(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    const result = await collect({ inputPath: option("input"), output: option("output", DEFAULT_OUTPUT), collectedAt: option("collected-at"), timeoutMs: option("timeout-ms", DEFAULT_TIMEOUT_MS) });
    console.log(result.changed ? "Collected " + result.feed.count + " aircraft; wrote " + result.latest + " and " + result.archive : "No meaningful aircraft change; left latest/archive unchanged");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
