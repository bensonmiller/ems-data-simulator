"""
Event generators for door openings, fault injection, and alarm derivation.
"""

import math
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
            # Exponential decay of cooling capacity.
            #
            # Real-world thermosyphon leaks (from InfluxDB field data) show:
            #   - Gradual loss over weeks/months, not hours
            #   - Two-phase pattern: degraded-but-stable, then rapid failure
            #     once icebank depletes (the icebank dynamics handle phase 2)
            #   - Exponential fits physics: leak rate ∝ remaining refrigerant
            #     pressure, which decreases as gas escapes
            #
            # Reference: unit 2807-CB2A-0A00-00C8 (issue #616): onset March 5
            # 2021, degraded 60 days, failure May 6 once icebank depleted.
            elapsed_h = (timestamp - self.fault_start).total_seconds() / 3600.0
            multiplier = math.exp(-self.config.refrigerant_leak_rate * elapsed_h)
            # Below 5% capacity, the syphon can't sustain two-phase flow
            # and effectively disconnects — no cooling reaches the VCC.
            if multiplier < 0.05:
                multiplier = 0.0
            return FaultEffects(q_compressor_multiplier=multiplier)

        return FaultEffects()


class AlarmGenerator:
    """Derives alarm fields from simulation state.

    Alarm codes follow the WHO PQS E003 specification.  The ALRM field
    carries all currently active codes as a space-separated string
    (e.g. ``"HEAT DOOR"``).

    Supported alarms and their continuous-excursion thresholds:
    - HEAT: TVC > +8 °C for 10 continuous hours.
    - FRZE: TVC <= −0.5 °C for 60 continuous minutes.
    - DOOR: door/lid continuously open for > 5 minutes.
    - POWR: continuous no-power condition for > 24 hours.
    """

    # Duration thresholds (seconds)
    HEAT_THRESHOLD_S = 10 * 3600   # 10 hours
    FRZE_THRESHOLD_S = 60 * 60     # 60 minutes
    DOOR_THRESHOLD_S = 5 * 60      # 5 minutes
    POWR_THRESHOLD_S = 24 * 3600   # 24 hours

    def __init__(self, rng: random.Random):
        self.rng = rng
        self._last_power_loss: Optional[dt.datetime] = None
        self._power_was_available: bool = True
        # Continuous excursion tracking
        self._heat_excursion_start: Optional[dt.datetime] = None
        self._frze_excursion_start: Optional[dt.datetime] = None
        # Cross-interval door continuity tracking
        self._continuous_door_start: Optional[dt.datetime] = None
        self._door_open_at_prev_end: bool = False

    def _merge_door_spans(self, door_events: List[DoorEvent]) -> List[tuple]:
        """Merge overlapping/adjacent door events into continuous spans.

        Returns a sorted list of (start_offset_s, end_offset_s) tuples.
        """
        if not door_events:
            return []
        EPSILON = 1.0
        events = sorted(door_events, key=lambda e: e.start_offset_s)
        spans = []
        cur_start = events[0].start_offset_s
        cur_end = events[0].start_offset_s + events[0].duration_s
        for e in events[1:]:
            e_end = e.start_offset_s + e.duration_s
            if e.start_offset_s <= cur_end + EPSILON:
                cur_end = max(cur_end, e_end)
            else:
                spans.append((cur_start, cur_end))
                cur_start = e.start_offset_s
                cur_end = e_end
        spans.append((cur_start, cur_end))
        return spans

    def _check_door_alarm(
        self,
        door_events: List[DoorEvent],
        interval_s: float,
        timestamp: dt.datetime,
    ) -> bool:
        """Evaluate DOOR alarm using sub-interval door events.

        Detects continuous door-open periods >= DOOR_THRESHOLD_S, including
        spans that straddle interval boundaries.
        """
        EPSILON = 1.0
        spans = self._merge_door_spans(door_events)

        if not spans:
            # No door activity — reset continuity
            self._continuous_door_start = None
            self._door_open_at_prev_end = False
            return False

        open_at_start = spans[0][0] <= EPSILON
        open_at_end = spans[-1][1] >= interval_s - EPSILON

        triggered = False

        if self._door_open_at_prev_end and open_at_start:
            # Continuity from previous interval — find how far the
            # door stays open from offset 0 (first merged span).
            continuous_end = spans[0][1]
            total_s = (timestamp - self._continuous_door_start).total_seconds() + continuous_end
            if total_s >= self.DOOR_THRESHOLD_S:
                triggered = True
            # If the first span doesn't reach interval end, the carry-over
            # chain breaks here; start fresh from the last span if needed.
            if not open_at_end or (len(spans) > 1 and spans[0][1] < interval_s - EPSILON):
                # First span didn't bridge all the way to end; reset.
                if open_at_end:
                    # A *different* span reaches the end — new chain.
                    last_start = spans[-1][0]
                    self._continuous_door_start = timestamp + dt.timedelta(seconds=last_start)
                else:
                    self._continuous_door_start = None
            # else: single span covers start-to-end, keep existing _continuous_door_start
        else:
            # No carry-over — check individual spans within this interval.
            for s_start, s_end in spans:
                if s_end - s_start >= self.DOOR_THRESHOLD_S:
                    triggered = True
                    break
            # Seed carry-over from the span that reaches the interval end.
            if open_at_end:
                self._continuous_door_start = timestamp + dt.timedelta(seconds=spans[-1][0])
            else:
                self._continuous_door_start = None

        self._door_open_at_prev_end = open_at_end
        return triggered

    def derive_alarms(
        self,
        tvc: float,
        power_available: bool,
        timestamp: dt.datetime,
        door_events: Optional[List[DoorEvent]] = None,
        interval_s: float = 900.0,
    ) -> dict:
        """Compute ALRM, HOLD, and EERR fields.

        Args:
            tvc: Current vaccine chamber temperature.
            power_available: Whether power is currently available.
            timestamp: Current timestamp.
            door_events: Sub-interval door events for DOOR alarm evaluation.
            interval_s: Length of the sample interval in seconds.

        Returns:
            Dict with ALRM, HOLD, EERR keys.  ALRM is a space-separated
            string of all active alarm codes, or None if no alarms are active.
        """
        # Track power loss for HOLD calculation
        if not power_available and self._power_was_available:
            self._last_power_loss = timestamp
        if power_available:
            self._last_power_loss = None
        self._power_was_available = power_available

        # Collect active alarm codes
        codes: List[str] = []

        # HEAT: continuous TVC > 8.0°C for 10 hours
        if tvc > 8.0:
            if self._heat_excursion_start is None:
                self._heat_excursion_start = timestamp
            elapsed = (timestamp - self._heat_excursion_start).total_seconds()
            if elapsed >= self.HEAT_THRESHOLD_S:
                codes.append("HEAT")
        else:
            self._heat_excursion_start = None

        # FRZE: continuous TVC <= -0.5°C for 60 minutes
        if tvc <= -0.5:
            if self._frze_excursion_start is None:
                self._frze_excursion_start = timestamp
            elapsed = (timestamp - self._frze_excursion_start).total_seconds()
            if elapsed >= self.FRZE_THRESHOLD_S:
                codes.append("FRZE")
        else:
            self._frze_excursion_start = None

        # DOOR: continuous door open > 5 minutes
        if door_events is not None and self._check_door_alarm(door_events, interval_s, timestamp):
            codes.append("DOOR")

        # POWR: continuous no-power > 24 hours
        if self._last_power_loss is not None:
            power_elapsed = (timestamp - self._last_power_loss).total_seconds()
            if power_elapsed >= self.POWR_THRESHOLD_S:
                codes.append("POWR")

        # HOLD: seconds since power loss (holdover time)
        hold = None
        if self._last_power_loss is not None:
            hold = round((timestamp - self._last_power_loss).total_seconds(), 1)

        # EERR: random low-probability error
        eerr = None
        if self.rng.random() < 0.001:
            eerr = ''.join(self.rng.choices('abcdefghijklmnopqrstuvwxyz', k=5))

        return {
            'ALRM': ' '.join(codes) if codes else None,
            'HOLD': hold,
            'EERR': eerr,
        }
