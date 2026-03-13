"""
SimulatedRecordSet: the integration layer that orchestrates thermal, power,
and event models into schema-compatible record batches.

Drop-in replacement for the old RecordSet/RecordSetFactory from ccedata.py.
"""

import random
import datetime as dt
from dataclasses import dataclass, field
from typing import List, Optional

from utils.simulator.config import SimulationConfig
from utils.simulator.thermal import ThermalModel, ThermalState, AmbientModel, DoorEvent
from utils.simulator.power import MainsPowerModel, SolarPowerModel, PowerState
from utils.simulator.events import DoorEventGenerator, FaultInjector, AlarmGenerator
from utils.schemas import RtmdRecord, EmsRecordMains, EmsRecordSolar


@dataclass
class SimulatorState:
    """Persistent state carried between successive generate() calls.

    Allows a BaseRtmDevice to call generate() repeatedly (e.g., every
    upload interval) with continuity in TVC, battery SOC, etc.
    """
    tvc: float = 5.0
    compressor_on: bool = False
    battery_soc: float = 0.8
    cumulative_powered_s: float = 0.0
    rng_state: Optional[tuple] = None
    icebank_soc: float = 1.0  # Icebank state of charge (0.0–1.0)
    tvc_contents: Optional[float] = None  # Bulk contents temp (two-node model)
    # Internal state for sub-models (not user-facing)
    _power_in_outage: bool = False
    _power_outage_end: Optional[dt.datetime] = None
    _alarm_last_power_loss: Optional[dt.datetime] = None
    _alarm_power_was_available: bool = True


