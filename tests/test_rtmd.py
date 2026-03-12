from datetime import datetime
from utils.schemas import (
    TransferMetadata,
    RtmdRecord,
    RtmdReport,
    RtmdTransfer
)

def test_metadata(transfer_metadata):
    assert isinstance(transfer_metadata, dict)
    assert len(transfer_metadata) == 5
    assert isinstance(transfer_metadata['transferId'], str)
    assert isinstance(transfer_metadata['transferSrc'], str)
    assert isinstance(transfer_metadata['transferredAt'], datetime)
    assert isinstance(transfer_metadata['schemaVersion'], str)
    assert transfer_metadata['callbackUrl'] is None

def test_rtmd_samples(rtmd_samples):
    assert isinstance(rtmd_samples, list)
    assert len(rtmd_samples) == 10
    assert isinstance(rtmd_samples[0], dict)
    assert len(rtmd_samples[0]) == 6
    assert isinstance(rtmd_samples[0]['ABST'], datetime)
    assert isinstance(rtmd_samples[0]['BEMD'], float)
    assert isinstance(rtmd_samples[0]['TAMB'], float)
    assert isinstance(rtmd_samples[0]['TVC'], float)
    assert isinstance(rtmd_samples[0]['ALRM'], str) or rtmd_samples[0]['ALRM'] is None
    assert isinstance(rtmd_samples[0]['EERR'], str) or rtmd_samples[0]['EERR'] is None

def test_rtmd_report(rtmd_report):
    assert isinstance(rtmd_report, dict)
    assert len(rtmd_report) == 8
    assert isinstance(rtmd_report['records'], list)
    assert len(rtmd_report['records']) == 10
    assert isinstance(rtmd_report['records'][0], dict)
    assert len(rtmd_report['records'][0]) == 6
    assert rtmd_report['CID'] == 'USA'
    assert rtmd_report['EDOP'] == '2021-05-04'

def test_rtmd_transfer(rtmd_transfer):
    assert isinstance(rtmd_transfer, dict)
    assert len(rtmd_transfer) == 2
    assert isinstance(rtmd_transfer['meta'], dict)
    assert len(rtmd_transfer['meta']) == 5
    assert isinstance(rtmd_transfer['meta']['transferId'], str)
    assert isinstance(rtmd_transfer['meta']['transferSrc'], str)
    assert rtmd_transfer['meta']['transferSrc'] == 'org.nhgh'
    assert isinstance(rtmd_transfer['meta']['transferredAt'], datetime)
    assert rtmd_transfer['meta']['schemaVersion'] == 'rtm:1.0'
    assert isinstance(rtmd_transfer['meta']['schemaVersion'], str)

def test_transfer_metadata_to_pydantic_model(transfer_metadata):
    print(transfer_metadata)
    model = TransferMetadata(**transfer_metadata)
    assert isinstance(model, TransferMetadata)
    assert isinstance(model.transferId, str)
    assert isinstance(model.transferSrc, str)
    assert isinstance(model.transferredAt, datetime)
    assert isinstance(model.schemaVersion, str)
    assert model.callbackUrl is None

def test_rtmd_transfer_to_pydantic_model(rtmd_transfer):
    model = RtmdTransfer(**rtmd_transfer)
    assert isinstance(model, RtmdTransfer)
    assert isinstance(model.meta, TransferMetadata)
    assert isinstance(model.data[0], RtmdReport)
    assert isinstance(model.data[0].records[0], RtmdRecord)