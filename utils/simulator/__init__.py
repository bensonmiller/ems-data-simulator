"""
CCE Thermal Simulator — physics-based synthetic data generator for
cold chain equipment monitoring (EMS and RTMD).

Usage:
    from utils.simulator import SimulatedRecordSet, default_config

    config = default_config("mains", latitude=13.0)
    rs = SimulatedRecordSet.generate(config, batch_size=96, start_time=now)
    ems_records = rs.to_ems()
"""

from utils.simulator.config import (
    SimulationConfig,
    ThermalConfig,
    AmbientConfig,
    PowerConfig,
    EventConfig,
    FaultConfig,
    FaultType,
    default_config,
)
from utils.simulator.recordset import SimulatedRecordSet, SimulatorState

__all__ = [
    "SimulatedRecordSet",
    "SimulatorState",
    "SimulationConfig",
    "ThermalConfig",
    "AmbientConfig",
    "PowerConfig",
    "EventConfig",
    "FaultConfig",
    "FaultType",
    "default_config",
]
