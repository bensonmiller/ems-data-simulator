import gzip as gzip_codec
import json
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

# Path on TARGET_HOST that reports are POSTed to (the ingestion endpoint).
# Override to match whatever ingestion service you point at.
INGEST_PATH = environ.get('INGEST_PATH', '/')

# --- Delivery transport (CCE data delivery spec) --------------------------
# Character encoding declared in the Content-Type header (spec §1.1/§1.2:
# UTF-8 JSON, charset must be stated). Default utf-8; override per employer.
CHARSET = environ.get('CHARSET', 'utf-8')
CONTENT_TYPE = f'application/json; charset={CHARSET}'

# Authentication (spec §1.3). Token placed in an employer-named header.
# AUTH_HEADER  — header name (default x-api-key; e.g. Authorization for Bearer/Basic)
# AUTH_SCHEME  — optional scheme prefix (e.g. Bearer, Basic); empty = bare token
# AUTH_TOKEN   — the opaque secret; unset = no auth header sent (auth disabled)
AUTH_HEADER = environ.get('AUTH_HEADER', 'x-api-key')
AUTH_SCHEME = environ.get('AUTH_SCHEME', '')
AUTH_TOKEN = environ.get('AUTH_TOKEN')

# Gzip request body (spec §1.6: optional, raw binary, never base64-wrapped).
GZIP = environ.get('GZIP', '').strip().lower() in ('1', 'true', 'yes', 'on')

# Spec §1.4: request body capped at 1MB, measured after content-encoding.
MAX_BODY_BYTES = 1024 * 1024


def build_request_headers():
    """Static request headers — auth + content metadata are constant per run."""
    headers = {'Content-Type': CONTENT_TYPE}
    if AUTH_TOKEN:
        headers[AUTH_HEADER] = (
            f'{AUTH_SCHEME} {AUTH_TOKEN}'.strip() if AUTH_SCHEME else AUTH_TOKEN
        )
    if GZIP:
        headers['Content-Encoding'] = 'gzip'
    return headers


REQUEST_HEADERS = build_request_headers()


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

        md = transfer_metadata(type=self.device_type)
        tx = self.transfer_schema(
            data=[report],
            meta=TransferMetadata(**md),
        )
        body = tx.model_dump(mode='json', exclude_unset=True)

        # Serialize to the declared charset, then optionally gzip. Sent as raw
        # bytes (data=) so Content-Type/charset, auth, and Content-Encoding from
        # REQUEST_HEADERS all apply — the json= kwarg would override them.
        payload = json.dumps(body).encode(CHARSET)
        if GZIP:
            payload = gzip_codec.compress(payload)  # raw binary, no base64 (§1.6)
        if len(payload) > MAX_BODY_BYTES:
            print(
                f'[WARN] request body {len(payload)} bytes exceeds the '
                f'{MAX_BODY_BYTES}-byte (1MB) §1.4 cap'
            )

        self.client.post(INGEST_PATH, data=payload, headers=REQUEST_HEADERS)


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
