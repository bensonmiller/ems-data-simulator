import re
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
    assert transfer_metadata['transferType'] == 'rtm'
    assert isinstance(transfer_metadata['schemaVersion'], str)
    # transferCallbackUrl is omitted entirely when no webhook URL is present.
    assert 'callbackUrl' not in transfer_metadata
    assert 'transferCallbackUrl' not in transfer_metadata

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
    assert len(rtmd_report) == 10
    assert isinstance(rtmd_report['records'], list)
    assert len(rtmd_report['records']) == 10
    assert isinstance(rtmd_report['records'][0], dict)
    assert len(rtmd_report['records'][0]) == 6
    assert rtmd_report['CID'] == 'USA'
    assert rtmd_report['EDOP'] == '2021-05-04'
    # cce-interop rtmd-report requires AMID (supplier-internal id) and DLST
    # (performance property -> sensor definition map, with at least TVC).
    assert isinstance(rtmd_report['AMID'], str)
    assert isinstance(rtmd_report['DLST'], dict)
    assert 'TVC' in rtmd_report['DLST']
    assert set(rtmd_report['DLST']['TVC']) >= {'SID', 'SMFR', 'SMOD'}

def test_rtmd_transfer(rtmd_transfer):
    assert isinstance(rtmd_transfer, dict)
    assert len(rtmd_transfer) == 2
    assert isinstance(rtmd_transfer['meta'], dict)
    assert len(rtmd_transfer['meta']) == 5
    assert isinstance(rtmd_transfer['meta']['transferId'], str)
    assert isinstance(rtmd_transfer['meta']['transferSrc'], str)
    assert rtmd_transfer['meta']['transferSrc'] == 'org.nhgh'
    assert isinstance(rtmd_transfer['meta']['transferredAt'], datetime)
    assert rtmd_transfer['meta']['transferType'] == 'rtm'
    assert rtmd_transfer['meta']['schemaVersion'] == '0.8.0'
    assert isinstance(rtmd_transfer['meta']['schemaVersion'], str)

def test_transfer_metadata_to_pydantic_model(transfer_metadata):
    print(transfer_metadata)
    model = TransferMetadata(**transfer_metadata)
    assert isinstance(model, TransferMetadata)
    assert isinstance(model.transferId, str)
    assert isinstance(model.transferSrc, str)
    assert isinstance(model.transferredAt, datetime)
    assert isinstance(model.schemaVersion, str)
    assert model.transferCallbackUrl is None

def test_transferred_at_serializes_with_zulu_suffix(transfer_metadata):
    # cce-interop transmission-metadata requires a trailing 'Z', not a +00:00 offset.
    pattern = r'^2[0-9]{3}-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9](\.[0-9]+)?Z$'
    dumped = TransferMetadata(**transfer_metadata).model_dump(mode='json')
    assert re.match(pattern, dumped['transferredAt']), dumped['transferredAt']

def test_rtmd_transfer_to_pydantic_model(rtmd_transfer):
    model = RtmdTransfer(**rtmd_transfer)
    assert isinstance(model, RtmdTransfer)
    assert isinstance(model.meta, TransferMetadata)
    assert isinstance(model.data[0], RtmdReport)
    assert isinstance(model.data[0].records[0], RtmdRecord)