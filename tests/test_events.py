"""Unit tests for utils.simulator.events module."""

import random
import datetime as dt

import pytest

from utils.simulator.config import EventConfig, FaultConfig, FaultType
from utils.simulator.events import (
    DoorEventGenerator,
    FaultEffects,
    FaultInjector,
    AlarmGenerator,
)
from utils.simulator.thermal import DoorEvent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_rng(seed=42):
    return random.Random(seed)


def _working_timestamp():
    """Return a timestamp during working hours (noon on a Monday)."""
    return dt.datetime(2025, 6, 2, 12, 0, 0)


def _off_hours_timestamp():
    """Return a timestamp outside working hours (2 AM)."""
    return dt.datetime(2025, 6, 2, 2, 0, 0)


SIM_START = dt.datetime(2025, 6, 1, 0, 0, 0)


# ===================================================================
# 1. DoorEventGenerator
# ===================================================================

class TestDoorEventGenerator:
    """DoorEventGenerator produces DoorEvent objects with valid offsets/durations."""

    def test_returns_door_event_objects(self):
        gen = DoorEventGenerator(EventConfig(door_rate_per_hour=20.0), _make_rng())
        events = gen.get_door_events(_working_timestamp(), interval_s=900.0)
        assert all(isinstance(e, DoorEvent) for e in events)

    def test_offsets_within_interval(self):
        gen = DoorEventGenerator(EventConfig(door_rate_per_hour=20.0), _make_rng())
        events = gen.get_door_events(_working_timestamp(), interval_s=900.0)
        assert len(events) > 0, "Expected at least one event with high rate"
        for e in events:
            assert 0 <= e.start_offset_s <= 900.0

    def test_durations_positive_and_within_interval(self):
        gen = DoorEventGenerator(EventConfig(door_rate_per_hour=20.0), _make_rng())
        events = gen.get_door_events(_working_timestamp(), interval_s=900.0)
        for e in events:
            assert e.duration_s >= 1.0
            assert e.start_offset_s + e.duration_s <= 900.0

    def test_zero_rate_produces_no_events(self):
        gen = DoorEventGenerator(EventConfig(door_rate_per_hour=0.0), _make_rng())
        events = gen.get_door_events(_working_timestamp(), interval_s=900.0)
        assert events == []


# ===================================================================
# 2. Working hours vs off-hours rate difference
# ===================================================================

class TestDoorEventRates:
    """Working hours should produce significantly more events than off hours."""

    def test_working_hours_more_events_than_off_hours(self):
        config = EventConfig(
            door_rate_per_hour=10.0,
            off_hours_rate_fraction=0.05,
        )
        rng_seed = 99
        n_trials = 200
        interval_s = 900.0

        work_total = 0
        off_total = 0
        for i in range(n_trials):
            rng = _make_rng(rng_seed + i)
            gen = DoorEventGenerator(config, rng)
            work_total += len(gen.get_door_events(_working_timestamp(), interval_s))
            off_total += len(gen.get_door_events(_off_hours_timestamp(), interval_s))

        # Working hours should produce at least 5x more events given 0.05 fraction
        assert work_total > off_total * 3

    def test_is_working_hours_boundary(self):
        config = EventConfig(working_hours=(8, 17))
        gen = DoorEventGenerator(config, _make_rng())
        # 8:00 is working hours
        assert gen._is_working_hours(dt.datetime(2025, 6, 2, 8, 0, 0)) is True
        # 17:00 is NOT working hours (end is exclusive)
        assert gen._is_working_hours(dt.datetime(2025, 6, 2, 17, 0, 0)) is False
        # 7:59 is off hours
        assert gen._is_working_hours(dt.datetime(2025, 6, 2, 7, 59, 0)) is False
        # 16:59 is working hours
        assert gen._is_working_hours(dt.datetime(2025, 6, 2, 16, 59, 0)) is True


# ===================================================================
# 3. FaultInjector activation/deactivation
# ===================================================================

