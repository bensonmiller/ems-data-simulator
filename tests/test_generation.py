import pytest
import datetime as dt
from utils.device import MonitoringDeviceConfig, BaseRtmDevice
from utils.schemas import RtmdReport, EmsReport


@pytest.fixture
def report_time():
    return dt.datetime(2024, 6, 15, 12, 0, 0)


@pytest.fixture
def rtmd_device():
    config = MonitoringDeviceConfig(
        type='rtmd',
        upload_interval=3600,
        sample_interval=900,
    )
    return BaseRtmDevice(config)


@pytest.fixture
def ems_device():
    config = MonitoringDeviceConfig(
        type='ems',
        upload_interval=3600,
        sample_interval=900,
    )
    return BaseRtmDevice(config)


def test_rtmd_initialization(rtmd_device):
    """Test if RTMD device initializes correctly."""
    assert rtmd_device.config.type == 'rtmd'
    assert rtmd_device.config.upload_interval == 3600
    assert rtmd_device.config.sample_interval == 900
    assert rtmd_device.simulator_state is None
    assert rtmd_device.cid is not None
    assert rtmd_device.lmfr != rtmd_device.amfr or rtmd_device.lmod != rtmd_device.amod


def test_ems_initialization(ems_device):
    """Test if EMS device initializes correctly."""
    assert ems_device.config.type == 'ems'
    assert ems_device.lmfr == ems_device.amfr
    assert ems_device.lmod == ems_device.amod


def test_create_rtmd_report(rtmd_device, report_time):
    """Test if an RTMD report is generated correctly."""
    report = rtmd_device.create_report(report_time=report_time)
    assert isinstance(report, RtmdReport)
    assert report.CID == rtmd_device.cid
    assert len(report.records) == 4  # 3600/900 = 4 records


def test_create_ems_report(ems_device, report_time):
    """Test if an EMS report is generated correctly."""
    report = ems_device.create_report(report_time=report_time)
    assert isinstance(report, EmsReport)
    assert report.CID == ems_device.cid
    assert len(report.records) == 4


def test_multiple_reports(rtmd_device, report_time):
    """Test multiple sequential reports with state continuity."""
    reports = []
    t = report_time
    for _ in range(5):
        report = rtmd_device.create_report(report_time=t)
        reports.append(report)
        t += dt.timedelta(seconds=3600)

    for r in reports:
        assert isinstance(r, RtmdReport)
        assert len(r.records) == 4

    # State should be initialized after first report
    assert rtmd_device.simulator_state is not None


def test_report_timestamps(ems_device, report_time):
    """Test that record timestamps are correctly spaced."""
    report = ems_device.create_report(report_time=report_time)
    timestamps = [r.ABST for r in report.records]

    for i in range(1, len(timestamps)):
        delta = (timestamps[i] - timestamps[i - 1]).total_seconds()
        assert delta == 900


def test_tvc_in_range(ems_device, report_time):
    """Test that TVC stays in a reasonable range for normal operation."""
    reports = []
    t = report_time
    for _ in range(10):
        report = ems_device.create_report(report_time=t)
        reports.append(report)
        t += dt.timedelta(seconds=3600)

    all_tvcs = [r.TVC for rep in reports for r in rep.records]
    # Under normal operation TVC should stay roughly between -5 and 15
    assert all(tvc > -10 for tvc in all_tvcs), f"TVC too low: {min(all_tvcs)}"
    assert all(tvc < 20 for tvc in all_tvcs), f"TVC too high: {max(all_tvcs)}"
