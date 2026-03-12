"""Integration tests for SimulatedRecordSet."""

import datetime as dt

import pytest

from utils.simulator.config import default_config, SimulationConfig, PowerConfig
from utils.simulator.recordset import SimulatedRecordSet, SimulatorState
from utils.schemas import RtmdRecord, EmsRecordMains, EmsRecordSolar


FIXED_START = dt.datetime(2025, 6, 1, 12, 0, 0)
SEED = 42


# -- helpers ------------------------------------------------------------------

def _mains_config() -> SimulationConfig:
    cfg = default_config(power_type="mains")
    cfg.random_seed = SEED
    return cfg


def _solar_config() -> SimulationConfig:
    cfg = default_config(power_type="solar")
    cfg.random_seed = SEED
    return cfg


# -- 1. generate() with default mains config produces correct record count ----

class TestGenerateMainsCount:
    @pytest.mark.parametrize("batch_size", [1, 5, 20])
    def test_record_count(self, batch_size):
        cfg = _mains_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=batch_size, start_time=FIXED_START)
        assert len(rs.records) == batch_size

    def test_records_have_expected_keys(self):
        cfg = _mains_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=3, start_time=FIXED_START)
        required_keys = {"ABST", "TVC", "TAMB", "CMPR", "ALRM", "EERR"}
        for rec in rs.records:
            assert required_keys.issubset(rec.keys()), f"Missing keys: {required_keys - rec.keys()}"

    def test_timestamps_are_sequential(self):
        cfg = _mains_config()
        interval = 900
        rs = SimulatedRecordSet.generate(cfg, batch_size=5, start_time=FIXED_START, interval=interval)
        for i, rec in enumerate(rs.records):
            expected = FIXED_START + dt.timedelta(seconds=i * interval)
            assert rec["ABST"] == expected


# -- 2. generate() with solar config produces correct records -----------------

class TestGenerateSolar:
    def test_solar_record_count(self):
        cfg = _solar_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=4, start_time=FIXED_START)
        assert len(rs.records) == 4

    def test_solar_records_contain_dc_fields(self):
        cfg = _solar_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=3, start_time=FIXED_START)
        for rec in rs.records:
            assert "DCSV" in rec
            assert "DCCD" in rec

    def test_solar_records_lack_mains_fields(self):
        cfg = _solar_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=3, start_time=FIXED_START)
        for rec in rs.records:
            assert "SVA" not in rec
            assert "ACCD" not in rec
            assert "ACSV" not in rec


# -- 3. to_rtmd() returns RtmdRecord objects with correct fields --------------

class TestToRtmd:
    def test_returns_rtmd_records(self):
        cfg = _mains_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=5, start_time=FIXED_START)
        rtmd_list = rs.to_rtmd()
        assert len(rtmd_list) == 5
        for item in rtmd_list:
            assert isinstance(item, RtmdRecord)

    def test_rtmd_fields_present(self):
        cfg = _mains_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=2, start_time=FIXED_START)
        rtmd_list = rs.to_rtmd()
        for item in rtmd_list:
            assert item.ABST is not None
            assert isinstance(item.BEMD, float)
            assert isinstance(item.TVC, float)
            assert isinstance(item.TAMB, float)
            # ALRM and EERR are optional strings — just verify attribute exists
            assert hasattr(item, "ALRM")
            assert hasattr(item, "EERR")


# -- 4. to_ems() for mains returns EmsRecordMains with ACCD, ACSV, SVA -------

class TestToEmsMains:
    def test_returns_ems_mains_records(self):
        cfg = _mains_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=4, start_time=FIXED_START)
        ems_list = rs.to_ems()
        assert len(ems_list) == 4
        for item in ems_list:
            assert isinstance(item, EmsRecordMains)

    def test_mains_specific_fields(self):
        cfg = _mains_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=3, start_time=FIXED_START)
        ems_list = rs.to_ems()
        for item in ems_list:
            assert isinstance(item.ACCD, float)
            assert isinstance(item.ACSV, float)
            assert isinstance(item.SVA, int)


