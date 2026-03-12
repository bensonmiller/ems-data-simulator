"""Unit tests for utils.simulator.power module."""

import datetime as dt
import math
import random

import pytest

from utils.simulator.config import PowerConfig
from utils.simulator.power import MainsPowerModel, SolarPowerModel, PowerState


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mains_config(**overrides) -> PowerConfig:
    defaults = dict(power_type="mains", nominal_voltage=600, outage_probability_per_hour=0.0)
    defaults.update(overrides)
    return PowerConfig(**defaults)


def _solar_config(**overrides) -> PowerConfig:
    defaults = dict(
        power_type="solar",
        peak_dcsv=48.0,
        sunrise_hour=6.0,
        sunset_hour=18.0,
        battery_capacity_wh=2400.0,
        min_operating_voltage=10.0,
        charge_efficiency=0.85,
    )
    defaults.update(overrides)
    return PowerConfig(**defaults)


NOON = dt.datetime(2025, 6, 15, 12, 0, 0)
MIDNIGHT = dt.datetime(2025, 6, 15, 0, 0, 0)
INTERVAL = 900.0  # 15 minutes


# ===========================================================================
# MainsPowerModel tests
# ===========================================================================

class TestMainsPowerModelSimulateInterval:
    """MainsPowerModel.simulate_interval() returns expected fields."""

    def test_returns_sva_accd_acsv_keys(self):
        model = MainsPowerModel(_mains_config(), random.Random(42))
        state = PowerState()
        state, readings = model.simulate_interval(state, NOON, INTERVAL, 0.0)
        assert set(readings.keys()) == {"SVA", "ACCD", "ACSV"}

    def test_sva_equals_nominal_voltage_when_no_outage(self):
        cfg = _mains_config(nominal_voltage=600)
        model = MainsPowerModel(cfg, random.Random(42))
        state = PowerState()
        state, readings = model.simulate_interval(state, NOON, INTERVAL, 0.0)
        assert readings["SVA"] == 600

    def test_accd_equals_interval_when_no_outage(self):
        model = MainsPowerModel(_mains_config(), random.Random(42))
        state = PowerState()
        state, readings = model.simulate_interval(state, NOON, INTERVAL, 0.0)
        assert readings["ACCD"] == INTERVAL

    def test_acsv_near_nominal_voltage(self):
        cfg = _mains_config(nominal_voltage=600)
        model = MainsPowerModel(cfg, random.Random(42))
        state = PowerState()
        state, readings = model.simulate_interval(state, NOON, INTERVAL, 0.0)
        # Gaussian noise with sigma = 0.02 * 600 = 12, so within ~50V is safe
        assert abs(readings["ACSV"] - 600) < 50


class TestMainsPowerModelOutage:
    """Outage behavior: SVA=0, ACCD=0 when in_outage is True."""

    def test_readings_zero_during_outage(self):
        model = MainsPowerModel(_mains_config(), random.Random(42))
        state = PowerState(in_outage=True, outage_end=NOON + dt.timedelta(hours=5))
        state, readings = model.simulate_interval(state, NOON, INTERVAL, 0.0)
        assert readings["SVA"] == 0
        assert readings["ACCD"] == 0.0
        assert readings["ACSV"] == 0.0

    def test_cumulative_powered_does_not_increase_during_outage(self):
        model = MainsPowerModel(_mains_config(), random.Random(42))
        state = PowerState(
            cumulative_powered_s=100.0,
            in_outage=True,
            outage_end=NOON + dt.timedelta(hours=5),
        )
        state, _ = model.simulate_interval(state, NOON, INTERVAL, 0.0)
        assert state.cumulative_powered_s == 100.0

    def test_outage_ends_when_timestamp_passes_outage_end(self):
        model = MainsPowerModel(_mains_config(), random.Random(42))
        outage_end = NOON - dt.timedelta(minutes=1)
        state = PowerState(in_outage=True, outage_end=outage_end)
        state, readings = model.simulate_interval(state, NOON, INTERVAL, 0.0)
        # Outage should have ended; power should be available
        assert state.in_outage is False
        assert readings["SVA"] == model.config.nominal_voltage

    def test_outage_can_start_stochastically(self):
        # With outage_probability_per_hour = 1.0, an outage is virtually certain
        cfg = _mains_config(outage_probability_per_hour=1.0, mean_outage_duration_hours=1.0)
        model = MainsPowerModel(cfg, random.Random(42))
        state = PowerState()
        state, readings = model.simulate_interval(state, NOON, INTERVAL, 0.0)
        assert state.in_outage is True
        assert readings["SVA"] == 0

    def test_no_outage_when_probability_zero(self):
        cfg = _mains_config(outage_probability_per_hour=0.0)
        model = MainsPowerModel(cfg, random.Random(42))
        state = PowerState()
        # Run many intervals — should never trigger an outage
        for i in range(100):
            ts = NOON + dt.timedelta(seconds=INTERVAL * i)
            state, readings = model.simulate_interval(state, ts, INTERVAL, 0.0)
            assert state.in_outage is False