class TestFaultInjector:
    """FaultInjector correctly activates/deactivates faults based on timing."""

    def test_no_fault_always_inactive(self):
        cfg = FaultConfig(fault_type=FaultType.NONE)
        inj = FaultInjector(cfg, SIM_START)
        assert inj.is_fault_active(SIM_START) is False
        assert inj.is_fault_active(SIM_START + dt.timedelta(hours=10)) is False

    def test_fault_activates_at_offset(self):
        cfg = FaultConfig(
            fault_type=FaultType.POWER_OUTAGE,
            fault_start_offset_s=3600.0,
            fault_duration_s=1800.0,
        )
        inj = FaultInjector(cfg, SIM_START)
        # Before fault start
        assert inj.is_fault_active(SIM_START + dt.timedelta(seconds=3599)) is False
        # At fault start
        assert inj.is_fault_active(SIM_START + dt.timedelta(seconds=3600)) is True
        # During fault
        assert inj.is_fault_active(SIM_START + dt.timedelta(seconds=4000)) is True
        # At fault end (exclusive)
        assert inj.is_fault_active(SIM_START + dt.timedelta(seconds=5400)) is False
        # After fault end
        assert inj.is_fault_active(SIM_START + dt.timedelta(seconds=6000)) is False

    def test_permanent_fault(self):
        cfg = FaultConfig(
            fault_type=FaultType.STUCK_DOOR,
            fault_start_offset_s=100.0,
            fault_duration_s=0,  # permanent
        )
        inj = FaultInjector(cfg, SIM_START)
        assert inj.is_fault_active(SIM_START + dt.timedelta(seconds=99)) is False
        assert inj.is_fault_active(SIM_START + dt.timedelta(seconds=100)) is True
        # Still active far in the future
        assert inj.is_fault_active(SIM_START + dt.timedelta(days=365)) is True

    def test_inactive_fault_returns_default_effects(self):
        cfg = FaultConfig(
            fault_type=FaultType.POWER_OUTAGE,
            fault_start_offset_s=3600.0,
            fault_duration_s=1800.0,
        )
        inj = FaultInjector(cfg, SIM_START)
        effects = inj.get_fault_effects(SIM_START)  # before fault
        assert effects.compressor_available is True
        assert effects.door_forced_open is False
        assert effects.q_compressor_multiplier == 1.0
        assert effects.power_available_override is None


# ===================================================================
# 4. FaultType -> FaultEffects mapping
# ===================================================================