# -- 5. to_ems() for solar returns EmsRecordSolar with DCCD, DCSV ------------

class TestToEmsSolar:
    def test_returns_ems_solar_records(self):
        cfg = _solar_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=4, start_time=FIXED_START)
        ems_list = rs.to_ems()
        assert len(ems_list) == 4
        for item in ems_list:
            assert isinstance(item, EmsRecordSolar)

    def test_solar_specific_fields(self):
        cfg = _solar_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=3, start_time=FIXED_START)
        ems_list = rs.to_ems()
        for item in ems_list:
            assert isinstance(item.DCCD, float)
            assert isinstance(item.DCSV, float)


# -- 6. State continuity: generate() with previous state ---------------------

class TestStateContinuity:
    def test_state_preserves_tvc(self):
        cfg = _mains_config()
        rs1 = SimulatedRecordSet.generate(cfg, batch_size=10, start_time=FIXED_START)
        last_tvc_batch1 = rs1.state.tvc

        next_start = FIXED_START + dt.timedelta(seconds=10 * 900)
        rs2 = SimulatedRecordSet.generate(cfg, batch_size=5, start_time=next_start, state=rs1.state)
        first_tvc_batch2 = rs2.records[0]["TVC"]

        # The first TVC in batch 2 should be close to the last state TVC from batch 1
        # (they won't be exactly equal because simulate_interval evolves the temperature,
        # but there should be no discontinuous jump)
        assert abs(first_tvc_batch2 - last_tvc_batch1) < 5.0

    def test_state_carries_rng(self):
        """Two calls with the same seed but via state should not produce identical batches."""
        cfg = _mains_config()
        rs1 = SimulatedRecordSet.generate(cfg, batch_size=5, start_time=FIXED_START)

        next_start = FIXED_START + dt.timedelta(seconds=5 * 900)
        rs2 = SimulatedRecordSet.generate(cfg, batch_size=5, start_time=next_start, state=rs1.state)

        # The two batches should differ (different ambient noise, door events, etc.)
        tvcs1 = [r["TVC"] for r in rs1.records]
        tvcs2 = [r["TVC"] for r in rs2.records]
        assert tvcs1 != tvcs2

    def test_cumulative_powered_seconds_increases(self):
        cfg = _mains_config()
        rs1 = SimulatedRecordSet.generate(cfg, batch_size=10, start_time=FIXED_START)
        next_start = FIXED_START + dt.timedelta(seconds=10 * 900)
        rs2 = SimulatedRecordSet.generate(cfg, batch_size=10, start_time=next_start, state=rs1.state)
        assert rs2.state.cumulative_powered_s >= rs1.state.cumulative_powered_s


# -- 7. EERR -> LERR field mapping in to_ems() --------------------------------

class TestEerrToLerrMapping:
    def test_eerr_mapped_to_lerr_in_ems(self):
        """EERR from raw records should appear as LERR in EMS output."""
        cfg = _mains_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=5, start_time=FIXED_START)

        # Manually inject an EERR value to guarantee the mapping is testable
        rs.records[0]["EERR"] = "E001"

        ems_list = rs.to_ems()
        assert ems_list[0].LERR == "E001"

    def test_eerr_not_present_in_ems_output(self):
        """After mapping, the EERR key should not be set on the EMS record via the filtered dict."""
        cfg = _mains_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=2, start_time=FIXED_START)
        rs.records[0]["EERR"] = "E002"
        ems_list = rs.to_ems()
        # The EMS base schema has EERR as an optional field with default None,
        # so after our pop it should remain None (not "E002").
        assert ems_list[0].EERR is None

    def test_lerr_none_when_eerr_absent(self):
        cfg = _mains_config()
        rs = SimulatedRecordSet.generate(cfg, batch_size=2, start_time=FIXED_START)
        # Ensure EERR is None
        rs.records[0]["EERR"] = None
        ems_list = rs.to_ems()
        # When EERR is None it should still be popped and set as LERR
        assert ems_list[0].LERR is None
