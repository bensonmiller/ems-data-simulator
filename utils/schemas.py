from pydantic import BaseModel, Field, PlainSerializer, HttpUrl
from typing import List, Optional
from uuid import uuid4
from typing_extensions import Annotated
import datetime as dt

# Custom datetime serialization for EMS-specific formats
emsDateTime = Annotated[
    dt.datetime,
    PlainSerializer(
        lambda x: x.replace(tzinfo=None).isoformat(timespec='seconds').replace('-', '').replace(':', '') + 'Z',
        return_type=str
    )
]

class TransferMetadata(BaseModel, arbitrary_types_allowed=True):
    """Schema for metadata related to CCDX transfers, including both EMS and RTM transfers."""
    transferId: str
    transferSrc: str = 'org.nhgh'
    transferredAt: dt.datetime = Field(default_factory=lambda: dt.datetime.now(dt.UTC))
    schemaVersion: str = 'rtm:1.0'
    callbackUrl: Optional[HttpUrl] = None

class EmsRecord(BaseModel, extra='allow', arbitrary_types_allowed=True):
    """
    Base schema for EMS records.
    A single EmsReport will include 1-n EmsRecords.
    This model is intended to be subclassed for mains and solar power sources.
    """
    ABST: emsDateTime
    BEMD: float
    BLOG: float
    CMPR: int
    DORV: int
    TAMB: float
    TVC: float
    ALRM: Optional[str] = None
    CMPS: Optional[int] = None
    EERR: Optional[str] = None
    FANS: Optional[float] = None
    HAMB: Optional[float] = None
    IDRV: Optional[int] = 0
    HOLD: Optional[float] = None
    LERR: Optional[str] = None
    TCON: Optional[float] = None
    TFRZ: Optional[float] = None

class EmsRecordMains(EmsRecord):
    """Schema for EMS records with mains power source."""
    ACCD: float
    ACSV: float
    SVA: int
    
class EmsRecordSolar(EmsRecord):
    """Schema for EMS records with solar power source."""
    DCCD: float
    DCSV: float

class EmsReport(BaseModel, arbitrary_types_allowed=True):
    """An EmsReport includes common data plus an array of EmsRecords."""
    ADOP: dt.date
    AMFR: str
    AMOD: str
    ASER: str
    APQS: str
    CID: str
    LDOP: dt.date
    LMFR: str
    LMOD: str
    LPQS: str
    LSER: str
    LSV: str
    EDOP: dt.date
    EMFR: str
    EMOD: str
    EPQS: str
    ESER: str
    EMSV: str
    records: List[EmsRecordSolar|EmsRecordMains]
    AID: Optional[str] = None
    ACAT: Optional[str] = None
    LID: Optional[str] = None
    EID: Optional[str] = None
    RNAM: Optional[str] = None
    DNAM: Optional[str] = None
    FNAM: Optional[str] = None
    FID: Optional[str] = None
    LAT: Optional[float] = None
    LNG: Optional[float] = None
    SIGN: Optional[str] = None
    EXTRA: Optional[dict] = Field(default_factory=dict)

class RtmdRecord(BaseModel, extra='allow', arbitrary_types_allowed=True):
    """Schema for RTMD (non-EMS) records. A single RtmdReport will include 1-n RtmdRecords."""
    ABST: emsDateTime
    BEMD: float
    TAMB: float
    TVC: float
    ALRM: Optional[str] = None
    EERR: Optional[str] = None

class RtmdReport(BaseModel, arbitrary_types_allowed=True):
    """An RtmdReport includes common data plus an array of RtmdRecords."""
    CID: str
    EDOP: dt.date
    EMFR: str
    EMOD: str
    EPQS: str
    ESER: str
    EMSV: str
    records: List[RtmdRecord]
    ACAT: Optional[str] = None
    ADOP: Optional[dt.date] = None
    AID: Optional[str] = None
    AMFR: Optional[str] = None
    AMOD: Optional[str] = None
    APQS: Optional[str] = None
    ASER: Optional[str] = None
    EID: Optional[str] = None
    RNAM: Optional[str] = None
    DNAM: Optional[str] = None
    FNAM: Optional[str] = None
    FID: Optional[str] = None
    LAT: Optional[float] = None
    LNG: Optional[float] = None
    SIGN: Optional[str] = None
    EXTRA: Optional[dict] = Field(default_factory=dict)

class RtmdTransfer(BaseModel, arbitrary_types_allowed=True):
    """Schema for an RTMD transfer containing metadata and a list of RTMD reports."""
    meta: TransferMetadata
    data: List[RtmdReport]

class EmsTransfer(BaseModel, arbitrary_types_allowed=True):
    """Schema for an EMS transfer containing metadata and a list of EMS reports."""
    meta: TransferMetadata
    data: List[EmsReport]
