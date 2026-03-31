#!/usr/bin/env python3
"""
Generate reference fixture data from the Python simulator for
cross-validation against the JavaScript port.

Each fixture captures a complete scenario run with a fixed seed,
producing JSON files that the JS test suite can load and compare.
"""

import json
import sys
import os
import datetime as dt
from pathlib import Path

# Add project root to path so we can import utils
project_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(project_root))

from utils.simulator.config import (
    SimulationConfig, ThermalConfig, AmbientConfig, PowerConfig,
    EventConfig, FaultConfig, FaultType, default_config,
)
from utils.simulator.recordset import SimulatedRecordSet

FIXTURES_DIR = Path(__file__).resolve().parent
SEED = 42
START_TIME = dt.datetime(2024, 6, 15, 0, 0, 0)  # Fixed start for reproducibility
INTERVAL = 900
LATITUDE = 12.0


def format_ems_datetime(timestamp: dt.datetime) -> str:
    """Match the JS formatEmsDateTime: YYYYMMDDTHHMMSSz (lowercase z)."""
    return timestamp.strftime("%Y%m%dT%H%M%S") + "z"


def record_to_dict(record: dict) -> dict:
    """Convert a raw record dict to a JSON-serializable dict."""
    out = {}
    for k, v in record.items():
        if isinstance(v, dt.datetime):
            out[k] = format_ems_datetime(v)
        elif v is None:
            out[k] = None
        else:
            out[k] = v
    return out


def generate_scenario(name, config, batch_size, description=""):
    """Run a scenario and return a fixture dict."""
    rs = SimulatedRecordSet.generate(
        config=config,
        batch_size=batch_size,
        start_time=START_TIME,
        interval=INTERVAL,
    )
    records = [record_to_dict(r) for r in rs.records]

    config_summary = {
        "power_type": config.power.power_type,
        "seed": config.random_seed,
        "latitude": LATITUDE,
        "interval": INTERVAL,
        "batch_size": batch_size,
        "fault_type": config.fault.fault_type.value,
        "fault_start_offset_s": config.fault.fault_start_offset_s,
        "fault_duration_s": config.fault.fault_duration_s,
        "start_time": START_TIME.isoformat() + "Z",
    }

    # Include key thermal params for reference
    config_summary["icebank_capacity_j"] = config.thermal.icebank_capacity_j
    config_summary["compressor_targets_icebank"] = config.thermal.compressor_targets_icebank
    config_summary["R_icebank"] = config.thermal.R_icebank

    return {
        "scenario": name,
        "description": description,
        "config_summary": config_summary,
        "records": records,
    }


def main():
    scenarios = []

    # 1. mains_normal — 24 records (6h), default mains config
    cfg = default_config("mains", latitude=LATITUDE)
    cfg.random_seed = SEED
    cfg.sample_interval = INTERVAL
    scenarios.append(generate_scenario(
        "mains_normal", cfg, 24,
        "Default mains config, 6h, latitude 12.0"
    ))

    # 2. solar_normal — 24 records (6h), default solar config
    cfg = default_config("solar", latitude=LATITUDE)
    cfg.random_seed = SEED
    cfg.sample_interval = INTERVAL
    scenarios.append(generate_scenario(
        "solar_normal", cfg, 24,
        "Default solar config, 6h, latitude 12.0"
    ))

    # 3. refrigerant_leak — 96 records (24h), mains with REFRIGERANT_LEAK
    cfg = default_config("mains", latitude=LATITUDE)
    cfg.random_seed = SEED
    cfg.sample_interval = INTERVAL
    cfg.fault = FaultConfig(
        fault_type=FaultType.REFRIGERANT_LEAK,
        fault_start_offset_s=0.0,
    )
    scenarios.append(generate_scenario(
        "refrigerant_leak", cfg, 96,
        "Mains with refrigerant leak fault from offset 0, 24h"
    ))

    # 4. stuck_door — 24 records (6h), mains with STUCK_DOOR
    cfg = default_config("mains", latitude=LATITUDE)
    cfg.random_seed = SEED
    cfg.sample_interval = INTERVAL
    cfg.fault = FaultConfig(
        fault_type=FaultType.STUCK_DOOR,
        fault_start_offset_s=0.0,
        fault_duration_s=21600.0,
    )
    scenarios.append(generate_scenario(
        "stuck_door", cfg, 24,
        "Mains with stuck door fault for 6h"
    ))

    # 5. power_outage — 24 records (6h), mains with POWER_OUTAGE
    cfg = default_config("mains", latitude=LATITUDE)
    cfg.random_seed = SEED
    cfg.sample_interval = INTERVAL
    cfg.fault = FaultConfig(
        fault_type=FaultType.POWER_OUTAGE,
        fault_start_offset_s=0.0,
        fault_duration_s=21600.0,
    )
    scenarios.append(generate_scenario(
        "power_outage", cfg, 24,
        "Mains with power outage for 6h"
    ))

    # 6. compressor_failure — 24 records (6h), mains with COMPRESSOR_FAILURE
    cfg = default_config("mains", latitude=LATITUDE)
    cfg.random_seed = SEED
    cfg.sample_interval = INTERVAL
    cfg.fault = FaultConfig(
        fault_type=FaultType.COMPRESSOR_FAILURE,
        fault_start_offset_s=0.0,
        fault_duration_s=21600.0,
    )
    scenarios.append(generate_scenario(
        "compressor_failure", cfg, 24,
        "Mains with compressor failure for 6h"
    ))

    # 7. icebank_unit — 96 records (24h), solar with custom icebank params
    cfg = default_config("solar", latitude=LATITUDE)
    cfg.random_seed = SEED
    cfg.sample_interval = INTERVAL
    cfg.thermal.icebank_capacity_j = 3_000_000.0
    cfg.thermal.R_icebank = 0.375
    cfg.thermal.compressor_targets_icebank = True
    scenarios.append(generate_scenario(
        "icebank_unit", cfg, 96,
        "Solar with custom icebank (3MJ capacity), 24h"
    ))

    # 8. busy_facility — 24 records (6h), mains with busy_facility events
    cfg = default_config("mains", latitude=LATITUDE)
    cfg.random_seed = SEED
    cfg.sample_interval = INTERVAL
    cfg.events = EventConfig.busy_facility()
    scenarios.append(generate_scenario(
        "busy_facility", cfg, 24,
        "Mains with busy_facility event preset, 6h"
    ))

    # Write each scenario to its own file
    for scenario in scenarios:
        name = scenario["scenario"]
        filepath = FIXTURES_DIR / f"{name}.json"
        with open(filepath, "w") as f:
            json.dump(scenario, f, indent=2)
        print(f"  Generated: {filepath.name} ({len(scenario['records'])} records)")

    print(f"\nAll {len(scenarios)} fixtures written to {FIXTURES_DIR}")


if __name__ == "__main__":
    main()
