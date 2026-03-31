import { describe, it, expect } from 'vitest';
import {
  formatEmsDateTime,
  TransferMetadata,
  EmsRecord,
  EmsRecordMains,
  EmsRecordSolar,
  EmsReport,
  RtmdRecord,
  RtmdReport,
  EmsTransfer,
  RtmdTransfer,
} from './schemas.js';

// ---------------------------------------------------------------------------
// formatEmsDateTime
// ---------------------------------------------------------------------------

describe('formatEmsDateTime', () => {
  it('formats a typical UTC date', () => {
    const d = new Date('2024-01-15T14:30:00Z');
    expect(formatEmsDateTime(d)).toBe('20240115T143000z');
  });

  it('formats midnight on New Year', () => {
    const d = new Date('2025-01-01T00:00:00Z');
    expect(formatEmsDateTime(d)).toBe('20250101T000000z');
  });

  it('formats end-of-year boundary', () => {
    const d = new Date('2024-12-31T23:59:59Z');
    expect(formatEmsDateTime(d)).toBe('20241231T235959z');
  });

  it('zero-pads single-digit months and days', () => {
    const d = new Date('2024-03-05T09:07:03Z');
    expect(formatEmsDateTime(d)).toBe('20240305T090703z');
  });
});

// ---------------------------------------------------------------------------
// TransferMetadata
// ---------------------------------------------------------------------------

describe('TransferMetadata', () => {
  it('serializes with defaults', () => {
    const tm = new TransferMetadata({ transferId: 'abc-123' });
    const json = tm.toJSON();
    expect(json.transferId).toBe('abc-123');
    expect(json.transferSrc).toBe('org.nhgh');
    expect(json.schemaVersion).toBe('rtm:1.0');
    expect(json).toHaveProperty('transferredAt');
    expect(json).not.toHaveProperty('callbackUrl');
  });

  it('includes callbackUrl when provided', () => {
    const tm = new TransferMetadata({
      transferId: 'x',
      callbackUrl: 'https://example.com/cb',
    });
    expect(tm.toJSON().callbackUrl).toBe('https://example.com/cb');
  });
});

// ---------------------------------------------------------------------------
// EmsRecordMains
// ---------------------------------------------------------------------------

describe('EmsRecordMains', () => {
  const base = {
    ABST: new Date('2024-06-01T12:00:00Z'),
    BEMD: 14.2,
    BLOG: 0.8,
    CMPR: 1,
    DORV: 0,
    TAMB: 30.5,
    TVC: 4.1,
    ACCD: 0.55,
    ACSV: 230.0,
    SVA: 120,
  };

  it('toJSON includes mains-specific fields', () => {
    const rec = new EmsRecordMains(base);
    const json = rec.toJSON();
    expect(json.ACCD).toBe(0.55);
    expect(json.ACSV).toBe(230.0);
    expect(json.SVA).toBe(120);
  });

  it('formats ABST with emsDateTime', () => {
    const rec = new EmsRecordMains(base);
    expect(rec.toJSON().ABST).toBe('20240601T120000z');
  });

  it('excludes undefined optional fields', () => {
    const rec = new EmsRecordMains(base);
    const json = rec.toJSON();
    expect(json).not.toHaveProperty('ALRM');
    expect(json).not.toHaveProperty('EERR');
    expect(json).not.toHaveProperty('HOLD');
    expect(json).not.toHaveProperty('LERR');
  });

  it('includes optional fields when set', () => {
    const rec = new EmsRecordMains({ ...base, ALRM: 'HEAT', EERR: 'E01' });
    const json = rec.toJSON();
    expect(json.ALRM).toBe('HEAT');
    expect(json.EERR).toBe('E01');
  });
});

// ---------------------------------------------------------------------------
// EmsRecordSolar
// ---------------------------------------------------------------------------

