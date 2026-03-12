import datetime as dt
import random
from utils.devicegroups import DeviceGroup, rtmds, fridges
from utils.facilities import Facility, random_facility
from utils.generator import random_serial
from utils.simulator import SimulatedRecordSet, SimulatorState, default_config
import logging
from utils.schemas import (
    RtmdReport,
    EmsReport,
    TransferMetadata
)

logger = logging.getLogger(__name__)

class MonitoringDeviceConfig:
    '''Configuration class for virtual CCE monitoring devices.'''

    def __init__(self,
                 type: str =None,
                 upload_interval: int = None,
                 sample_interval: int = None,
                 facility: Facility = None,
                 manufacturer: str = None
                 ):
        # Randomly select device type if not specified
        if type is None:
            type_options = ['rtmd', 'ems']
            type_weights = [.7, .3]
            type = random.choices(type_options, weights=type_weights, k=1)[0]
        self.type = type

        # Randomly select upload and sample intervals if not specified
        if upload_interval is None:
            upload_interval_options = [3600, 7200, 14400, 28800]
            upload_interval_weights = [.5, .3, .1, .1]
            upload_interval = random.choices(upload_interval_options, weights=upload_interval_weights, k=1)[0]
        self.upload_interval = upload_interval

        # Randomly select sample interval if not specified
        if sample_interval is None:
            sample_interval_options = [600, 900]
            sample_interval_weights = [.3, .7]
            sample_interval = random.choices(sample_interval_options, weights=sample_interval_weights, k=1)[0]
        self.sample_interval = sample_interval
        if self.upload_interval < self.sample_interval:
            raise ValueError("Upload interval must be greater than or equal to sample interval.")
        if self.upload_interval % self.sample_interval != 0:
            raise ValueError("Upload interval must be a multiple of sample interval.")

        # Calculate the batch size based on the upload and sample intervals
        self.batch_size = self.upload_interval // self.sample_interval

        if isinstance(facility, Facility):
            self.facility = facility
        else:
            self.facility = random_facility()
        self.manufacturer = manufacturer

        # Generate the appliance and device based on the type
        dg = DeviceGroup(fridges)
        self.appliance = dg.random_device(manufacturer=self.manufacturer)
        self.device = self.appliance   # Assume that EMS devices have monitoring devices built-in
        if self.type == 'rtmd':
            dg = DeviceGroup(rtmds)
            self.device = dg.random_device(manufacturer=self.manufacturer)


    def __repr__(self):
        return f"MonitoringDeviceConfig(type={self.type}, upload_interval={self.upload_interval}, sample_interval={self.sample_interval}, device={self.device.manufacturer} {self.device.model}, facility={self.facility.facility_name})"


def _infer_power_type(appliance_type: str) -> str:
    """Infer power type from the appliance type string in the PQS catalog.

    Appliance types containing 'Solar' or 'SDD' are solar-powered;
    everything else is mains-powered.
    """
    if appliance_type is None:
        return 'mains'
    lower = appliance_type.lower()
    if 'solar' in lower or 'sdd' in lower:
        return 'solar'
    return 'mains'


