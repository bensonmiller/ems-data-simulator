# CCE Thermal Simulator

A physics-based synthetic data generator for cold chain equipment (CCE) monitoring systems. Produces realistic time-series data conforming to the [CCDX schema](https://wiki.digitalsquare.io/index.php/Cold_Chain_Data_Exchange) for both EMS (Equipment Monitoring System) and RTMD (Remote Temperature Monitoring Device) formats.

Built as a drop-in replacement for a previous database-dependent approach, this simulator generates data entirely from first principles — no external data sources required.

Available in two implementations:

- **[Python](README_PYTHON.md)** — the original implementation, with Pydantic schemas, Locust load testing, and Jupyter notebook examples
- **[JavaScript](README_JAVASCRIPT.md)** — a port for use in JS applications, with a seedable PRNG and no external dependencies beyond that

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

## Thermal model

The vaccine chamber temperature (TVC) is governed by an RC-circuit ODE:

```
dTVC/dt = (TAMB - TVC) / (R * C)
        - (Q_compressor * compressor_on) / C
        + (TAMB - TVC) / (R_door * C) * door_open
```

The thermostat uses hysteresis control: the compressor turns ON when TVC reaches `T_setpoint_high` and turns OFF when TVC drops to `T_setpoint_low`. This produces the characteristic sawtooth pattern seen in real fridge data.

Integration uses the Euler method with configurable sub-steps (default 10s) within each sample interval (typically 600s or 900s).

### Two-node model

When `C_air > 0`, the model splits the chamber into a fast "air" node (what the TVC probe reads) and a slow "contents" node (bulk thermal mass). Heat flows between the two via `R_air_contents`. This captures the real-world behavior where air temperature spikes during door openings but contents remain stable.

### Icebank

Solar direct drive fridges store energy as ice rather than in batteries. When `icebank_capacity_j > 0`, the model includes a phase-change thermal reservoir at 0 C. While charged, it absorbs heat and holds TVC near freezing. When depleted, TVC rises toward ambient.

## Power models

**Mains-powered** fridges have continuous power with stochastic outages modeled as a Poisson process. During an outage, the compressor cannot run and TVC drifts toward ambient.

**Solar direct drive (SDD)** fridges run the compressor directly from solar panels — there is no electrical battery for the compressor. Solar voltage follows a bell curve from sunrise to sunset. Energy is stored thermally in ice lining, not electrically. The BLOG field reflects a small backup battery that keeps the data *logger* running overnight; it cannot power the compressor.

## Fault injection

Four fault types produce the kinds of anomalies seen in real CCE deployments:

| Fault | Effect | Typical signature |
|-------|--------|-------------------|
| **Compressor failure** | Compressor stops | TVC drifts to ambient |
| **Power outage** | Power forced off | CMPR=0, TVC rises |
| **Stuck door** | Door forced open | High DORV, TVC rises even with compressor |
| **Refrigerant leak** | Cooling capacity decays exponentially | Gradual TVC rise over days/weeks |

Faults compose with stochastic elements (door openings, ambient noise, mains outages) to produce realistic compound events.

## Door behavior presets

`EventConfig` provides five named presets calibrated from fleet-wide analysis of 1,225 fridges (Jan 2021 - Dec 2022):

| Preset | opens/day | secs/day | TVC max | HEAT alarms | Pattern |
|---|---|---|---|---|---|
| `bestpractice()` | ~2 | ~60 | 7.1 C | 0 | Fleet median — trained staff |
| `normal()` | ~6 | ~160 | 7.3 C | 0 | Typical facility, adequate practices |
| `frequent_short()` | ~10 | ~290 | 7.3 C | 0 | Many brief opens, marginal |
| `busy_facility()` | ~16 | ~440 | 8.0 C | 0 | High-traffic / campaign days |
| `few_but_long()` | ~3 | ~530 | 13.1 C | 12 | Extended opens, causes excursions |

## WHO alarm codes

The alarm generator derives WHO PQS E003 alarm codes from simulation state:

| Code | Condition | Threshold |
|------|-----------|-----------|
| HEAT | TVC > 8 C continuously | 10 hours |
| FRZE | TVC <= -0.5 C continuously | 60 minutes |
| DOOR | Door open continuously | 5 minutes |
| POWR | No power continuously | 24 hours |

Alarm excursion timers persist across sample intervals, so a HEAT alarm can accumulate over multiple 15-minute records.

## Calibration

Solar defaults are calibrated against real telemetry from an Aucma MetaFridge CFD-50 deployed in Abia State, Nigeria (see `data/fridge_data.json`). Key characteristics:

- TVC remarkably stable at 3.6-4.2 C (ice-lined thermal mass)
- Compressor runs only during solar hours (~22% of intervals)
- DCSV follows a clean bell curve peaking at ~20V
- BLOG (logger battery) charges during the day, drains slowly overnight

Refrigerant leak decay rate (default 0.002/hour) is calibrated from a 62-day degradation timeline observed in reference unit `2807-CB2A-0A00-00C8`.

## Extending for different refrigerator types

The simulator is parameterized to support a range of thermal characteristics.

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

## License

See [LICENSE](LICENSE).