describe('EmsRecordSolar', () => {
  it('toJSON includes solar-specific fields', () => {
    const rec = new EmsRecordSolar({
      ABST: new Date('2024-06-01T12:00:00Z'),
      BEMD: 14.2,
      BLOG: 0.8,
      CMPR: 1,
      DORV: 0,
      TAMB: 30.5,
      TVC: 4.1,
      DCCD: 3.2,
      DCSV: 18.5,
    });
    const json = rec.toJSON();
    expect(json.DCCD).toBe(3.2);
    expect(json.DCSV).toBe(18.5);
    expect(json).not.toHaveProperty('ACCD');
  });
});

// ---------------------------------------------------------------------------
// RtmdRecord
// ---------------------------------------------------------------------------

describe('RtmdRecord', () => {
  it('toJSON only includes RTMD fields', () => {
    const rec = new RtmdRecord({
      ABST: new Date('2024-06-01T12:00:00Z'),
      BEMD: 14.2,
      TAMB: 30.5,
      TVC: 4.1,
    });
    const json = rec.toJSON();
    expect(json).toHaveProperty('ABST');
    expect(json).toHaveProperty('BEMD');
    expect(json).toHaveProperty('TAMB');
    expect(json).toHaveProperty('TVC');
    // Should NOT have EMS-only fields
    expect(json).not.toHaveProperty('BLOG');
    expect(json).not.toHaveProperty('CMPR');
    expect(json).not.toHaveProperty('DORV');
  });

  it('excludes null optional fields', () => {
    const rec = new RtmdRecord({
      ABST: new Date('2024-06-01T12:00:00Z'),
      BEMD: 14.2,
      TAMB: 30.5,
      TVC: 4.1,
    });
    const json = rec.toJSON();
    expect(json).not.toHaveProperty('ALRM');
    expect(json).not.toHaveProperty('EERR');
  });

  it('formats ABST as emsDateTime', () => {
    const rec = new RtmdRecord({
      ABST: new Date('2024-06-01T12:00:00Z'),
      BEMD: 14.2,
      TAMB: 30.5,
      TVC: 4.1,
    });
    expect(rec.toJSON().ABST).toBe('20240601T120000z');
  });
});

// ---------------------------------------------------------------------------
// EmsReport (full structure)
// ---------------------------------------------------------------------------

describe('EmsReport', () => {
  it('matches Python model_dump(mode="json") format', () => {
    const report = new EmsReport({
      ADOP: new Date('2024-01-01'),
      AMFR: 'MFR-A',
      AMOD: 'MOD-A',
      ASER: 'SER-A',
      APQS: 'PQS-A',
      CID: 'cid-001',
      LDOP: new Date('2024-01-02'),
      LMFR: 'MFR-L',
      LMOD: 'MOD-L',
      LPQS: 'PQS-L',
      LSER: 'SER-L',
      LSV: '1.0',
      EDOP: new Date('2024-01-03'),
      EMFR: 'MFR-E',
      EMOD: 'MOD-E',
      EPQS: 'PQS-E',
      ESER: 'SER-E',
      EMSV: '2.0',
      records: [
        new EmsRecordMains({
          ABST: new Date('2024-06-01T12:00:00Z'),
          BEMD: 14.2,
          BLOG: 0.8,
          CMPR: 1,
          DORV: 0,
          TAMB: 30.5,
          TVC: 4.1,
          ACCD: 0.55,
          ACSV: 230.0,
          SVA: 120,
        }),
      ],
    });

    const json = report.toJSON();

    // Date fields are ISO date strings
    expect(json.ADOP).toBe('2024-01-01');
    expect(json.LDOP).toBe('2024-01-02');
    expect(json.EDOP).toBe('2024-01-03');

    // Required string fields
    expect(json.CID).toBe('cid-001');
    expect(json.AMFR).toBe('MFR-A');
    expect(json.EMSV).toBe('2.0');

    // Records array
    expect(json.records).toHaveLength(1);
    expect(json.records[0].ABST).toBe('20240601T120000z');
    expect(json.records[0].ACCD).toBe(0.55);

    // Optional fields not set should be absent
    expect(json).not.toHaveProperty('AID');
    expect(json).not.toHaveProperty('LAT');
    expect(json).not.toHaveProperty('EXTRA');
  });
});

