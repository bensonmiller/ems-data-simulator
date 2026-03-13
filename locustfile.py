from collections import deque
from datetime import datetime, timedelta
from random import uniform

from locust import HttpUser, task, constant_pacing, events
from os import environ
from dotenv import load_dotenv
from utils.device import MonitoringDeviceConfig, BaseRtmDevice
from utils.schemas import TransferMetadata, EmsTransfer, RtmdTransfer
from utils.generator import transfer_metadata

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration — override via environment variables
# ---------------------------------------------------------------------------
# Number of sequential reports to pre-generate per device.
# Each report covers one upload_interval (typically 1–8 hours of data).
NUM_REPORTS = int(environ.get('NUM_REPORTS', 168))        # default: ~1 week @ 1h interval

# Simulated start date (ISO format). Each user adds a small random jitter.
SIM_START = environ.get('SIM_START', '2024-06-15T00:00:00')

# Max per-user jitter applied to the start time (seconds).
START_JITTER_S = int(environ.get('START_JITTER_S', 3600))


class CceDevice(HttpUser):
    """
    Base Locust user representing a single CCE device.

    on_start() pre-generates a queue of sequential reports so that:
      - Each report's sensor data is physically continuous with the previous one
        (thermal state, compressor, battery SOC all carry over).
      - Simulated time is decoupled from wall-clock send rate — Locust can
        fire reports as fast or slow as you like.
      - Volume comes from spawning many users (= many devices), not from
        time compression.

    post_packet() pops the next report and POSTs it.  When the queue is
    exhausted the user stops itself.
    """

    abstract = True                       # Locust won't instantiate this directly
    device_type = 'rtmd'                  # override in subclasses
    host = environ.get('TARGET_HOST', 'http://localhost:8000')
    wait_time = constant_pacing(3600)       # seconds between POSTs

    def on_start(self):
        config = MonitoringDeviceConfig(type=self.device_type)
        self.device = BaseRtmDevice(config)

        # Pick the right transfer schema
        if self.device_type == 'ems':
            self.transfer_schema = EmsTransfer
        else:
            self.transfer_schema = RtmdTransfer

        # Determine simulated timeline
        start = datetime.fromisoformat(SIM_START)
        jitter = timedelta(seconds=uniform(0, START_JITTER_S))
        t = start + jitter
        upload_interval = timedelta(seconds=config.upload_interval)

        # Pre-generate sequential reports
        self.report_queue = deque()
        for _ in range(NUM_REPORTS):
            report = self.device.create_report(report_time=t)
            self.report_queue.append(report)
            t += upload_interval

        print(
            f'[{self.device_type.upper()}] {self.device} — '
            f'pre-generated {NUM_REPORTS} reports '
            f'({config.upload_interval}s interval, '
            f'{config.sample_interval}s samples)'
        )

    @task
    def post_packet(self):
        if not self.report_queue:
            self.environment.runner.quit()
            return

        report = self.report_queue.popleft()
        workflow_id = environ.get('OPENFN_WORKFLOW_ID')

        md = transfer_metadata(type=self.device_type)
        tx = self.transfer_schema(
            data=[report],
            meta=TransferMetadata(**md),
        )
        body = tx.model_dump(mode='json', exclude_unset=True)
        self.client.post(f'/{workflow_id}', json=body)


# ---------------------------------------------------------------------------
# Concrete device types — adjust weights to control the mix
# ---------------------------------------------------------------------------

class RtmdDevice(CceDevice):
    """RTMD (remote temperature monitoring device)."""
    device_type = 'rtmd'
    weight = 1
    wait_time = constant_pacing(10)


class EmsDevice(CceDevice):
    """EMS (energy management system) device."""
    device_type = 'ems'
    weight = 1
    wait_time = constant_pacing(10)