class TestFaultEffects:
    """Each FaultType produces the correct FaultEffects."""

    def _active_effects(self, fault_type, **kwargs):
        cfg = FaultConfig(
            fault_type=fault_type,
            fault_start_offset_s=0.0,
            fault_duration_s=7200.0,
            **kwargs,
        )
        inj = FaultInjector(cfg, SIM_START)
        return inj.get_fault_effects(SIM_START + dt.timedelta(seconds=1))

    def test_power_outage(self):
        fx = self._active_effects(FaultType.POWER_OUTAGE)
        assert fx.compressor_available is False
        assert fx.power_available_override is False
        assert fx.door_forced_open is False
        assert fx.q_compressor_multiplier == 1.0

    def test_stuck_door(self):
        fx = self._active_effects(FaultType.STUCK_DOOR)
        assert fx.door_forced_open is True
        assert fx.compressor_available is True
        assert fx.power_available_override is None

    def test_compressor_failure(self):
        fx = self._active_effects(FaultType.COMPRESSOR_FAILURE)
        assert fx.compressor_available is False
        assert fx.door_forced_open is False
        assert fx.power_available_override is None

    def test_refrigerant_leak_initial(self):
        cfg = FaultConfig(
            fault_type=FaultType.REFRIGERANT_LEAK,
            fault_start_offset_s=0.0,
            fault_duration_s=7200.0,
            refrigerant_leak_rate=0.002,
        )
        inj = FaultInjector(cfg, SIM_START)
        # Right at the start of the fault (1 second in) -> barely any leak
        fx = inj.get_fault_effects(SIM_START + dt.timedelta(seconds=1))
        assert 0.99 < fx.q_compressor_multiplier <= 1.0

    def test_refrigerant_leak_progresses_exponentially(self):
        """Exponential decay: multiplier = exp(-rate * elapsed_h)."""
        import math
        cfg = FaultConfig(
            fault_type=FaultType.REFRIGERANT_LEAK,
            fault_start_offset_s=0.0,
            fault_duration_s=0,  # permanent
            refrigerant_leak_rate=0.10,
        )
        inj = FaultInjector(cfg, SIM_START)
        # After 5 hours: multiplier = exp(-0.10 * 5) = exp(-0.5) ≈ 0.6065
        fx = inj.get_fault_effects(SIM_START + dt.timedelta(hours=5))
        expected = math.exp(-0.10 * 5)
        assert abs(fx.q_compressor_multiplier - expected) < 0.001

    def test_refrigerant_leak_clamps_to_zero(self):
        """Below 5% capacity, syphon disconnects → multiplier clamped to 0.0."""
        cfg = FaultConfig(
            fault_type=FaultType.REFRIGERANT_LEAK,
            fault_start_offset_s=0.0,
            fault_duration_s=0,  # permanent
            refrigerant_leak_rate=0.50,
        )
        inj = FaultInjector(cfg, SIM_START)
        # After 20 hours: exp(-0.5*20) = exp(-10) ≈ 4.5e-5 → clamped to 0.0
        fx = inj.get_fault_effects(SIM_START + dt.timedelta(hours=20))
        assert fx.q_compressor_multiplier == 0.0

    def test_refrigerant_leak_above_threshold_not_clamped(self):
        """Just above 5% threshold, multiplier is not clamped."""
        import math
        cfg = FaultConfig(
            fault_type=FaultType.REFRIGERANT_LEAK,
            fault_start_offset_s=0.0,
            fault_duration_s=0,
            refrigerant_leak_rate=0.002,
        )
        inj = FaultInjector(cfg, SIM_START)
        # After 30 days: exp(-0.002 * 720) ≈ 0.237 — well above threshold
        fx = inj.get_fault_effects(SIM_START + dt.timedelta(days=30))
        assert fx.q_compressor_multiplier > 0.05

    def test_refrigerant_leak_realistic_timeline(self):
        """Default rate 0.002 gives ~2-month failure timeline matching field data."""
        import math
        cfg = FaultConfig(
            fault_type=FaultType.REFRIGERANT_LEAK,
            fault_start_offset_s=0.0,
            fault_duration_s=0,
            refrigerant_leak_rate=0.002,  # default
        )
        inj = FaultInjector(cfg, SIM_START)
        # After 1 week: ~97% capacity remaining
        fx = inj.get_fault_effects(SIM_START + dt.timedelta(weeks=1))
        assert 0.70 < fx.q_compressor_multiplier < 0.75
        # After 1 month: ~23% capacity
        fx = inj.get_fault_effects(SIM_START + dt.timedelta(days=30))
        assert 0.20 < fx.q_compressor_multiplier < 0.27
        # After 2 months: ~5% capacity (effectively dead)
        fx = inj.get_fault_effects(SIM_START + dt.timedelta(days=60))
        assert fx.q_compressor_multiplier < 0.07


# ===================================================================
# 5. AlarmGenerator: ALRM values
# ===================================================================