// ---------------------------------------------------------------------------
// RtmdReport (full structure)
// ---------------------------------------------------------------------------

describe('RtmdReport', () => {
  it('matches Python model_dump(mode="json") format', () => {
    const report = new RtmdReport({
      CID: 'cid-002',
      EDOP: '2024-06-01',
      EMFR: 'MFR-E',
      EMOD: 'MOD-E',
      EPQS: 'PQS-E',
      ESER: 'SER-E',
      EMSV: '2.0',
      records: [
        new RtmdRecord({
          ABST: new Date('2024-06-01T12:00:00Z'),
          BEMD: 14.2,
          TAMB: 30.5,
          TVC: 4.1,
        }),
      ],
    });

    const json = report.toJSON();
    expect(json.CID).toBe('cid-002');
    expect(json.EDOP).toBe('2024-06-01');
    expect(json.records).toHaveLength(1);
    expect(json.records[0].ABST).toBe('20240601T120000z');
    expect(json).not.toHaveProperty('RNAM');
    expect(json).not.toHaveProperty('EXTRA');
  });
});

// ---------------------------------------------------------------------------
// EmsTransfer / RtmdTransfer
// ---------------------------------------------------------------------------

describe('EmsTransfer', () => {
  it('wraps meta + data and serializes', () => {
    const transfer = new EmsTransfer({
      meta: { transferId: 't-001' },
      data: [
        new EmsReport({
          ADOP: '2024-01-01',
          AMFR: 'A', AMOD: 'A', ASER: 'A', APQS: 'A', CID: 'c',
          LDOP: '2024-01-01', LMFR: 'L', LMOD: 'L', LPQS: 'L', LSER: 'L', LSV: '1',
          EDOP: '2024-01-01', EMFR: 'E', EMOD: 'E', EPQS: 'E', ESER: 'E', EMSV: '1',
          records: [],
        }),
      ],
    });
    const json = transfer.toJSON();
    expect(json.meta.transferId).toBe('t-001');
    expect(json.meta.transferSrc).toBe('org.nhgh');
    expect(json.data).toHaveLength(1);
    expect(json.data[0].CID).toBe('c');
  });
});

describe('RtmdTransfer', () => {
  it('wraps meta + data and serializes', () => {
    const transfer = new RtmdTransfer({
      meta: new TransferMetadata({ transferId: 'rt-001' }),
      data: [
        new RtmdReport({
          CID: 'c', EDOP: '2024-01-01', EMFR: 'E', EMOD: 'E',
          EPQS: 'E', ESER: 'E', EMSV: '1', records: [],
        }),
      ],
    });
    const json = transfer.toJSON();
    expect(json.meta.transferId).toBe('rt-001');
    expect(json.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Undefined field exclusion (cross-cutting)
// ---------------------------------------------------------------------------

describe('undefined field exclusion', () => {
  it('EmsRecord excludes all unset optional fields', () => {
    const rec = new EmsRecord({
      ABST: new Date('2024-01-01T00:00:00Z'),
      BEMD: 12.0,
      BLOG: 0.5,
      CMPR: 0,
      DORV: 0,
      TAMB: 25.0,
      TVC: 5.0,
    });
    const json = rec.toJSON();
    const keys = Object.keys(json);
    expect(keys).toEqual(['ABST', 'BEMD', 'BLOG', 'CMPR', 'DORV', 'TAMB', 'TVC']);
  });

  it('EmsRecord preserves extra (unknown) fields', () => {
    const rec = new EmsRecord({
      ABST: new Date('2024-01-01T00:00:00Z'),
      BEMD: 12.0,
      BLOG: 0.5,
      CMPR: 0,
      DORV: 0,
      TAMB: 25.0,
      TVC: 5.0,
      CUSTOM: 'hello',
    });
    expect(rec.toJSON().CUSTOM).toBe('hello');
  });
});
