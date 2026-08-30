#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADSB_MIL_URL, normalizeMilitaryFeed, readJsonInput } from "./lib/militaryFlightNormalizer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = resolve(ROOT, "flight-data");
const DEFAULT_TIMEOUT_MS = 15_000;

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

async function fetchJson(url, timeoutMs) {
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
    if (!response.ok) throw new Error("adsb.lol request failed with HTTP " + response.status);
    try { return await response.json(); }
    catch (error) { throw new Error("adsb.lol returned invalid JSON: " + error.message, { cause: error }); }
  } catch (error) {
    if (error.name === "AbortError") throw new Error("adsb.lol request timed out after " + timeoutMs + " ms");
    if (error.message.startsWith("adsb.lol")) throw error;
    throw new Error("adsb.lol request failed: " + error.message, { cause: error });
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

async function existingFeed(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function archivePath(output, collectedAt) {
  const date = new Date(collectedAt);
  if (Number.isNaN(date.getTime())) throw new Error("--collected-at must be a valid ISO date");
  return resolve(output, "archive", String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0") + ".jsonl");
}

export async function collect({ inputPath, output = DEFAULT_OUTPUT, collectedAt, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const collectionTime = collectedAt || new Date().toISOString();
  const sourceUrl = process.env.ADSB_MILITARY_URL || ADSB_MIL_URL;
  const payload = inputPath ? await readJsonInput(resolve(inputPath)) : await fetchJson(sourceUrl, parseTimeout(timeoutMs));
  const feed = normalizeMilitaryFeed(payload, { collectedAt: collectionTime, sourceUrl });
  const latest = resolve(output, "latest.json");
  const archive = archivePath(output, feed.collectedAt);
  const previous = await existingFeed(latest);
  if (previous && JSON.stringify(previous.aircraft) === JSON.stringify(feed.aircraft)) {
    return { latest, archive: null, feed: previous, changed: false };
  }
  await atomicJsonWrite(latest, feed);
  await mkdir(dirname(archive), { recursive: true });
  await appendFile(archive, JSON.stringify(feed) + "\n", "utf8");
  return { latest, archive, feed, changed: true };
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