class TestMainsPowerModelIsPowerAvailable:
    """is_power_available() reflects outage state."""

    def test_available_when_not_in_outage(self):
        model = MainsPowerModel(_mains_config(), random.Random(42))
        assert model.is_power_available(PowerState(in_outage=False)) is True

    def test_not_available_during_outage(self):
        model = MainsPowerModel(_mains_config(), random.Random(42))
        assert model.is_power_available(PowerState(in_outage=True)) is False


# ===========================================================================
# SolarPowerModel tests
# ===========================================================================

class TestSolarVoltage:
    """SolarPowerModel._solar_voltage() bell curve tests."""

    def test_zero_at_midnight(self):
        model = SolarPowerModel(_solar_config(), random.Random(42))
        assert model._solar_voltage(MIDNIGHT) == 0.0

    def test_zero_before_sunrise(self):
        model = SolarPowerModel(_solar_config(sunrise_hour=6.0), random.Random(42))
        ts = dt.datetime(2025, 6, 15, 5, 0, 0)
        assert model._solar_voltage(ts) == 0.0

    def test_zero_after_sunset(self):
        model = SolarPowerModel(_solar_config(sunset_hour=18.0), random.Random(42))
        ts = dt.datetime(2025, 6, 15, 19, 0, 0)
        assert model._solar_voltage(ts) == 0.0

    def test_peak_near_noon(self):
        # Use a fixed seed so noise is deterministic; peak_dcsv=48
        model = SolarPowerModel(_solar_config(), random.Random(42))
        v = model._solar_voltage(NOON)
        # At solar noon cos(0) = 1, so voltage should be near peak_dcsv
        assert v > 40.0  # comfortably above zero, close to 48

    def test_voltage_symmetric_around_noon(self):
        """Voltages equidistant from noon should be approximately equal (modulo noise)."""
        rng = random.Random(42)
        model = SolarPowerModel(_solar_config(), rng)
        morning = dt.datetime(2025, 6, 15, 9, 0, 0)
        afternoon = dt.datetime(2025, 6, 15, 15, 0, 0)
        # Run many samples to average out noise
        sum_morning = sum(
            SolarPowerModel(_solar_config(), random.Random(i))._solar_voltage(morning)
            for i in range(100)
        )
        sum_afternoon = sum(
            SolarPowerModel(_solar_config(), random.Random(i + 1000))._solar_voltage(afternoon)
            for i in range(100)
        )
        avg_morning = sum_morning / 100
        avg_afternoon = sum_afternoon / 100
        assert abs(avg_morning - avg_afternoon) < 2.0  # should be very close

    def test_voltage_never_negative(self):
        model = SolarPowerModel(_solar_config(), random.Random(42))
        for hour in range(24):
            ts = dt.datetime(2025, 6, 15, hour, 0, 0)
            assert model._solar_voltage(ts) >= 0.0


