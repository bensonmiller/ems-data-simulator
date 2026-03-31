# Python Implementation

The original Python implementation of the CCE thermal simulator. See [README.md](README.md) for architecture and physics documentation.

## Dependencies

Production: **Pydantic 2.x** (schema validation). The simulation engine itself is pure Python standard library.

Development: pytest, numpy, pandas, matplotlib, locust (see `Pipfile`).

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

## Injecting anomalies

```python
from utils.simulator.config import FaultType, default_config

config = default_config("mains", latitude=12.0)

# Compressor failure
config.fault.fault_type = FaultType.COMPRESSOR_FAILURE
config.fault.fault_start_offset_s = 8 * 3600    # fail at hour 8
config.fault.fault_duration_s = 6 * 3600         # lasts 6 hours (0 = permanent)

# Refrigerant leak
config.fault.fault_type = FaultType.REFRIGERANT_LEAK
config.fault.fault_start_offset_s = 0
config.fault.fault_duration_s = 0                # permanent
config.fault.refrigerant_leak_rate = 0.02        # 2% capacity loss per hour

# Combining door presets with faults
from utils.simulator.config import EventConfig, FaultConfig

config.events = EventConfig.few_but_long()
config.fault = FaultConfig(
    fault_type=FaultType.POWER_OUTAGE,
    fault_start_offset_s=3 * 86400,   # power fails on day 3
    fault_duration_s=24 * 3600,
)
```

## Generating multi-day datasets

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

## Example configurations

### Small mains-powered chest fridge

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
        door_rate_per_hour=5.0,
        door_mean_duration_s=45.0,
    ),
)
```

### Well-insulated walk-in cold room

```python
config = SimulationConfig(
    thermal=ThermalConfig(
        R=0.20,
        C=500000.0,
        Q_compressor=500.0,
        R_door=0.10,
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

## Locust load testing

The `locustfile.py` integrates the simulator with [Locust](https://locust.io/) for load testing OpenFn endpoints. Each Locust user represents a single CCE device sending a pre-generated series of CCDX-formatted reports.

During startup, each virtual user creates a `BaseRtmDevice`, pre-generates a queue of sequential reports, then POSTs them one at a time. State carries over between reports for physical continuity. Load volume comes from spawning many users (each a distinct device), not from time compression.

### Configuration

| Environment variable | Default | Description |
|---|---|---|
| `TARGET_HOST` | `http://localhost:8001` | Base URL for the OpenFn endpoint |
| `OPENFN_WORKFLOW_ID` | _(required)_ | Workflow ID appended to the POST path |
| `NUM_REPORTS` | `168` | Reports per device (168 = one week at 1h intervals) |
| `SIM_START` | `2024-06-15T00:00:00` | Simulated start date (ISO 8601) |
| `START_JITTER_S` | `3600` | Max random offset per user's start time |

### Examples

```bash
# 100 virtual devices, ramping 5 users/second
export OPENFN_WORKFLOW_ID="your-workflow-id"
locust -f locustfile.py --headless -u 100 -r 5

# 30 days of data per device
NUM_REPORTS=720 locust -f locustfile.py --headless -u 50 -r 10

# Remote endpoint with custom start date
TARGET_HOST=https://app.openfn.org SIM_START=2025-01-01T00:00:00 \
  locust -f locustfile.py --headless -u 500 -r 20
```

## Adding a new power type

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
