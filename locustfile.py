from locust import HttpUser, task, constant_pacing
from random import gauss
from os import environ
from dotenv import load_dotenv
from utils.device import MonitoringDeviceConfig, BaseRtmDevice
from utils.schemas import TransferMetadata, EmsTransfer, RtmdTransfer
from utils.generator import transfer_metadata
from utils.devicegroups import DeviceGroup, rtmds

load_dotenv()


class SingleRtmDevice(HttpUser):
    '''Class for simulating a single RTM device.'''
    type='rtmd'
    host='https://openfn.2to8.cc'
    weight=0
    device_count=1  # Set to None for random generation
    wait_time = constant_pacing(10)

    def on_start(self):
        self.devices = []

        dg = DeviceGroup(rtmds)
        mfr = dg.get_random_manufacturer()

        if self.device_count is None:
            self.device_count = int(max(10, min(gauss(mu=75, sigma=50), 150)))

        print(f'Starting {self.device_count} virtual devices with {mfr}')

        for i in range(self.device_count):
            config = MonitoringDeviceConfig(type=self.type, manufacturer=mfr)
            device = BaseRtmDevice(config)
            self.devices.append(device)

        if self.type == 'ems':
            self.transfer_schema = EmsTransfer
        else:
            self.transfer_schema = RtmdTransfer

    @task()
    def post_packet(self):
        workflow_id = environ.get('OPENFN_WORKFLOW_ID')
        reports = []
        for d in self.devices:
            reports.append(d.create_report())
        md = transfer_metadata(type=self.type)
        tx = self.transfer_schema(data=reports, meta=TransferMetadata(**md))
        body = tx.model_dump(mode='json', exclude_unset=True)
        response = self.client.post(f'/{workflow_id}', json=body)
        return response


## EMS DEVICE ####
class MultipleRtmDevices(SingleRtmDevice):
    weight=0
    wait_time = constant_pacing(60)
    device_count = None   # for random generation

class singleEmsDevice(SingleRtmDevice):
    type='ems'
    weight=1
    wait_time = constant_pacing(60)
    device_count = 1
