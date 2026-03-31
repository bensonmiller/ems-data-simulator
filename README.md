# CCE Thermal Simulator

A physics-based synthetic data generator for cold chain equipment (CCE) monitoring systems. Produces realistic time-series data conforming to the [CCDX schema](https://wiki.digitalsquare.io/index.php/Cold_Chain_Data_Exchange) for both EMS (Equipment Monitoring System) and RTMD (Remote Temperature Monitoring Device) formats.

Built as a drop-in replacement for a previous database-dependent approach, this simulator generates data entirely from first principles — no external data sources required.

## Architecture

```
SimulationConfig
    ├── ThermalConfig      R, C, Q_compressor, setpoints
    ├── AmbientConfig      T_mean, T_amplitude, daily cycle
    ├── PowerConfig        mains outages / solar bell curve
    ├── EventConfig        door opening rates
    └── FaultConfig        fault injection parameters

SimulatedRecordSet.generate(config, batch_size, start_time)
    ├── AmbientModel       → TAMB (sinusoidal + noise)
    ├── ThermalModel       → TVC, CMPR, DORV (RC circuit + thermostat)
    ├── PowerModel         → SVA/ACCD/ACSV or DCSV/DCCD/BLOG
    ├── DoorEventGenerator → door openings (Poisson process)
    ├── FaultInjector      → fault effects on thermal/power
    └── AlarmGenerator     → ALRM, HOLD, EERR
```

### Thermal model

The vaccine chamber temperature (TVC) is governed by an RC-circuit ODE:

```
dTVC/dt = (TAMB - TVC) / (R * C)
        - (Q_compressor * compressor_on) / C
        + (TAMB - TVC) / (R_door * C) * door_open
```

The thermostat uses hysteresis control: the compressor turns ON when TVC reaches `T_setpoint_high` and turns OFF when TVC drops to `T_setpoint_low`. This produces the characteristic sawtooth pattern seen in real fridge data.

Integration uses the Euler method with configurable sub-steps (default 10s) within each sample interval (typically 600s or 900s).

### Power models

**Mains-powered** fridges have continuous power with stochastic outages modeled as a Poisson process. During an outage, the compressor cannot run and TVC drifts toward ambient.

**Solar direct drive (SDD)** fridges run the compressor directly from solar panels — there is no electrical battery for the compressor. Solar voltage follows a bell curve from sunrise to sunset. Energy is stored thermally in ice lining, not electrically. The BLOG field reflects a small backup battery that keeps the data *logger* running overnight; it cannot power the compressor.

### Calibration

Solar defaults are calibrated against real telemetry from an Aucma MetaFridge CFD-50 deployed in Abia State, Nigeria (see `data/fridge_data.json`). Key characteristics of the reference data:

- TVC remarkably stable at 3.6-4.2 C (ice-lined thermal mass)
- Compressor runs only during solar hours (~22% of intervals)
- DCSV follows a clean bell curve peaking at ~20V
- BLOG (logger battery) charges during the day, drains slowly overnight

## Quick start

### Low-level: SimulatedRecordSet

Generate records directly from the simulation engine:

```python
import datetime as dt
from utils.simulator import SimulatedRecordSet, default_config

config = default_config(power_type="mains", latitude=12.0)
start = dt.datetime(2024, 6, 15, 0, 0, 0)

rs = SimulatedRecordSet.generate(config, batch_size=96, start_time=start, interval=900)

# Raw dicts
for r in rs.records[:3]:
    print(r['ABST'], r['TVC'], r['TAMB'], r['CMPR'])

# Convert to Pydantic models
ems_records = rs.to_ems()       # List[EmsRecordMains]
rtmd_records = rs.to_rtmd()     # List[RtmdRecord]
```

### High-level: BaseRtmDevice

The device layer adds facility metadata, serial numbers, and schema-validated reports:

```python
from utils.device import MonitoringDeviceConfig, BaseRtmDevice

config = MonitoringDeviceConfig(
    type='ems',                # 'ems' or 'rtmd'
    upload_interval=3600,      # seconds between uploads
    sample_interval=900,       # seconds between samples
)
device = BaseRtmDevice(config)

# Generate sequential reports (state carries over between calls)
report = device.create_report(report_time=dt.datetime(2024, 6, 15, 12, 0))
print(type(report))  # EmsReport or RtmdReport
print(len(report.records))  # 3600/900 = 4
```

### Locust load testing

The `locustfile.py` integrates the simulator with [Locust](https://locust.io/) for load testing OpenFn endpoints. Each Locust user represents a single CCE device with its own identity (serial numbers, facility, power type) sending a pre-generated series of CCDX-formatted reports.

#### How it works

During startup (`on_start`), each virtual user:

1. Creates a `BaseRtmDevice` with randomized device metadata
2. Pre-generates a queue of sequential reports by calling `create_report()` in a loop with advancing timestamps
3. Simulator state (TVC, compressor, battery SOC) carries over between reports, so the full series is physically continuous

During the test, `post_packet()` pops the next report from the queue and POSTs it. When a user's queue is exhausted, the test stops. This decouples simulated time from wall-clock time — Locust controls how fast reports are sent, while the data itself represents coherent multi-day device telemetry.

Load volume comes from spawning many Locust users (each a distinct device), not from time compression.

#### Configuration

| Environment variable | Default | Description |
|---|---|---|
| `TARGET_HOST` | `http://localhost:8001` | Base URL for the OpenFn endpoint |
| `OPENFN_WORKFLOW_ID` | _(required)_ | Workflow ID appended to the POST path |
| `NUM_REPORTS` | `168` | Number of sequential reports to pre-generate per device. At a 1-hour upload interval, 168 = one week of data |
| `SIM_START` | `2024-06-15T00:00:00` | Simulated start date (ISO 8601). Each user adds random jitter to avoid identical timestamps |
| `START_JITTER_S` | `3600` | Maximum random offset (seconds) added to each user's start time |

The device mix is controlled by the `weight` attribute on `RtmdDevice` and `EmsDevice` in `locustfile.py` (both default to 1, producing a 50/50 split).

Each device's `upload_interval` and `sample_interval` are randomized by `MonitoringDeviceConfig` — typical values are 1–8 hour upload intervals with 10–15 minute sample intervals.

#### Examples

Run 100 virtual devices against a local endpoint, ramping up 5 users/second:

```bash
export OPENFN_WORKFLOW_ID="your-workflow-id"
locust -f locustfile.py --headless -u 100 -r 5
```

Generate 30 days of data per device instead of the default 7:

```bash
NUM_REPORTS=720 locust -f locustfile.py --headless -u 50 -r 10
```

Target a remote endpoint with a custom start date:

```bash
TARGET_HOST=https://app.openfn.org SIM_START=2025-01-01T00:00:00 \
  locust -f locustfile.py --headless -u 500 -r 20
```

## Injecting anomalies

The simulator supports four fault types that produce the kinds of anomalies seen in real CCE deployments. Configure them through `FaultConfig`:

### Compressor failure

The compressor stops running. TVC drifts toward ambient temperature — a classic heat excursion.

```python
from utils.simulator.config import FaultType, default_config

config = default_config("mains", latitude=12.0)
config.fault.fault_type = FaultType.COMPRESSOR_FAILURE
config.fault.fault_start_offset_s = 8 * 3600    # fail at hour 8
config.fault.fault_duration_s = 6 * 3600         # lasts 6 hours (0 = permanent)
```

### Power outage

Forces power unavailable, disabling the compressor. For mains fridges this overrides the stochastic outage model; for solar fridges it overrides DCSV availability.

```python
config.fault.fault_type = FaultType.POWER_OUTAGE
config.fault.fault_start_offset_s = 4 * 3600
config.fault.fault_duration_s = 12 * 3600
```

### Stuck door

Forces the door open continuously during the fault window. The open door creates a low-resistance path to ambient (`R_door`), causing TVC to rise toward ambient temperature even with the compressor running.

```python
config.fault.fault_type = FaultType.STUCK_DOOR
config.fault.fault_start_offset_s = 10 * 3600
config.fault.fault_duration_s = 2 * 3600
```

### Refrigerant leak

Gradually reduces compressor cooling capacity over time. The multiplier on `Q_compressor` decays linearly from 1.0 at the fault start, controlled by `refrigerant_leak_rate` (fraction lost per hour).

```python
config.fault.fault_type = FaultType.REFRIGERANT_LEAK
config.fault.fault_start_offset_s = 0           # starts immediately
config.fault.fault_duration_s = 0                # permanent
config.fault.refrigerant_leak_rate = 0.02        # 2% capacity loss per hour
```

### Inattentive door use

Models operational door abuse by health facility staff — not a hardware fault, but a behavioral pattern that causes temperature excursions. Three presets are available via `EventConfig` factory methods, calibrated from fleet-wide analysis of 1,225 fridges (Jan 2021 – Dec 2022):

**Few but long** — staff leave the door open for extended periods (2–5+ minutes). Produces ~3 opens/day with large TVC spikes up to 13°C, triggering HEAT alarms even with a working compressor:

```python
from utils.simulator.config import EventConfig, default_config

config = default_config("mains", latitude=12.0)
config.events = EventConfig.few_but_long()
```

**Frequent short** — staff open the door frequently but briefly (~25s each). Produces ~10 opens/day with many small TVC perturbations that prevent the chamber from settling:

```python
config.events = EventConfig.frequent_short()
```

**Busy facility** — high-traffic facility with extended operating hours (06:00–20:00). Produces ~16+ opens/day, modeling immunization campaign days or busy urban clinics:

```python
config.events = EventConfig.busy_facility()
```

Because door behavior is configured through `EventConfig` (not `FaultConfig`), it composes freely with any fault type. For example, inattentive door use during an extended power outage:

```python
from utils.simulator.config import EventConfig, FaultConfig, FaultType, default_config

config = default_config("mains", latitude=12.0)
config.events = EventConfig.few_but_long()
config.fault = FaultConfig(
    fault_type=FaultType.POWER_OUTAGE,
    fault_start_offset_s=3 * 86400,   # power fails on day 3
    fault_duration_s=24 * 3600,        # lasts 24 hours
)
```

### Combining faults with normal variation

The stochastic elements (door openings, ambient noise, mains outages) run independently of fault injection. A compressor failure during a hot afternoon with a door opening produces a compound event that looks realistic.

## Generating multi-day datasets

Use explicit `report_time` values to generate historical data:

```python
config = MonitoringDeviceConfig(type='ems', upload_interval=3600, sample_interval=900)
device = BaseRtmDevice(config)

t = dt.datetime(2024, 1, 1, 0, 0, 0)
all_reports = []
for _ in range(24 * 30):  # 30 days of hourly reports
    report = device.create_report(report_time=t)
    all_reports.append(report)
    t += dt.timedelta(hours=1)
```

State (TVC, compressor status, logger battery SOC, RNG) carries over between calls automatically via `SimulatorState`.

## Extending for different refrigerator types

The simulator is parameterized to support a range of thermal characteristics. To model a different refrigerator, override the relevant config values.

### Parameter guide

| Parameter | Effect | Typical range |
|-----------|--------|---------------|
| `R` | Thermal resistance (insulation quality) | 0.08 (poor) - 0.35 (ice-lined) |
| `C` | Thermal capacitance (thermal mass) | 10,000 (small chest) - 2,000,000 (ice-lined SDD) |
| `Q_compressor` | Cooling power | 150 - 400 W |
| `R_door` | Thermal resistance of open doorway | 0.10 (large door) - 0.30 (chest lid) K/W |
| `T_setpoint_low` | Compressor OFF threshold | 2 - 4 C |
| `T_setpoint_high` | Compressor ON threshold | 5 - 8 C |

The **equilibrium temperature** when the compressor is running continuously is:

```
TVC_eq = TAMB - Q_compressor * R
```

This must be well below `T_setpoint_low` for the thermostat cycle to work. For example, with `TAMB=28`, `Q=300`, `R=0.12`: `TVC_eq = 28 - 36 = -8 C`.

The **time constant** `tau = R * C` controls how quickly TVC responds to changes. Larger tau means slower, more stable temperature swings.

### Example: small mains-powered chest fridge

A small chest fridge in a busy clinic with frequent door openings and less insulation:

```python
from utils.simulator.config import SimulationConfig, ThermalConfig, AmbientConfig, PowerConfig, EventConfig

config = SimulationConfig(
    thermal=ThermalConfig(
        R=0.08,              # Poor insulation
        C=10000.0,           # Small thermal mass
        Q_compressor=200.0,
        R_door=0.12,         # Large door = lower resistance
        T_setpoint_low=2.0,
        T_setpoint_high=8.0,
    ),
    ambient=AmbientConfig(T_mean=32.0, T_amplitude=4.0),
    power=PowerConfig(power_type="mains"),
    events=EventConfig(
        door_rate_per_hour=5.0,        # Busy clinic
        door_mean_duration_s=45.0,     # Long openings
    ),
)
```

### Example: well-insulated walk-in cold room

A large walk-in cold room with stable temperatures:

```python
config = SimulationConfig(
    thermal=ThermalConfig(
        R=0.20,
        C=500000.0,          # Large thermal mass (thick walls, contents)
        Q_compressor=500.0,  # Industrial compressor
        R_door=0.10,         # Large walk-in door = low resistance
        T_setpoint_low=2.0,
        T_setpoint_high=6.0,
    ),
    ambient=AmbientConfig(T_mean=25.0, T_amplitude=3.0),
    power=PowerConfig(power_type="mains"),
    events=EventConfig(
        door_rate_per_hour=8.0,
        door_mean_duration_s=60.0,
        working_hours=(6, 22),
    ),
)
```

### Adding a new power type

To support a new power source (e.g., generator-backed, hybrid solar-mains):

1. Create a new model class in `utils/simulator/power.py` implementing `simulate_interval()` and `is_power_available()`
2. Add a branch in `SimulatedRecordSet.generate()` to instantiate it
3. Add any new output fields to the `to_ems()` / `to_rtmd()` conversion methods

## Project structure

```
utils/
├── simulator/
│   ├── __init__.py          Public API exports
│   ├── config.py            All configuration dataclasses
│   ├── thermal.py           RC thermal model, ambient model, door events
│   ├── power.py             Mains and solar power models
│   ├── events.py            Door generation, fault injection, alarms
│   └── recordset.py         Orchestration and schema conversion
├── device.py                High-level device + report generation
├── devicegroups.py          PQS equipment catalog
├── facilities.py            Facility data (Sokoto State, Nigeria)
├── generator.py             Serial numbers, transfer metadata
└── schemas.py               Pydantic models (CCDX schema)

tests/
├── test_thermal.py          Thermal model unit tests
├── test_power.py            Power model unit tests
├── test_events.py           Events, faults, alarms unit tests
├── test_recordset.py        Integration tests
├── test_generation.py       Device + report end-to-end tests
├── test_facilities.py       Facility data tests
└── test_rtmd.py             Schema validation tests

locustfile.py                Locust load test configuration
simulator_examples.ipynb     Interactive examples with plots
data/fridge_data.json        MetaFridge reference data (calibration)
```

## Running tests

```bash
python3 -m pytest tests/ -v
```
