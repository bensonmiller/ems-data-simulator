# JavaScript Implementation

A JavaScript port of the CCE thermal simulator for use in JS applications. See [README.md](README.md) for architecture and physics documentation.

## Dependencies

**Production:** [`seedrandom`](https://www.npmjs.com/package/seedrandom) for deterministic PRNG. No other runtime dependencies.

**Development:** [vitest](https://vitest.dev/) for testing.

## Install

```bash
cd js
npm install
```

## Quick start

### Low-level: SimulatedRecordSet

```javascript
import { SimulatedRecordSet, defaultConfig } from './src/index.js';

const config = defaultConfig('mains', 12.0);
config.random_seed = 42;
const start = new Date(Date.UTC(2024, 5, 15, 0, 0, 0));

const rs = SimulatedRecordSet.generate(config, 96, start, 900);

// Raw records
for (const r of rs.records.slice(0, 3)) {
  console.log(r.ABST, r.TVC, r.TAMB, r.CMPR);
}

// Convert to schema objects
const emsRecords = rs.toEms();    // EmsRecordMains[]
const rtmdRecords = rs.toRtmd();  // RtmdRecord[]

// Serialize to JSON
const json = JSON.stringify(rtmdRecords.map(r => r.toJSON()));
```

### High-level: BaseRtmDevice

The device layer adds metadata and sequential report generation:

```javascript
import { MonitoringDeviceConfig, BaseRtmDevice } from './src/index.js';

const config = new MonitoringDeviceConfig({
  type: 'rtmd',
  uploadInterval: 3600,
  sampleInterval: 900,
  powerType: 'mains',
  // Appliance identity
  amfr: 'Aucma',
  amod: 'CFD-50',
  apqs: 'E003/040',
  // Facility
  cid: 'facility-001',
  lat: 12.0,
  lng: 8.5,
});

const device = new BaseRtmDevice(config);

// Generate sequential reports (state carries over)
const report = device.createReport(new Date(Date.UTC(2024, 5, 15, 12, 0, 0)));
console.log(report.toJSON());
```

### Stateful continuity

State persists between `generate()` calls via `SimulatorState`:

```javascript
const config = defaultConfig('mains', 12.0);
config.random_seed = 42;
const start = new Date(Date.UTC(2024, 0, 1));

// First batch
const rs1 = SimulatedRecordSet.generate(config, 96, start, 900);

// Continue from where we left off
const nextStart = new Date(start.getTime() + 96 * 900 * 1000);
const rs2 = SimulatedRecordSet.generate(config, 96, nextStart, 900, rs1.state);

// TVC is continuous across batches — no discontinuity
```

## Injecting anomalies

```javascript
import { defaultConfig, FaultType } from './src/index.js';

const config = defaultConfig('mains', 12.0);

// Compressor failure at hour 8, lasting 6 hours
config.fault.fault_type = FaultType.COMPRESSOR_FAILURE;
config.fault.fault_start_offset_s = 8 * 3600;
config.fault.fault_duration_s = 6 * 3600;
```

```javascript
// Refrigerant leak (permanent, gradual)
config.fault.fault_type = FaultType.REFRIGERANT_LEAK;
config.fault.fault_start_offset_s = 0;
config.fault.fault_duration_s = 0;
config.fault.refrigerant_leak_rate = 0.02;
```

### Door behavior presets

```javascript
import { EventConfig } from './src/index.js';

config.events = EventConfig.bestpractice();
config.events = EventConfig.normal();
config.events = EventConfig.few_but_long();     // causes HEAT alarms
config.events = EventConfig.frequent_short();
config.events = EventConfig.busy_facility();
```

Presets compose with faults:

```javascript
import { FaultConfig, FaultType, EventConfig } from './src/index.js';

config.events = EventConfig.few_but_long();
config.fault = new FaultConfig({
  fault_type: FaultType.POWER_OUTAGE,
  fault_start_offset_s: 3 * 86400,
  fault_duration_s: 24 * 3600,
});
```

## Differences from the Python implementation

| Aspect | Python | JavaScript |
|--------|--------|------------|
| Schema validation | Pydantic 2.x | None (plain classes with `toJSON()`) |
| PRNG | Mersenne Twister (`random.Random`) | ARC4 (`seedrandom`) |
| Facility catalog | 150+ Nigerian facilities | Not included — pass metadata via config |
| Device catalog | 120+ fridge models, 40+ RTMDs | Not included — pass metadata via config |
| Load testing | Locust integration | Not included |
| Notebooks | Jupyter examples with plots | Not included |

The physics engine, fault injection, alarm state machine, and CCDX output formats are identical. Numerical outputs differ slightly due to the different PRNG algorithms, but behavioral characteristics match (verified by cross-validation tests).

## API reference

### Config classes

All config classes accept an options object in the constructor. Unspecified fields use defaults matching the Python implementation.

```javascript
new ThermalConfig({ R: 0.12, C: 48000, Q_compressor: 300 })
new AmbientConfig({ T_mean: 28, T_amplitude: 5 })
new PowerConfig({ power_type: 'solar', peak_dcsv: 48 })
new EventConfig({ door_rate_per_hour: 3.0 })
new FaultConfig({ fault_type: FaultType.STUCK_DOOR })
new SimulationConfig({ thermal, ambient, power, events, fault })
```

### `defaultConfig(powerType, latitude)`

Creates a complete `SimulationConfig` with sensible defaults. Ambient temperature is estimated from latitude.

### `SimulatedRecordSet.generate(config, batchSize, startTime, interval, state)`

- `config` — `SimulationConfig`
- `batchSize` — number of records to generate
- `startTime` — `Date` object (UTC)
- `interval` — seconds between samples (default 900)
- `state` — `SimulatorState` from a previous call (optional)

Returns a `SimulatedRecordSet` with `.records`, `.state`, `.toRtmd()`, `.toEms()`.

### `BaseRtmDevice`

```javascript
const device = new BaseRtmDevice(monitoringDeviceConfig);
const report = device.createReport(reportTime);  // RtmdReport or EmsReport
const json = report.toJSON();
```

### Schema classes

All schema classes have a `toJSON()` method that excludes undefined fields:

- `RtmdRecord` — ABST, BEMD, TVC, TAMB, ALRM, EERR
- `EmsRecordMains` — all EMS fields + SVA, ACCD, ACSV
- `EmsRecordSolar` — all EMS fields + DCSV, DCCD
- `RtmdReport` / `EmsReport` — metadata + records array
- `RtmdTransfer` / `EmsTransfer` — transfer envelope

### `SeededRandom`

Deterministic PRNG wrapper:

```javascript
import { SeededRandom } from './src/index.js';

const rng = new SeededRandom(42);
rng.random();           // uniform [0, 1)
rng.gauss(0, 1);        // Gaussian
rng.randint(1, 6);      // integer [1, 6]
rng.uniform(0, 10);     // float [0, 10]
rng.poisson(3.5);       // Poisson-distributed integer
rng.choice([1, 2, 3]);  // random element

// Save/restore state for simulation continuity
const state = rng.getState();
rng.setState(state);
```

## Project structure

```
js/
├── package.json
├── fixtures/
│   ├── generate_fixtures.py     Python script to regenerate reference data
│   ├── mains_normal.json        Reference fixture (24 records)
│   ├── solar_normal.json        Reference fixture (24 records)
│   ├── refrigerant_leak.json    Reference fixture (96 records)
│   ├── stuck_door.json          Reference fixture (24 records)
│   ├── power_outage.json        Reference fixture (24 records)
│   ├── compressor_failure.json  Reference fixture (24 records)
│   ├── icebank_unit.json        Reference fixture (96 records)
│   └── busy_facility.json       Reference fixture (24 records)
└── src/
    ├── index.js                 Public API exports
    ├── config.js                Configuration classes + presets
    ├── thermal.js               RC thermal model, ambient model
    ├── power.js                 Mains and solar power models
    ├── events.js                Door generation, fault injection, alarms
    ├── recordset.js             Orchestration and schema conversion
    ├── schemas.js               CCDX output format classes
    ├── device.js                Device wrapper + report generation
    ├── random.js                Seedable PRNG wrapper
    ├── *.test.js                Unit tests (co-located)
    └── cross-validation.test.js Behavioral validation vs Python fixtures
```

## Running tests

```bash
cd js
npx vitest run        # all tests
npx vitest run src/thermal.test.js   # single module
npx vitest            # watch mode
```

### Regenerating cross-validation fixtures

If the Python implementation changes, regenerate the reference fixtures:

```bash
cd /path/to/ems-data-simulator
python3 js/fixtures/generate_fixtures.py
```

Then re-run the JS tests to verify behavioral equivalence.
