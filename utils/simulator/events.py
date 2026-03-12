"""
Event generators for door openings, fault injection, and alarm derivation.
"""

import random
import datetime as dt
from dataclasses import dataclass
from typing import List, Optional

from utils.simulator.config import EventConfig, FaultConfig, FaultType
from utils.simulator.thermal import DoorEvent


@dataclass
class FaultEffects:
    """The effects of an active fault on the simulation.

    compressor_available: Whether the compressor can run.
    door_forced_open: Whether the door is stuck open.
    q_compressor_multiplier: Multiplier on Q_compressor (< 1.0 for refrigerant leak).
    power_available_override: If set, overrides the power model's availability.
    """
    compressor_available: bool = True
    door_forced_open: bool = False
    q_compressor_multiplier: float = 1.0
    power_available_override: Optional[bool] = None


class DoorEventGenerator:
    """Generates door opening events using a non-homogeneous Poisson process."""

    def __init__(self, config: EventConfig, rng: random.Random):
        self.config = config
        self.rng = rng

    def _is_working_hours(self, timestamp: dt.datetime) -> bool:
        hour = timestamp.hour + timestamp.minute / 60.0
        start, end = self.config.working_hours
        return start <= hour < end

    def get_door_events(self, interval_start: dt.datetime, interval_s: float) -> List[DoorEvent]:
        """Generate door events for one sample interval.

        Uses a Poisson process with rate depending on whether we're in working hours.
        """
        if self._is_working_hours(interval_start):
            rate = self.config.door_rate_per_hour
        else:
            rate = self.config.door_rate_per_hour * self.config.off_hours_rate_fraction

        # Expected events in this interval
        expected = rate * (interval_s / 3600.0)
        n_events = self.rng.poisson(expected) if hasattr(self.rng, 'poisson') else self._poisson(expected)

        events = []
        for _ in range(n_events):
            offset = self.rng.uniform(0, interval_s)
            duration = max(1.0, self.rng.gauss(
                self.config.door_mean_duration_s,
                self.config.door_std_duration_s
            ))
            # Clamp duration so it doesn't extend beyond interval
            duration = min(duration, interval_s - offset)
            events.append(DoorEvent(start_offset_s=offset, duration_s=duration))

        return events

    def _poisson(self, lam: float) -> int:
        """Generate a Poisson-distributed random number using the inverse transform."""
        if lam <= 0:
            return 0
        import math
        L = math.exp(-lam)
        k = 0
        p = 1.0
        while True:
            k += 1
            p *= self.rng.random()
            if p < L:
                return k - 1


class FaultInjector:
    """Manages fault state and computes fault effects over time."""

    def __init__(self, config: FaultConfig, sim_start: dt.datetime):
        self.config = config
        self.sim_start = sim_start

        if config.fault_type != FaultType.NONE:
            self.fault_start = sim_start + dt.timedelta(seconds=config.fault_start_offset_s)
            if config.fault_duration_s > 0:
                self.fault_end = self.fault_start + dt.timedelta(seconds=config.fault_duration_s)
            else:
                self.fault_end = None  # Permanent fault
        else:
            self.fault_start = None
            self.fault_end = None

    def is_fault_active(self, timestamp: dt.datetime) -> bool:
        if self.config.fault_type == FaultType.NONE:
            return False
        if self.fault_start is None:
            return False
        if timestamp < self.fault_start:
            return False
        if self.fault_end is not None and timestamp >= self.fault_end:
            return False
        return True

    def get_fault_effects(self, timestamp: dt.datetime) -> FaultEffects:
        """Get the effects of any active fault at the given timestamp."""
        if not self.is_fault_active(timestamp):
            return FaultEffects()

        fault = self.config.fault_type

        if fault == FaultType.POWER_OUTAGE:
            return FaultEffects(
                compressor_available=False,
                power_available_override=False,
            )
        elif fault == FaultType.STUCK_DOOR:
            return FaultEffects(door_forced_open=True)
        elif fault == FaultType.COMPRESSOR_FAILURE:
            return FaultEffects(compressor_available=False)
        elif fault == FaultType.REFRIGERANT_LEAK:
            # Gradually reduce cooling capacity over time
            elapsed_h = (timestamp - self.fault_start).total_seconds() / 3600.0
            multiplier = max(0.0, 1.0 - self.config.refrigerant_leak_rate * elapsed_h)
            return FaultEffects(q_compressor_multiplier=multiplier)

        return FaultEffects()


class AlarmGenerator:
    """Derives alarm fields from simulation state."""

    def __init__(self, rng: random.Random):
        self.rng = rng
        self._last_power_loss: Optional[dt.datetime] = None
        self._power_was_available: bool = True

    def derive_alarms(
        self,
        tvc: float,
        power_available: bool,
        timestamp: dt.datetime,
    ) -> dict:
        """Compute ALRM, HOLD, and EERR fields.

        Args:
            tvc: Current vaccine chamber temperature.
            power_available: Whether power is currently available.
            timestamp: Current timestamp.

        Returns:
            Dict with ALRM, HOLD, EERR keys.
        """
        # Track power loss for HOLD calculation
        if not power_available and self._power_was_available:
            self._last_power_loss = timestamp
        if power_available:
            self._last_power_loss = None
        self._power_was_available = power_available

        # ALRM
        alrm = None
        if tvc > 8.0:
            alrm = "HEAT"
        elif tvc < 2.0:
            alrm = "FREEZE"

        # HOLD: seconds since power loss (holdover time)
        hold = None
        if self._last_power_loss is not None:
            hold = round((timestamp - self._last_power_loss).total_seconds(), 1)

        # EERR: random low-probability error
        eerr = None
        if self.rng.random() < 0.001:
            eerr = ''.join(self.rng.choices('abcdefghijklmnopqrstuvwxyz', k=5))

        return {
            'ALRM': alrm,
            'HOLD': hold,
            'EERR': eerr,
        }