class TestAlarmGenerator:
    """AlarmGenerator derives HEAT/FRZE alarms per WHO continuous-excursion rules.

    HEAT: TVC > 8.0°C continuously for 10 hours before alarm triggers.
    FRZE: TVC <= -0.5°C continuously for 60 minutes before alarm triggers.
    Alarms clear when the excursion ends; timer resets for the next event.
    """

    # -- HEAT alarm ----------------------------------------------------------

    def test_no_heat_alarm_before_10_hours(self):
        """TVC > 8 for less than 10h should NOT produce a HEAT alarm."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        # 9 hours of excursion (< 10h threshold)
        for i in range(36):  # 36 intervals * 15min = 9h
            result = ag.derive_alarms(tvc=10.0, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        assert result['ALRM'] is None

    def test_heat_alarm_triggers_at_10_hours(self):
        """HEAT alarm should appear once excursion reaches 10 continuous hours."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        # Feed 41 intervals (10h 15m) of continuous > 8°C
        for i in range(41):
            result = ag.derive_alarms(tvc=10.0, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        assert result['ALRM'] == 'HEAT'

    def test_heat_alarm_clears_when_temp_recovers(self):
        """HEAT alarm should stop as soon as TVC drops back to normal."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        # Build up a HEAT alarm (11 hours)
        for i in range(44):
            ag.derive_alarms(tvc=10.0, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        # Temperature recovers
        result = ag.derive_alarms(tvc=5.0, power_available=True, timestamp=t)
        assert result['ALRM'] is None

    def test_heat_timer_resets_after_recovery(self):
        """After temp recovers, a new excursion needs a full 10h again."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        # 11h excursion → HEAT alarm active
        for i in range(44):
            ag.derive_alarms(tvc=10.0, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        # Recover
        ag.derive_alarms(tvc=5.0, power_available=True, timestamp=t)
        t += dt.timedelta(minutes=15)
        # New excursion for only 9h → no alarm
        for i in range(36):
            result = ag.derive_alarms(tvc=9.0, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        assert result['ALRM'] is None

    def test_heat_interrupted_excursion_resets(self):
        """A brief dip below 8°C resets the HEAT timer."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        # 9 hours hot
        for i in range(36):
            ag.derive_alarms(tvc=10.0, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        # Brief recovery
        ag.derive_alarms(tvc=7.0, power_available=True, timestamp=t)
        t += dt.timedelta(minutes=15)
        # Another 2 hours hot (total since reset = 2h, not 11h)
        for i in range(8):
            result = ag.derive_alarms(tvc=10.0, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        assert result['ALRM'] is None

    def test_heat_boundary_at_exactly_8(self):
        """TVC == 8.0 should NOT start a HEAT excursion (threshold is >8)."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        for i in range(50):
            result = ag.derive_alarms(tvc=8.0, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        assert result['ALRM'] is None

    # -- FRZE alarm ----------------------------------------------------------

    def test_no_frze_alarm_before_60_minutes(self):
        """TVC <= -0.5 for less than 60min should NOT produce a FRZE alarm."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        # 45 minutes (3 intervals)
        for i in range(3):
            result = ag.derive_alarms(tvc=-2.0, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        assert result['ALRM'] is None

    def test_frze_alarm_triggers_at_60_minutes(self):
        """FRZE alarm should appear once excursion reaches 60 continuous minutes."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        # 5 intervals = 75 min (exceeds 60min threshold)
        for i in range(5):
            result = ag.derive_alarms(tvc=-2.0, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        assert result['ALRM'] == 'FRZE'

    def test_frze_alarm_clears_when_temp_recovers(self):
        """FRZE alarm should stop when TVC rises above -0.5°C."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        # Build FRZE alarm (75 min)
        for i in range(5):
            ag.derive_alarms(tvc=-2.0, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        # Recover
        result = ag.derive_alarms(tvc=3.0, power_available=True, timestamp=t)
        assert result['ALRM'] is None

    def test_frze_boundary_at_minus_half(self):
        """TVC == -0.5 IS a freeze excursion (threshold is <= -0.5)."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        for i in range(5):
            result = ag.derive_alarms(tvc=-0.5, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        assert result['ALRM'] == 'FRZE'

    def test_frze_boundary_just_above(self):
        """TVC just above -0.5 should NOT trigger FRZE."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        for i in range(10):
            result = ag.derive_alarms(tvc=-0.4, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        assert result['ALRM'] is None

    # -- Normal range --------------------------------------------------------

    def test_no_alarm_in_normal_range(self):
        ag = AlarmGenerator(_make_rng(seed=1))
        result = ag.derive_alarms(tvc=5.0, power_available=True, timestamp=SIM_START)
        assert result['ALRM'] is None


# ===================================================================
# 5b. DOOR alarm
# ===================================================================

class TestDoorAlarm:
    """DOOR alarm triggers after > 5 minutes of continuous door opening."""

    def test_no_alarm_short_door_event(self):
        """A 4-minute door event should NOT trigger DOOR alarm."""
        ag = AlarmGenerator(_make_rng(seed=1))
        events = [DoorEvent(start_offset_s=100, duration_s=240)]  # 4 min
        result = ag.derive_alarms(
            tvc=5.0, power_available=True, timestamp=SIM_START,
            door_events=events, interval_s=900.0,
        )
        assert result['ALRM'] is None

    def test_alarm_triggers_single_long_event(self):
        """A single 6-minute door event should trigger DOOR alarm."""
        ag = AlarmGenerator(_make_rng(seed=1))
        events = [DoorEvent(start_offset_s=100, duration_s=360)]  # 6 min
        result = ag.derive_alarms(
            tvc=5.0, power_available=True, timestamp=SIM_START,
            door_events=events, interval_s=900.0,
        )
        assert result['ALRM'] == 'DOOR'

    def test_alarm_boundary_exactly_5_minutes(self):
        """Exactly 5 minutes (300s) should trigger (threshold is >=)."""
        ag = AlarmGenerator(_make_rng(seed=1))
        events = [DoorEvent(start_offset_s=0, duration_s=300)]
        result = ag.derive_alarms(
            tvc=5.0, power_available=True, timestamp=SIM_START,
            door_events=events, interval_s=900.0,
        )
        assert result['ALRM'] == 'DOOR'

    def test_no_alarm_many_short_events(self):
        """Multiple short events totalling > 5 min should NOT trigger."""
        ag = AlarmGenerator(_make_rng(seed=1))
        # 10 events of 60s each (total 10 min) but none continuous
        events = [DoorEvent(start_offset_s=i * 90, duration_s=60) for i in range(10)]
        result = ag.derive_alarms(
            tvc=5.0, power_available=True, timestamp=SIM_START,
            door_events=events, interval_s=900.0,
        )
        assert result['ALRM'] is None

    def test_alarm_cross_interval_continuity(self):
        """Door open at end of interval N and start of N+1 should accumulate."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t0 = SIM_START
        interval = 900.0

        # Interval 0: door open for last 200s (offset 700, duration 200)
        events_0 = [DoorEvent(start_offset_s=700, duration_s=200)]
        ag.derive_alarms(
            tvc=5.0, power_available=True, timestamp=t0,
            door_events=events_0, interval_s=interval,
        )

        # Interval 1: door open from start for 200s
        t1 = t0 + dt.timedelta(seconds=interval)
        events_1 = [DoorEvent(start_offset_s=0, duration_s=200)]
        result = ag.derive_alarms(
            tvc=5.0, power_available=True, timestamp=t1,
            door_events=events_1, interval_s=interval,
        )
        # 200s + 200s = 400s > 300s → alarm
        assert result['ALRM'] == 'DOOR'

    def test_no_alarm_cross_interval_gap(self):
        """Door open at end of N but NOT at start of N+1 → no accumulation."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t0 = SIM_START
        interval = 900.0

        # Interval 0: door open for last 200s
        events_0 = [DoorEvent(start_offset_s=700, duration_s=200)]
        ag.derive_alarms(
            tvc=5.0, power_available=True, timestamp=t0,
            door_events=events_0, interval_s=interval,
        )

        # Interval 1: door opens at offset 10 (gap at start → not continuous)
        t1 = t0 + dt.timedelta(seconds=interval)
        events_1 = [DoorEvent(start_offset_s=10, duration_s=200)]
        result = ag.derive_alarms(
            tvc=5.0, power_available=True, timestamp=t1,
            door_events=events_1, interval_s=interval,
        )
        assert result['ALRM'] is None

    def test_alarm_stuck_door_across_intervals(self):
        """Full-interval door opening across 2 intervals (stuck door fault)."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        interval = 900.0

        # Two full intervals of door open (1800s >> 300s threshold)
        for i in range(2):
            events = [DoorEvent(start_offset_s=0, duration_s=interval)]
            result = ag.derive_alarms(
                tvc=5.0, power_available=True, timestamp=t,
                door_events=events, interval_s=interval,
            )
            t += dt.timedelta(seconds=interval)

        assert result['ALRM'] == 'DOOR'

    def test_alarm_clears_when_door_closes(self):
        """DOOR alarm should stop once the door is closed."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        interval = 900.0

        # Build DOOR alarm: stuck open for 2 intervals
        for i in range(2):
            events = [DoorEvent(start_offset_s=0, duration_s=interval)]
            ag.derive_alarms(
                tvc=5.0, power_available=True, timestamp=t,
                door_events=events, interval_s=interval,
            )
            t += dt.timedelta(seconds=interval)

        # Door closes — no events
        result = ag.derive_alarms(
            tvc=5.0, power_available=True, timestamp=t,
            door_events=[], interval_s=interval,
        )
        assert result['ALRM'] is None

    def test_no_alarm_when_no_door_events_passed(self):
        """When door_events is None (legacy call), DOOR alarm never fires."""
        ag = AlarmGenerator(_make_rng(seed=1))
        result = ag.derive_alarms(tvc=5.0, power_available=True, timestamp=SIM_START)
        assert result['ALRM'] is None


# ===================================================================
# 5c. POWR alarm
# ===================================================================

class TestPowrAlarm:
    """POWR alarm triggers after > 24 hours of continuous no-power."""

    def test_no_alarm_before_24_hours(self):
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        ag.derive_alarms(tvc=5.0, power_available=True, timestamp=t)
        # Power loss for 23 hours
        t += dt.timedelta(hours=1)
        ag.derive_alarms(tvc=5.0, power_available=False, timestamp=t)
        t += dt.timedelta(hours=23)
        result = ag.derive_alarms(tvc=5.0, power_available=False, timestamp=t)
        assert result['ALRM'] is None

    def test_alarm_triggers_at_24_hours(self):
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        ag.derive_alarms(tvc=5.0, power_available=True, timestamp=t)
        # Power loss
        t += dt.timedelta(hours=1)
        ag.derive_alarms(tvc=5.0, power_available=False, timestamp=t)
        # 25 hours later → 25h total outage
        t += dt.timedelta(hours=25)
        result = ag.derive_alarms(tvc=5.0, power_available=False, timestamp=t)
        assert result['ALRM'] == 'POWR'

    def test_alarm_clears_when_power_restored(self):
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        ag.derive_alarms(tvc=5.0, power_available=True, timestamp=t)
        # 26h outage → POWR alarm
        t += dt.timedelta(hours=1)
        ag.derive_alarms(tvc=5.0, power_available=False, timestamp=t)
        t += dt.timedelta(hours=26)
        ag.derive_alarms(tvc=5.0, power_available=False, timestamp=t)
        # Power restored
        t += dt.timedelta(hours=1)
        result = ag.derive_alarms(tvc=5.0, power_available=True, timestamp=t)
        assert result['ALRM'] is None

    def test_powr_coexists_with_heat(self):
        """POWR and HEAT can appear together in ALRM field."""
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        ag.derive_alarms(tvc=5.0, power_available=True, timestamp=t)
        # Sustained high temp + power loss for 25 hours
        t += dt.timedelta(hours=1)
        for i in range(100):  # 100 * 15min = 25 hours
            result = ag.derive_alarms(tvc=12.0, power_available=False, timestamp=t)
            t += dt.timedelta(minutes=15)
        # Both HEAT (>10h at >8°C) and POWR (>24h no power) should be active
        assert 'HEAT' in result['ALRM']
        assert 'POWR' in result['ALRM']


# ===================================================================
# 5d. Multi-code ALRM field
# ===================================================================

class TestMultiCodeAlarm:
    """ALRM field carries all active codes as a space-separated string."""

    def test_heat_and_door_together(self):
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        # 11 hours of TVC > 8 with door stuck open every interval
        for i in range(44):
            events = [DoorEvent(start_offset_s=0, duration_s=900.0)]
            result = ag.derive_alarms(
                tvc=10.0, power_available=True, timestamp=t,
                door_events=events, interval_s=900.0,
            )
            t += dt.timedelta(minutes=15)
        assert 'HEAT' in result['ALRM']
        assert 'DOOR' in result['ALRM']

    def test_single_alarm_no_trailing_space(self):
        ag = AlarmGenerator(_make_rng(seed=1))
        t = SIM_START
        for i in range(5):
            result = ag.derive_alarms(tvc=-2.0, power_available=True, timestamp=t)
            t += dt.timedelta(minutes=15)
        assert result['ALRM'] == 'FRZE'
        assert ' ' not in result['ALRM']


# ===================================================================
# 6. HOLD tracking during power loss
# ===================================================================

class TestHoldTracking:
    """HOLD should track seconds since power was lost."""

    def test_hold_none_when_power_available(self):
        ag = AlarmGenerator(_make_rng(seed=1))
        result = ag.derive_alarms(tvc=5.0, power_available=True, timestamp=SIM_START)
        assert result['HOLD'] is None

    def test_hold_starts_at_zero_on_power_loss(self):
        ag = AlarmGenerator(_make_rng(seed=1))
        t0 = SIM_START
        # First call with power on to establish state
        ag.derive_alarms(tvc=5.0, power_available=True, timestamp=t0)
        # Power goes out
        t1 = t0 + dt.timedelta(seconds=100)
        result = ag.derive_alarms(tvc=5.0, power_available=False, timestamp=t1)
        assert result['HOLD'] == 0.0

    def test_hold_increments_during_outage(self):
        ag = AlarmGenerator(_make_rng(seed=1))
        t0 = SIM_START
        ag.derive_alarms(tvc=5.0, power_available=True, timestamp=t0)
        # Power loss
        t1 = t0 + dt.timedelta(seconds=100)
        ag.derive_alarms(tvc=5.0, power_available=False, timestamp=t1)
        # 300 seconds later, still no power
        t2 = t1 + dt.timedelta(seconds=300)
        result = ag.derive_alarms(tvc=5.0, power_available=False, timestamp=t2)
        assert result['HOLD'] == 300.0

    def test_hold_resets_when_power_restored(self):
        ag = AlarmGenerator(_make_rng(seed=1))
        t0 = SIM_START
        ag.derive_alarms(tvc=5.0, power_available=True, timestamp=t0)
        # Power loss
        t1 = t0 + dt.timedelta(seconds=100)
        ag.derive_alarms(tvc=5.0, power_available=False, timestamp=t1)
        # Power restored
        t2 = t1 + dt.timedelta(seconds=500)
        result = ag.derive_alarms(tvc=5.0, power_available=True, timestamp=t2)
        assert result['HOLD'] is None

    def test_hold_tracks_second_outage_independently(self):
        ag = AlarmGenerator(_make_rng(seed=1))
        t0 = SIM_START
        ag.derive_alarms(tvc=5.0, power_available=True, timestamp=t0)
        # First outage
        t1 = t0 + dt.timedelta(seconds=100)
        ag.derive_alarms(tvc=5.0, power_available=False, timestamp=t1)
        # Restore
        t2 = t1 + dt.timedelta(seconds=500)
        ag.derive_alarms(tvc=5.0, power_available=True, timestamp=t2)
        # Second outage
        t3 = t2 + dt.timedelta(seconds=200)
        ag.derive_alarms(tvc=5.0, power_available=False, timestamp=t3)
        # 60 seconds into second outage
        t4 = t3 + dt.timedelta(seconds=60)
        result = ag.derive_alarms(tvc=5.0, power_available=False, timestamp=t4)
        assert result['HOLD'] == 60.0


# ===================================================================
# 7. EventConfig door use presets
# ===================================================================

def _simulate_daily_door_stats(config, n_days=30, seed=42):
    """Run door generation for n_days and return (opens_per_day, secs_per_day, avg_dur)."""
    rng = _make_rng(seed)
    gen = DoorEventGenerator(config, rng)
    interval_s = 900.0
    intervals_per_day = int(86400 / interval_s)
    base = dt.datetime(2025, 1, 1, 0, 0, 0)

    total_opens = 0
    total_secs = 0.0
    for day in range(n_days):
        for i in range(intervals_per_day):
            ts = base + dt.timedelta(days=day, seconds=i * interval_s)
            events = gen.get_door_events(ts, interval_s)
            total_opens += len(events)
            total_secs += sum(e.duration_s for e in events)

    opens_pd = total_opens / n_days
    secs_pd = total_secs / n_days
    avg_dur = total_secs / total_opens if total_opens > 0 else 0
    return opens_pd, secs_pd, avg_dur


class TestEventConfigPresets:
    """EventConfig presets produce door statistics matching field data archetypes."""

    def test_bestpractice_opens_per_day(self):
        config = EventConfig.bestpractice()
        opens_pd, secs_pd, avg_dur = _simulate_daily_door_stats(config)
        # Expect ~2 opens/day (fleet median: 1.95)
        assert 1 <= opens_pd <= 5

    def test_bestpractice_secs_per_day(self):
        config = EventConfig.bestpractice()
        opens_pd, secs_pd, avg_dur = _simulate_daily_door_stats(config)
        # Expect ~40-60 secs/day (fleet median: 43)
        assert 20 <= secs_pd <= 120

    def test_normal_opens_per_day(self):
        config = EventConfig.normal()
        opens_pd, secs_pd, avg_dur = _simulate_daily_door_stats(config)
        # Expect 4-8 opens/day
        assert 3 <= opens_pd <= 12

    def test_normal_short_durations(self):
        config = EventConfig.normal()
        opens_pd, secs_pd, avg_dur = _simulate_daily_door_stats(config)
        assert avg_dur < 40

    def test_normal_more_opens_than_bestpractice(self):
        bp_opens, _, _ = _simulate_daily_door_stats(EventConfig.bestpractice())
        norm_opens, _, _ = _simulate_daily_door_stats(EventConfig.normal())
        assert norm_opens > bp_opens

    def test_few_but_long_opens_per_day(self):
        config = EventConfig.few_but_long()
        opens_pd, secs_pd, avg_dur = _simulate_daily_door_stats(config)
        # Expect ~3 opens/day (field ref: 2.2)
        assert 1 <= opens_pd <= 8

    def test_few_but_long_high_avg_duration(self):
        config = EventConfig.few_but_long()
        opens_pd, secs_pd, avg_dur = _simulate_daily_door_stats(config)
        # Avg duration should be high (>60s), matching field ref of 113s
        assert avg_dur > 60

    def test_few_but_long_high_secs_per_day(self):
        config = EventConfig.few_but_long()
        opens_pd, secs_pd, avg_dur = _simulate_daily_door_stats(config)
        # Secs/day should be elevated (field ref: 206)
        assert secs_pd > 80

    def test_frequent_short_opens_per_day(self):
        config = EventConfig.frequent_short()
        opens_pd, secs_pd, avg_dur = _simulate_daily_door_stats(config)
        # Expect ~10 opens/day (field ref: 3.9–16)
        assert 5 <= opens_pd <= 20

    def test_frequent_short_low_avg_duration(self):
        config = EventConfig.frequent_short()
        opens_pd, secs_pd, avg_dur = _simulate_daily_door_stats(config)
        # Avg duration should be short (<45s)
        assert avg_dur < 45

    def test_busy_facility_high_opens(self):
        config = EventConfig.busy_facility()
        opens_pd, secs_pd, avg_dur = _simulate_daily_door_stats(config)
        # Expect ~16+ opens/day (field ref: 15.9)
        assert opens_pd >= 12

    def test_busy_facility_extended_hours(self):
        config = EventConfig.busy_facility()
        assert config.working_hours == (6, 20)

    def test_busy_facility_more_opens_than_frequent_short(self):
        """Busy facility should produce more opens due to extended hours."""
        busy_opens, _, _ = _simulate_daily_door_stats(EventConfig.busy_facility())
        freq_opens, _, _ = _simulate_daily_door_stats(EventConfig.frequent_short())
        assert busy_opens > freq_opens

    def test_presets_compose_with_fault_config(self):
        """Presets work as drop-in EventConfig in a full SimulationConfig."""
        from utils.simulator.config import SimulationConfig, FaultConfig, FaultType
        config = SimulationConfig(
            events=EventConfig.few_but_long(),
            fault=FaultConfig(
                fault_type=FaultType.POWER_OUTAGE,
                fault_start_offset_s=3600,
                fault_duration_s=7200,
            ),
        )
        assert config.events.door_rate_per_hour == 0.3
        assert config.fault.fault_type == FaultType.POWER_OUTAGE
