import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMilitaryFeed, normalizeAircraft } from "../scripts/lib/militaryFlightNormalizer.mjs";

const collectedAt = "2026-08-30T04:30:00.000Z";
const feed = normalizeMilitaryFeed({ aircraft: [
  { hex: "DEF456", lat: 1.234567, lon: 2.345678, t: "mystery" },
  { hex: "ABC123", lat: "40.123456", lon: "-73.987654", t: "F-16C", seen_pos: 12.34 },
  { hex: "BAD", lat: 91, lon: 0 },
] }, { collectedAt });
assert.equal(feed.count, 2);
assert.deepEqual(feed.aircraft.map((item) => item.id), ["abc123", "def456"]);
assert.equal(feed.aircraft[0].lat, 40.12346);
assert.equal(feed.aircraft[0].classification, "fighter");
assert.equal(feed.aircraft[0].classificationConfidence, "medium");
assert.equal(feed.aircraft[1].classification, "unknown");
assert.equal(feed.aircraft[1].classificationMethod, "insufficient-evidence");
assert.equal(feed.aircraft[1].countryConfidence, "unknown");
assert.equal(normalizeAircraft({ hex: "x", lat: NaN, lon: 0 }, { collectedAt }), null);

// adsb.lol's live endpoint uses the documented `ac` envelope key.
const liveEnvelope = normalizeMilitaryFeed({ ac: [
  { hex: "LIVE01", lat: 51.5, lon: -0.1, t: "C-17" },
] }, { collectedAt });
assert.equal(liveEnvelope.count, 1);
assert.equal(liveEnvelope.aircraft[0].id, "live01");

const root = await mkdtemp(join(tmpdir(), "military-flight-test-"));
const fixture = fileURLToPath(new URL("./fixtures/adsb-mil.fixture.json", import.meta.url));
const output = join(root, "output");
const { spawn } = await import("node:child_process");
const result = await new Promise((resolve) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/collect-military-flights.mjs", import.meta.url)), "--input=" + fixture, "--output=" + output, "--collected-at=" + collectedAt], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("close", (code) => resolve({ code, stdout, stderr }));
});
assert.equal(result.code, 0, result.stderr);
const latest = JSON.parse(await readFile(join(output, "latest.json"), "utf8"));
assert.equal(latest.count, 2);
const archive = join(output, "archive", "2026", "08", "30.jsonl");
assert.equal((await readFile(archive, "utf8")).trim().split("\n").length, 1);
await rm(root, { recursive: true, force: true });
console.log("military flight normalizer and collector tests passed");
