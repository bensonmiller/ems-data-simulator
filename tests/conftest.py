import pytest
from random import choices, gauss, random, randint
from string import ascii_lowercase, digits
from uuid import uuid4
from datetime import datetime, timedelta
import pytz
from gibberish import Gibberish

gib = Gibberish()
letters = ascii_lowercase + digits

def serial_number():
    return "".join(choices(letters, k=10))

def rtmd_record(time=datetime.now(pytz.utc)):
    abst = time
    bemd = max(0, min(gauss(mu=7, sigma=0.5), 14))
    tamb = max(0, min(gauss(mu=20, sigma=2), 30))
    tvc = max(-5, min(gauss(mu=5, sigma=2), 20))
    alrm = None
    eerr = None
    
    if tvc > 10:
        alrm = "HEAT"
    elif tvc <= -0.5:
        alrm = "FRZE"

    if random() < 0.1:
        eerr = gib.generate_word()[0:5]

    obj = {
        "ABST": abst,
        "BEMD": bemd,
        "TAMB": tamb,
        "TVC": tvc,
        "ALRM": alrm,
        "EERR": eerr
    }
    return obj

@pytest.fixture(scope="session")
def transfer_metadata():
    obj = {
        'transferId': str(uuid4()),
        'transferSrc': 'org.nhgh',
        'transferredAt': datetime.now(pytz.utc),
        'schemaVersion': 'rtm:1.0',
        'callbackUrl': None
    }
    return obj

@pytest.fixture(scope="session")
def rtmd_samples(sample_count=10, sample_interval=900):
    """ Generates samples with timestamps and random temperatures (in a reasonable range for fridges) """
    interval = sample_interval
    sample_count = sample_count
    start_time = datetime.now(pytz.utc) - (sample_count * timedelta(seconds=interval))                                          
    delta = timedelta(seconds=interval / sample_count)
    samples = []
    for i in range(sample_count):
        abst = start_time + i * delta
        samples.append(rtmd_record(abst))
    return samples


@pytest.fixture(scope="session")
def rtmd_report(rtmd_samples):
    words = gib.generate_words(3)
    number = str(randint(100,999))

    obj = {
        'CID': 'USA',
        'EDOP': '2021-05-04',
        'EMFR': " ".join(gib.generate_words(2)).title() + " Inc.",
        'EMOD': words[0].capitalize() + f'-{number}',
        'EPQS': f'E006/{number}',
        'ESER': serial_number(),
        'EMSV': '0.0.1',
        'records': rtmd_samples
    }
    return obj


@pytest.fixture(scope="session")
def rtmd_transfer(transfer_metadata, rtmd_report):
    obj = {
        'meta': transfer_metadata,
        'data': [rtmd_report]
    }
    return obj