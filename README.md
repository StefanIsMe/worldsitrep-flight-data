# World SITREP public flight data

This repository publishes normalized military-associated ADS-B/MLAT snapshots consumed by World SITREP. It contains no website source code.

The scheduled workflow fetches the public adsb.lol military endpoint, validates and normalizes the response, writes flight-data/latest.json, and retains daily JSONL snapshots under flight-data/archive/. Observations are delayed/limited by ADS-B/MLAT coverage and do not establish intent, mission, affiliation, or legal status. Country/operator/classification labels are inferred only when evidence supports them and include confidence metadata.

Raw feed URL: https://raw.githubusercontent.com/StefanIsMe/worldsitrep-flight-data/main/flight-data/latest.json

## Local verification

node tests/military-flight-normalizer.test.mjs
node scripts/collect-military-flights.mjs