class SimulatedRecordSet:
    """A batch of simulated CCE records with conversion methods.

    Provides the same interface as the old RecordSet from ccedata.py:
      - .records: list of dicts
      - .to_rtmd() -> List[RtmdRecord]
      - .to_ems(powersource) -> List[EmsRecordMains|EmsRecordSolar]
      - .state: SimulatorState for continuity
    """

    def __init__(self, records: List[dict], state: SimulatorState, power_type: str):
        self.records = records
        self.state = state
        self._power_type = power_type

    @classmethod
    def generate(
        cls,
        config: SimulationConfig,
        batch_size: int,
        start_time: dt.datetime,
        interval: int = 900,
        state: Optional[SimulatorState] = None,
    ) -> 'SimulatedRecordSet':
        """Run the simulation and produce a batch of records.

        Args:
            config: Full simulation configuration.
            batch_size: Number of records to generate.
            start_time: Timestamp of the first record.
            interval: Seconds between records.
            state: Previous state for continuity. None = fresh start.

        Returns:
            SimulatedRecordSet with records and updated state.
        """
        # Initialize RNG
        if state is not None and state.rng_state is not None:
            rng = random.Random()
            rng.setstate(state.rng_state)
        elif config.random_seed is not None:
            rng = random.Random(config.random_seed)
        else:
            rng = random.Random()

        # Initialize state
        if state is None:
            state = SimulatorState(
                tvc=config.thermal.initial_tvc,
                battery_soc=config.power.battery_initial_soc,
                icebank_soc=config.thermal.icebank_initial_soc,
            )

        # Build sub-models
        thermal_model = ThermalModel(config.thermal)
        ambient_model = AmbientModel(config.ambient, rng)
        door_gen = DoorEventGenerator(config.events, rng)
        fault_injector = FaultInjector(config.fault, start_time)
        alarm_gen = AlarmGenerator(rng)

        # Restore alarm generator state
        alarm_gen._last_power_loss = state._alarm_last_power_loss
        alarm_gen._power_was_available = state._alarm_power_was_available

        # Build power model
        power_state = PowerState(
            cumulative_powered_s=state.cumulative_powered_s,
            battery_soc=state.battery_soc,
            in_outage=state._power_in_outage,
            outage_end=state._power_outage_end,
        )

        is_solar = config.power.power_type == "solar"
        if is_solar:
            power_model = SolarPowerModel(config.power, rng)
        else:
            power_model = MainsPowerModel(config.power, rng)

        # Thermal state
        thermal_state = ThermalState(
            tvc=state.tvc,
            compressor_on=state.compressor_on,
            icebank_soc=state.icebank_soc,
            tvc_contents=state.tvc_contents,
        )

        records = []

        for i in range(batch_size):
            timestamp = start_time + dt.timedelta(seconds=i * interval)

            # 1. Ambient temperature
            tamb = ambient_model.get_tamb(timestamp)

            # 2. Door events
            door_events = door_gen.get_door_events(timestamp, interval)

            # 3. Fault effects
            fault_effects = fault_injector.get_fault_effects(timestamp)

            # 4. Power availability
            if fault_effects.power_available_override is not None:
                power_available = fault_effects.power_available_override
            elif is_solar:
                power_available = power_model.is_power_available(power_state, timestamp)
            else:
                power_available = power_model.is_power_available(power_state)

            # 5. Compressor availability (power + fault)
            compressor_available = power_available and fault_effects.compressor_available

            # 6. Apply stuck door fault
            if fault_effects.door_forced_open:
                door_events = [DoorEvent(start_offset_s=0, duration_s=float(interval))]

            # 7. Compute Q_compressor override for refrigerant leak
            q_override = None
            if fault_effects.q_compressor_multiplier < 1.0:
                q_override = config.thermal.Q_compressor * fault_effects.q_compressor_multiplier

            # 8. Thermal simulation
            thermal_state, thermal_record = thermal_model.simulate_interval(
                state=thermal_state,
                tamb=tamb,
                interval_s=float(interval),
                compressor_available=compressor_available,
                door_events=door_events,
                q_compressor_override=q_override,
            )

            # 9. Power readings
            power_state, power_record = power_model.simulate_interval(
                state=power_state,
                timestamp=timestamp,
                interval_s=float(interval),
                compressor_runtime_s=float(thermal_record['CMPR']),
            )

            # 10. Alarms
            alarm_record = alarm_gen.derive_alarms(
                tvc=thermal_state.tvc,
                power_available=power_available,
                timestamp=timestamp,
            )

            # 11. Battery/BLOG for mains (derive from a simple constant)
            if not is_solar:
                blog = round(max(0, min(14.0, rng.gauss(12.0, 0.3))), 1)
                power_record['BLOG'] = blog
                power_record['BEMD'] = blog

            # Assemble the record
            record = {'ABST': timestamp}
            record.update(thermal_record)
            record.update(power_record)
            record.update(alarm_record)

            records.append(record)

        # Save state for next call
        new_state = SimulatorState(
            tvc=thermal_state.tvc,
            compressor_on=thermal_state.compressor_on,
            battery_soc=power_state.battery_soc,
            cumulative_powered_s=power_state.cumulative_powered_s,
            rng_state=rng.getstate(),
            icebank_soc=thermal_state.icebank_soc,
            tvc_contents=thermal_state.tvc_contents,
            _power_in_outage=power_state.in_outage,
            _power_outage_end=power_state.outage_end,
            _alarm_last_power_loss=alarm_gen._last_power_loss,
            _alarm_power_was_available=alarm_gen._power_was_available,
        )

        return cls(records, new_state, config.power.power_type)

    def to_rtmd(self) -> List[RtmdRecord]:
        """Convert records to RTMD format (subset of fields)."""
        rtmd_fields = ['ABST', 'BEMD', 'TVC', 'TAMB', 'ALRM', 'EERR']
        filtered = [{k: r[k] for k in rtmd_fields if k in r} for r in self.records]
        return [RtmdRecord(**rec) for rec in filtered]

    def to_ems(self, powersource: str = None) -> List[EmsRecordMains | EmsRecordSolar]:
        """Convert records to EMS format.

        Args:
            powersource: 'mains' or 'solar'. If None, inferred from config.
        """
        if powersource is None:
            powersource = self._power_type

        base_fields = [
            'ABST', 'ALRM', 'BEMD', 'BLOG', 'CMPR', 'DORV',
            'HAMB', 'HOLD', 'EERR', 'TAMB', 'TCON', 'TVC',
        ]

        if powersource == 'solar':
            extra_fields = ['DCCD', 'DCSV']
            schema = EmsRecordSolar
        else:
            extra_fields = ['ACCD', 'ACSV', 'SVA']
            schema = EmsRecordMains

        all_fields = base_fields + extra_fields
        result = []
        for r in self.records:
            filtered = {k: r[k] for k in all_fields if k in r}
            # Map EERR to LERR for EMS schema compatibility
            if 'EERR' in filtered:
                filtered['LERR'] = filtered.pop('EERR')
            result.append(schema(**filtered))

        return result
