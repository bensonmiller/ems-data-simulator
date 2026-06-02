from uuid import uuid4
from datetime import datetime
import pytz


def random_serial():
    return uuid4().hex


def transfer_metadata(type='rtmd'):
    obj = {
        'transferId': str(uuid4()),
        'transferSrc': 'org.nhgh',
        'transferredAt': datetime.now(pytz.utc),
        'transferType': 'rtm',
        'schemaVersion': '0.8.0',
        'callbackUrl': None
    }
    if type == 'ems':
        obj['transferType'] = 'ems'

    return obj