class TestSolarBatterySOC:
    """SolarPowerModel battery SOC tracking."""

    def test_soc_clamped_to_zero(self):
        cfg = _solar_config()
        model = SolarPowerModel(cfg, random.Random(42))
        state = PowerState(battery_soc=0.01)
        # Night time, heavy compressor use should drain battery toward 0
        ts = MIDNIGHT
        for _ in range(200):
            state, _ = model.simulate_interval(state, ts, INTERVAL, INTERVAL)
            ts += dt.timedelta(seconds=INTERVAL)
        assert state.battery_soc >= 0.0

    def test_soc_clamped_to_one(self):
        cfg = _solar_config()
        model = SolarPowerModel(cfg, random.Random(42))
        state = PowerState(battery_soc=0.99)
        # Noon, no compressor use — lots of charging
        for _ in range(200):
            state, _ = model.simulate_interval(state, NOON, INTERVAL, 0.0)
        assert state.battery_soc <= 1.0

    def test_soc_decreases_at_night_with_compressor(self):
        cfg = _solar_config()
        model = SolarPowerModel(cfg, random.Random(42))
        state = PowerState(battery_soc=0.8)
        initial_soc = state.battery_soc
        ts = MIDNIGHT
        for _ in range(5):
            state, _ = model.simulate_interval(state, ts, INTERVAL, INTERVAL)
            ts += dt.timedelta(seconds=INTERVAL)
        assert state.battery_soc < initial_soc

    def test_readings_contain_expected_keys(self):
        model = SolarPowerModel(_solar_config(), random.Random(42))
        state = PowerState()
        state, readings = model.simulate_interval(state, NOON, INTERVAL, 0.0)
        assert set(readings.keys()) == {"DCSV", "DCCD", "BLOG", "BEMD"}

    def test_blog_range(self):
        """BLOG should be between 10.5 (empty) and 14.4 (full)."""
        model = SolarPowerModel(_solar_config(), random.Random(42))
        for soc in [0.0, 0.5, 1.0]:
            state = PowerState(battery_soc=soc)
            state, readings = model.simulate_interval(state, NOON, INTERVAL, 0.0)
            assert 10.0 <= readings["BLOG"] <= 15.0
            assert readings["BEMD"] == readings["BLOG"]


# ===========================================================================
# PowerState tests
# ===========================================================================

class TestPowerStateCumulativePowered:
    """cumulative_powered_s accumulates correctly."""

    def test_accumulates_over_multiple_intervals_mains(self):
        model = MainsPowerModel(_mains_config(), random.Random(42))
        state = PowerState(cumulative_powered_s=0.0)
        n = 5
        for i in range(n):
            ts = NOON + dt.timedelta(seconds=INTERVAL * i)
            state, _ = model.simulate_interval(state, ts, INTERVAL, 0.0)
        assert state.cumulative_powered_s == pytest.approx(INTERVAL * n)

    def test_accumulates_over_multiple_intervals_solar(self):
        model = SolarPowerModel(_solar_config(), random.Random(42))
        state = PowerState(cumulative_powered_s=0.0, battery_soc=0.8)
        n = 3
        for i in range(n):
            ts = NOON + dt.timedelta(seconds=INTERVAL * i)
            state, _ = model.simulate_interval(state, ts, INTERVAL, 0.0)
        # Solar available or battery > 0 → should accumulate
        assert state.cumulative_powered_s == pytest.approx(INTERVAL * n)

    def test_no_accumulation_solar_no_power_no_battery(self):
        model = SolarPowerModel(_solar_config(), random.Random(42))
        state = PowerState(cumulative_powered_s=0.0, battery_soc=0.0)
        # Night, no battery — should not accumulate
        state, readings = model.simulate_interval(state, MIDNIGHT, INTERVAL, 0.0)
        assert readings["DCCD"] == 0.0
        assert state.cumulative_powered_s == 0.0


# ===========================================================================
# SolarPowerModel.is_power_available tests
# ===========================================================================

class TestSolarIsPowerAvailable:
    """is_power_available() depends only on solar voltage (compressor is solar direct drive)."""

    def test_available_at_noon(self):
        model = SolarPowerModel(_solar_config(), random.Random(42))
        state = PowerState(battery_soc=0.5)
        assert model.is_power_available(state, NOON) is True

    def test_not_available_at_night_even_with_logger_battery(self):
        """Compressor power requires solar — logger battery is too small."""
        model = SolarPowerModel(_solar_config(), random.Random(42))
        state = PowerState(battery_soc=0.5)
        assert model.is_power_available(state, MIDNIGHT) is False

    def test_not_available_at_night_no_battery(self):
        model = SolarPowerModel(_solar_config(), random.Random(42))
        state = PowerState(battery_soc=0.0)
        assert model.is_power_available(state, MIDNIGHT) is False
