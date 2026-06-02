from uuid import uuid4
from datetime import datetime
import pytz


def random_serial():
    return uuid4().hex


def random_amid():
    """Supplier-internal Appliance Monitoring ID (AMID).

    Per cce-interop, AMID is the appliance's ID in the RTMD supplier's cloud
    platform -- a stable reference that is deliberately NOT the serial/asset
    number. A random 12-hex token (e.g. '4bb74045097e') matches the schema
    examples; mint once per device and reuse across reports to keep it stable.
    """
    return uuid4().hex[:12]


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
