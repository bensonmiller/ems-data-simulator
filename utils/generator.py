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
        'schemaVersion': None,
        'callbackUrl': None
    }
    if type == 'ems':
        obj['schemaVersion'] = 'ems:1.0'
    else:
        obj['schemaVersion'] = 'rtm:1.0'

    return obj