class BaseRtmDevice:
    """
    Class that models an RTMD or EMS device.

    Uses a physics-based thermal simulator to generate synthetic CCE data
    instead of replaying database records.
    """
    def __init__(self, config: MonitoringDeviceConfig):
        self.config = config
        self.last_sample_time = None  # Time of the last sample in previous report

        # Infer power source from the appliance's PQS type string
        self.powersource = _infer_power_type(self.config.appliance.type)

        # Create simulation config based on power type and facility location
        self.sim_config = default_config(
            power_type=self.powersource,
            latitude=self.config.facility.latitude,
        )
        self.sim_config.sample_interval = self.config.sample_interval

        # Simulator state (initialized on first report)
        self.simulator_state = None

        # Initialize device attributes
        self.amfr = self.config.appliance.manufacturer
        self.amod = self.config.appliance.model
        self.apqs = self.config.appliance.pqs_code
        self.aser = random_serial()
        self.adop = self._get_mock_adop()

        if self.config.type == 'rtmd':
            self.lmfr = self.config.device.manufacturer
            self.lmod = self.config.device.model
            self.lpqs = self.config.device.pqs_code
        elif self.config.type == "ems":
            self.lmfr = self.amfr
            self.lmod = self.amod
            self.lpqs = self.apqs
        else:
            raise ValueError(f"Invalid device type: {self.config.type}")

        self.lser = random_serial()
        self.ldop = self.adop
        self.lsv = '0.1.x'

        # For simplicity, use the same values for EMD and Logger
        self.emfr = self.lmfr
        self.emod = self.lmod
        self.epqs = self.lpqs
        self.eser = self.lser
        self.edop = self.ldop
        self.emsv = self.lsv

        self.cid = self.config.facility.iso
        self.lat = self.config.facility.latitude
        self.lng = self.config.facility.longitude

    def __repr__(self):
        return (f"BaseRtmDevice(type={self.config.type}, "
                f"CID={self.cid}, "
                f"AMFR={self.amfr}, AMOD={self.amod}, "
                f"ASER={self.aser}, ADOP={self.adop}, "
                f"LMFR={self.lmfr}, LMOD={self.lmod}, "
                f"LSEV={self.lsv})")

    def _get_mock_adop(self):
        """Generate a random date string (YYYY-MM-DD) between Jan 1, 2018 and Dec 31, 2024."""
        start_date = dt.date(2018, 1, 1)
        end_date = dt.date(2024, 12, 31)
        random_days = random.randint(0, (end_date - start_date).days)
        random_date = start_date + dt.timedelta(days=random_days)
        return random_date.strftime('%Y-%m-%d')

    def create_report(self, report_time=None):
        '''
        Create a report for the device based on device configuration.

        This method can be called:
            1. On regular intervals (e.g. via Locust) with report_time=None (defaults to now).
            2. With a specific report_time for batch/historical data generation.

        The report covers the period from last_sample_time to report_time,
        generating enough samples to fill the gap at the configured sample_interval.
        '''

        if report_time is None:
            report_time = dt.datetime.now(dt.UTC).replace(tzinfo=None, microsecond=0)
        if not isinstance(report_time, dt.datetime):
            raise ValueError("report_time must be a datetime object.")
        self.report_time = report_time

        if self.last_sample_time is None:
            self.last_sample_time = self.report_time - dt.timedelta(seconds=self.config.upload_interval)

        if self.last_sample_time >= self.report_time:
            raise ValueError("report_time must be greater than the last sample time. Please check your report_time.")

        batch_size = (self.report_time - self.last_sample_time) // dt.timedelta(seconds=self.config.sample_interval)
        time_of_first_record_in_this_batch = self.last_sample_time + dt.timedelta(seconds=self.config.sample_interval)

        # Generate simulated records
        recordset = SimulatedRecordSet.generate(
            config=self.sim_config,
            batch_size=batch_size,
            start_time=time_of_first_record_in_this_batch,
            interval=self.config.sample_interval,
            state=self.simulator_state,
        )
        self.simulator_state = recordset.state

        nudged_coordinates = self.config.facility.get_nudged_coordinates()

        report_object = {
            'CID': self.cid,
            'ADOP': self.adop,
            'AMFR': self.amfr,
            'AMOD': self.amod,
            'APQS': self.apqs,
            'ASER': self.aser,
            'EDOP': self.edop,
            'EMFR': self.emfr,
            'EMOD': self.emod,
            'EPQS': self.epqs,
            'ESER': self.eser,
            'EMSV': self.emsv,
            'LDOP': self.ldop,
            'LMFR': self.lmfr,
            'LMOD': self.lmod,
            'LPQS': self.lpqs,
            'LSER': self.lser,
            'LSV' : self.lsv,
            'LAT': nudged_coordinates.latitude,
            'LNG': nudged_coordinates.longitude
        }

        if self.config.type == 'rtmd':
            report_object['records'] = recordset.to_rtmd()
            report = RtmdReport(**report_object)
        elif self.config.type == 'ems':
            report_object['records'] = recordset.to_ems(powersource=self.powersource)
            report = EmsReport(**report_object)

        self.last_sample_time = self.last_sample_time + dt.timedelta(seconds=batch_size * self.config.sample_interval)

        return report
