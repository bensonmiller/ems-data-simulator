"""Unit tests for utils.simulator.thermal module."""

import math
import random
import datetime as dt

import pytest

from utils.simulator.config import ThermalConfig, AmbientConfig
from utils.simulator.thermal import (
    AmbientModel,
    DoorEvent,
    ThermalModel,
    ThermalState,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def default_thermal_config():
    return ThermalConfig()


@pytest.fixture
def thermal_model(default_thermal_config):
    return ThermalModel(default_thermal_config)


@pytest.fixture
def ambient_model():
    cfg = AmbientConfig(T_mean=28.0, T_amplitude=5.0, noise_sigma=0.0, peak_hour=14.0)
    return AmbientModel(cfg, rng=random.Random(42))


# ---------------------------------------------------------------------------
# 1. simulate_interval produces correct output fields
# ---------------------------------------------------------------------------

class TestSimulateIntervalOutputFields:
    """simulate_interval returns a record dict with TVC, CMPR, DORV, TAMB."""

    def test_record_contains_required_keys(self, thermal_model):
        state = ThermalState(tvc=5.0, compressor_on=False)
        _, record = thermal_model.simulate_interval(
            state, tamb=25.0, interval_s=900, compressor_available=True,
        )
        assert {"TVC", "TAMB", "CMPR", "DORV"}.issubset(set(record.keys()))

    def test_tamb_matches_input(self, thermal_model):
        state = ThermalState(tvc=5.0, compressor_on=False)
        _, record = thermal_model.simulate_interval(
            state, tamb=30.5, interval_s=900, compressor_available=True,
        )
        assert record["TAMB"] == 30.5

    def test_tvc_is_rounded_float(self, thermal_model):
        state = ThermalState(tvc=5.0, compressor_on=False)
        _, record = thermal_model.simulate_interval(
            state, tamb=25.0, interval_s=900, compressor_available=True,
        )
        # TVC should be rounded to 1 decimal place
        assert record["TVC"] == round(record["TVC"], 1)

    def test_cmpr_and_dorv_are_ints(self, thermal_model):
        state = ThermalState(tvc=5.0, compressor_on=False)
        _, record = thermal_model.simulate_interval(
            state, tamb=25.0, interval_s=900, compressor_available=True,
        )
        assert isinstance(record["CMPR"], int)
        assert isinstance(record["DORV"], int)


# ---------------------------------------------------------------------------
# 2. Thermostat hysteresis
# ---------------------------------------------------------------------------

class TestThermostatHysteresis:
    """Compressor turns ON at T_setpoint_high (8) and OFF at T_setpoint_low (2)."""

    def test_compressor_turns_on_at_high_setpoint(self, thermal_model):
        """Starting at 8 C with compressor off, thermostat should engage."""
        state = ThermalState(tvc=8.0, compressor_on=False)
        new_state, record = thermal_model.simulate_interval(
            state, tamb=25.0, interval_s=900, compressor_available=True,
        )
        # Compressor must have run (CMPR > 0) since TVC >= T_setpoint_high
        assert record["CMPR"] > 0

    def test_compressor_turns_off_at_low_setpoint(self):
        """Starting at 2 C with compressor on, thermostat should disengage."""
        cfg = ThermalConfig()
        model = ThermalModel(cfg)
        state = ThermalState(tvc=2.0, compressor_on=True)
        new_state, _ = model.simulate_interval(
            state, tamb=25.0, interval_s=10, compressor_available=True,
        )
        # After one step at tvc=2.0 (== T_setpoint_low), compressor turns off
        assert new_state.compressor_on is False

    def test_compressor_stays_on_in_hysteresis_band(self):
        """If compressor is already on and TVC is between low and high, it stays on."""
        cfg = ThermalConfig()
        model = ThermalModel(cfg)
        state = ThermalState(tvc=5.0, compressor_on=True)
        new_state, record = model.simulate_interval(
            state, tamb=5.0, interval_s=10, compressor_available=True,
        )
        # TVC=5 is between 2 and 8; compressor was on and should remain on
        assert record["CMPR"] > 0

    def test_compressor_stays_off_in_hysteresis_band(self, thermal_model):
        """If compressor is off and TVC is between low and high, it stays off."""
        state = ThermalState(tvc=5.0, compressor_on=False)
        new_state, record = thermal_model.simulate_interval(
            state, tamb=5.0, interval_s=900, compressor_available=True,
        )
        # TVC=5 with TAMB=5: minimal drift, compressor should not kick in
        assert record["CMPR"] == 0

    def test_compressor_unavailable_forces_off(self, thermal_model):
        """Compressor must stay off when compressor_available=False."""
        state = ThermalState(tvc=8.0, compressor_on=True)
        new_state, record = thermal_model.simulate_interval(
            state, tamb=25.0, interval_s=900, compressor_available=False,
        )
        assert record["CMPR"] == 0
        assert new_state.compressor_on is False


# ---------------------------------------------------------------------------
# 3. Door events increase TVC
# ---------------------------------------------------------------------------

class TestDoorEvents:
    """Opening the door adds heat and increases TVC."""

    def test_door_event_raises_tvc(self, thermal_model):
        """A door event should result in a higher TVC than without one."""
        state_no_door = ThermalState(tvc=5.0, compressor_on=False)
        state_door = ThermalState(tvc=5.0, compressor_on=False)

        _, rec_no_door = thermal_model.simulate_interval(
            state_no_door, tamb=25.0, interval_s=900, compressor_available=False,
        )
        door = [DoorEvent(start_offset_s=0, duration_s=300)]
        _, rec_door = thermal_model.simulate_interval(
            state_door, tamb=25.0, interval_s=900,
            compressor_available=False, door_events=door,
        )
        assert rec_door["TVC"] > rec_no_door["TVC"]

    def test_dorv_accumulates_door_seconds(self, thermal_model):
        """DORV should reflect the total door-open time in seconds."""
        state = ThermalState(tvc=5.0, compressor_on=False)
        door = [DoorEvent(start_offset_s=100, duration_s=200)]
        _, record = thermal_model.simulate_interval(
            state, tamb=25.0, interval_s=900,
            compressor_available=True, door_events=door,
        )
        # 200 seconds of door open time
        assert record["DORV"] == 200

    def test_multiple_door_events(self, thermal_model):
        """Multiple door events should be tracked correctly."""
        state = ThermalState(tvc=5.0, compressor_on=False)
        doors = [
            DoorEvent(start_offset_s=0, duration_s=100),
            DoorEvent(start_offset_s=200, duration_s=100),
        ]
        _, record = thermal_model.simulate_interval(
            state, tamb=25.0, interval_s=900,
            compressor_available=True, door_events=doors,
        )
        assert record["DORV"] == 200


# ---------------------------------------------------------------------------
# 4. Compressor cools TVC down
# ---------------------------------------------------------------------------

class TestCompressorCooling:
    """Compressor should reduce TVC over time."""

    def test_compressor_cools_tvc(self):
        """With compressor on, TVC should decrease when TAMB is moderate."""
        cfg = ThermalConfig()
        model = ThermalModel(cfg)
        state = ThermalState(tvc=8.0, compressor_on=True)
        new_state, record = model.simulate_interval(
            state, tamb=25.0, interval_s=900, compressor_available=True,
        )
        # Despite warm ambient, compressor cooling power should win
        assert record["TVC"] < 8.0

    def test_without_compressor_tvc_drifts_up(self, thermal_model):
        """Without compressor and warm ambient, TVC should rise."""
        state = ThermalState(tvc=5.0, compressor_on=False)
        _, record = thermal_model.simulate_interval(
            state, tamb=35.0, interval_s=900, compressor_available=False,
        )
        assert record["TVC"] > 5.0

    def test_q_compressor_override_reduces_cooling(self):
        """Overriding Q_compressor to a lower value should reduce cooling effect."""
        cfg = ThermalConfig()
        model = ThermalModel(cfg)
        state_full = ThermalState(tvc=8.0, compressor_on=True)
        state_weak = ThermalState(tvc=8.0, compressor_on=True)

        _, rec_full = model.simulate_interval(
            state_full, tamb=25.0, interval_s=900, compressor_available=True,
        )
        _, rec_weak = model.simulate_interval(
            state_weak, tamb=25.0, interval_s=900, compressor_available=True,
            q_compressor_override=50.0,
        )
        # Full-power compressor should cool more (lower TVC) than weakened one
        assert rec_full["TVC"] < rec_weak["TVC"]


# ---------------------------------------------------------------------------
# 5. AmbientModel produces reasonable TAMB with daily sinusoidal cycle
# ---------------------------------------------------------------------------

class TestAmbientModel:
    """AmbientModel should follow a sinusoidal daily pattern."""

    def test_peak_at_peak_hour(self, ambient_model):
        """TAMB should be at its maximum near the configured peak hour."""
        ts_peak = dt.datetime(2025, 6, 15, 14, 0, 0)  # peak_hour=14
        tamb_peak = ambient_model.get_tamb(ts_peak)
        # At peak: T_mean + T_amplitude = 28 + 5 = 33
        assert tamb_peak == pytest.approx(33.0, abs=0.1)

    def test_trough_12h_from_peak(self, ambient_model):
        """TAMB should be at its minimum 12 hours from peak hour."""
        ts_trough = dt.datetime(2025, 6, 15, 2, 0, 0)  # 12h from peak_hour=14
        tamb_trough = ambient_model.get_tamb(ts_trough)
        # At trough: T_mean - T_amplitude = 28 - 5 = 23
        assert tamb_trough == pytest.approx(23.0, abs=0.1)

    def test_mid_day_between_peak_and_trough(self, ambient_model):
        """At 6 hours from peak, TAMB should be near the mean."""
        ts_mid = dt.datetime(2025, 6, 15, 8, 0, 0)  # 6h from peak_hour=14
        tamb_mid = ambient_model.get_tamb(ts_mid)
        # cos(pi/2) = 0 → should be ~T_mean
        assert tamb_mid == pytest.approx(28.0, abs=0.1)

    def test_noise_adds_variability(self):
        """With noise enabled, repeated calls should give different values."""
        cfg = AmbientConfig(T_mean=28.0, T_amplitude=5.0, noise_sigma=2.0, peak_hour=14.0)
        model = AmbientModel(cfg, rng=random.Random(99))
        ts = dt.datetime(2025, 6, 15, 12, 0, 0)
        values = [model.get_tamb(ts) for _ in range(50)]
        # With sigma=2, we expect some spread
        assert max(values) - min(values) > 1.0

    def test_zero_noise_is_deterministic(self, ambient_model):
        """With noise_sigma=0, get_tamb should return the same value every time."""
        ts = dt.datetime(2025, 6, 15, 10, 0, 0)
        vals = {ambient_model.get_tamb(ts) for _ in range(10)}
        assert len(vals) == 1


# ---------------------------------------------------------------------------
# 6. Sub-step Euler integration works correctly
# ---------------------------------------------------------------------------

class TestEulerIntegration:
    """Verify the Euler integration mechanics."""

    def test_number_of_substeps(self):
        """900s interval / 10s substep = 90 integration steps."""
        cfg = ThermalConfig(sub_step_seconds=10.0)
        model = ThermalModel(cfg)
        # With TAMB == TVC and no compressor, TVC should not change
        state = ThermalState(tvc=5.0, compressor_on=False)
        new_state, record = model.simulate_interval(
            state, tamb=5.0, interval_s=900, compressor_available=False,
        )
        # No driving force → TVC stays the same
        assert record["TVC"] == pytest.approx(5.0, abs=0.01)

    def test_single_step_matches_manual_calc(self):
        """One Euler step should match the analytical formula."""
        cfg = ThermalConfig(
            R=0.12, C=15000.0, Q_compressor=300.0, R_door=0.15,
            T_setpoint_low=2.0, T_setpoint_high=8.0,
            sub_step_seconds=10.0,
        )
        model = ThermalModel(cfg)
        tamb = 25.0
        tvc_init = 5.0
        rc = cfg.R * cfg.C  # 1800

        # One step (10s), compressor off, no door
        # dT = (25 - 5) / 1800 = 0.01111 °C/s
        # tvc_new = 5.0 + 0.01111 * 10 = 5.1111
        state = ThermalState(tvc=tvc_init, compressor_on=False)
        new_state, _ = model.simulate_interval(
            state, tamb=tamb, interval_s=10, compressor_available=False,
        )
        expected = tvc_init + (tamb - tvc_init) / rc * 10.0
        assert new_state.tvc == pytest.approx(expected, rel=1e-9)

    def test_single_step_with_compressor(self):
        """One step with compressor on: ambient heat gain minus cooling."""
        cfg = ThermalConfig(sub_step_seconds=10.0)
        model = ThermalModel(cfg)
        tamb = 25.0
        tvc_init = 8.0  # triggers compressor on
        rc = cfg.R * cfg.C

        state = ThermalState(tvc=tvc_init, compressor_on=True)
        new_state, record = model.simulate_interval(
            state, tamb=tamb, interval_s=10, compressor_available=True,
        )
        dT = (tamb - tvc_init) / rc - cfg.Q_compressor / cfg.C
        expected = tvc_init + dT * 10.0
        assert new_state.tvc == pytest.approx(expected, rel=1e-9)
        assert record["CMPR"] == 10

    def test_single_step_with_door(self):
        """One step with door open: ambient heat gain plus door heat leak."""
        cfg = ThermalConfig(sub_step_seconds=10.0)
        model = ThermalModel(cfg)
        tamb = 25.0
        tvc_init = 5.0
        rc = cfg.R * cfg.C

        state = ThermalState(tvc=tvc_init, compressor_on=False)
        door = [DoorEvent(start_offset_s=0, duration_s=10)]
        new_state, record = model.simulate_interval(
            state, tamb=tamb, interval_s=10, compressor_available=False,
            door_events=door,
        )
        dT = (tamb - tvc_init) / rc + (tamb - tvc_init) / (cfg.R_door * cfg.C)
        expected = tvc_init + dT * 10.0
        assert new_state.tvc == pytest.approx(expected, rel=1e-9)
        assert record["DORV"] == 10

    def test_finer_substep_gives_different_result(self):
        """Changing sub_step_seconds should change the integration result
        (demonstrating Euler method sensitivity to step size)."""
        tamb = 35.0
        tvc_init = 5.0

        cfg_coarse = ThermalConfig(sub_step_seconds=100.0)
        cfg_fine = ThermalConfig(sub_step_seconds=1.0)

        model_coarse = ThermalModel(cfg_coarse)
        model_fine = ThermalModel(cfg_fine)

        state_c = ThermalState(tvc=tvc_init, compressor_on=False)
        state_f = ThermalState(tvc=tvc_init, compressor_on=False)

        _, rec_c = model_coarse.simulate_interval(
            state_c, tamb=tamb, interval_s=900, compressor_available=False,
        )
        _, rec_f = model_fine.simulate_interval(
            state_f, tamb=tamb, interval_s=900, compressor_available=False,
        )
        # Both should move towards ambient, but exact values differ
        assert rec_c["TVC"] != rec_f["TVC"]
        # Both should be warmer than start
        assert rec_c["TVC"] > tvc_init
        assert rec_f["TVC"] > tvc_init

    def test_state_carries_between_intervals(self, thermal_model):
        """Running two intervals sequentially should be equivalent to state chaining."""
        state = ThermalState(tvc=5.0, compressor_on=False)
        state_1, _ = thermal_model.simulate_interval(
            state, tamb=25.0, interval_s=450, compressor_available=False,
        )
        state_2, rec_2 = thermal_model.simulate_interval(
            state_1, tamb=25.0, interval_s=450, compressor_available=False,
        )

        # Compare with single 900s interval
        state_single = ThermalState(tvc=5.0, compressor_on=False)
        _, rec_single = thermal_model.simulate_interval(
            state_single, tamb=25.0, interval_s=900, compressor_available=False,
        )

        # Compare raw tvc values (not the rounded record value)
        state_single_direct = ThermalState(tvc=5.0, compressor_on=False)
        final_single, _ = thermal_model.simulate_interval(
            state_single_direct, tamb=25.0, interval_s=900, compressor_available=False,
        )
        assert state_2.tvc == pytest.approx(final_single.tvc, rel=1e-9)
