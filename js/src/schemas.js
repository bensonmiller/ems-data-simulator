/**
 * Schema classes for EMS and RTMD data transfers.
 *
 * Ported from Python Pydantic models — plain JS classes with no
 * validation library.  Each class accepts a config object in its
 * constructor and exposes a toJSON() method that returns a plain
 * object suitable for JSON.stringify().
 */

/**
 * Format a Date as an EMS datetime string: YYYYMMDDTHHMMSSz
 * (no dashes, no colons, lowercase z).
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatEmsDateTime(date) {
  const y = date.getUTCFullYear().toString();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${d}T${h}${mi}${s}z`;
}

/**
 * Format a Date (or ISO date string) as YYYY-MM-DD.
 * @param {Date|string} d
 * @returns {string}
 */
function formatDate(d) {
  if (typeof d === 'string') return d;
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a plain copy of obj with undefined/null values removed. */
function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TransferMetadata
// ---------------------------------------------------------------------------

export class TransferMetadata {
  /**
   * @param {object} opts
   * @param {string} opts.transferId
   * @param {string} [opts.transferSrc='org.nhgh']
   * @param {Date}   [opts.transferredAt]
   * @param {string} [opts.schemaVersion='rtm:1.0']
   * @param {string|null} [opts.callbackUrl]
   */
  constructor({
    transferId,
    transferSrc = 'org.nhgh',
    transferredAt = new Date(),
    schemaVersion = 'rtm:1.0',
    callbackUrl = null,
  }) {
    this.transferId = transferId;
    this.transferSrc = transferSrc;
    this.transferredAt = transferredAt;
    this.schemaVersion = schemaVersion;
    this.callbackUrl = callbackUrl;
  }

  toJSON() {
    const obj = {
      transferId: this.transferId,
      transferSrc: this.transferSrc,
      transferredAt: this.transferredAt instanceof Date
        ? this.transferredAt.toISOString()
        : this.transferredAt,
      schemaVersion: this.schemaVersion,
    };
    if (this.callbackUrl != null) {
      obj.callbackUrl = this.callbackUrl;
    }
    return obj;
  }
}

// ---------------------------------------------------------------------------
// EmsRecord (base) and subclasses
// ---------------------------------------------------------------------------

/** All fields that may appear on an EmsRecord (base). */
const EMS_RECORD_FIELDS = [
  'ABST', 'BEMD', 'BLOG', 'CMPR', 'DORV', 'TAMB', 'TVC',
  'ALRM', 'CMPS', 'EERR', 'FANS', 'HAMB', 'IDRV', 'HOLD', 'LERR', 'TCON', 'TFRZ',
];

export class EmsRecord {
  /**
   * @param {object} opts – field values. Unknown keys are preserved (extra='allow').
   */
  constructor(opts = {}) {
    // Assign known fields
    for (const key of EMS_RECORD_FIELDS) {
      if (opts[key] !== undefined) {
        this[key] = opts[key];
      }
    }
    // Extra fields (extra='allow' in Python)
    for (const key of Object.keys(opts)) {
      if (!EMS_RECORD_FIELDS.includes(key)) {
        this[key] = opts[key];
      }
    }
  }

  toJSON() {
    const obj = {};
    for (const [k, v] of Object.entries(this)) {
      if (v === undefined || v === null) continue;
      if (k === 'ABST') {
        obj[k] = v instanceof Date ? formatEmsDateTime(v) : v;
      } else {
        obj[k] = v;
      }
    }
    return obj;
  }
}

export class EmsRecordMains extends EmsRecord {
  constructor(opts = {}) {
    super(opts);
    if (opts.ACCD !== undefined) this.ACCD = opts.ACCD;
    if (opts.ACSV !== undefined) this.ACSV = opts.ACSV;
    if (opts.SVA !== undefined) this.SVA = opts.SVA;
  }
}

export class EmsRecordSolar extends EmsRecord {
  constructor(opts = {}) {
    super(opts);
    if (opts.DCCD !== undefined) this.DCCD = opts.DCCD;
    if (opts.DCSV !== undefined) this.DCSV = opts.DCSV;
  }
}

// ---------------------------------------------------------------------------
// EmsReport
// ---------------------------------------------------------------------------

const EMS_REPORT_REQUIRED = [
  'ADOP', 'AMFR', 'AMOD', 'ASER', 'APQS', 'CID',
  'LDOP', 'LMFR', 'LMOD', 'LPQS', 'LSER', 'LSV',
  'EDOP', 'EMFR', 'EMOD', 'EPQS', 'ESER', 'EMSV',
];

const EMS_REPORT_OPTIONAL = [
  'AID', 'ACAT', 'LID', 'EID', 'RNAM', 'DNAM', 'FNAM', 'FID',
  'LAT', 'LNG', 'SIGN', 'EXTRA',
];

const EMS_REPORT_DATE_FIELDS = new Set(['ADOP', 'LDOP', 'EDOP']);

export class EmsReport {
  constructor(opts = {}) {
    for (const key of EMS_REPORT_REQUIRED) {
      this[key] = opts[key];
    }
    for (const key of EMS_REPORT_OPTIONAL) {
      if (opts[key] !== undefined) {
        this[key] = opts[key];
      }
    }
    this.records = opts.records || [];
  }

  toJSON() {
    const obj = {};
    for (const [k, v] of Object.entries(this)) {
      if (v === undefined || v === null) continue;
      if (k === 'records') {
        obj.records = v.map(r => (typeof r.toJSON === 'function' ? r.toJSON() : r));
      } else if (k === 'EXTRA') {
        // Only include EXTRA if it has content
        if (v && Object.keys(v).length > 0) {
          obj[k] = v;
        }
      } else if (EMS_REPORT_DATE_FIELDS.has(k)) {
        obj[k] = formatDate(v);
      } else {
        obj[k] = v;
      }
    }
    return obj;
  }
}

// ---------------------------------------------------------------------------
// RtmdRecord
// ---------------------------------------------------------------------------

const RTMD_RECORD_FIELDS = ['ABST', 'BEMD', 'TAMB', 'TVC', 'ALRM', 'EERR'];

export class RtmdRecord {
  constructor(opts = {}) {
    for (const key of RTMD_RECORD_FIELDS) {
      if (opts[key] !== undefined) {
        this[key] = opts[key];
      }
    }
    // extra='allow'
    for (const key of Object.keys(opts)) {
      if (!RTMD_RECORD_FIELDS.includes(key)) {
        this[key] = opts[key];
      }
    }
  }

  toJSON() {
    const obj = {};
    for (const [k, v] of Object.entries(this)) {
      if (v === undefined || v === null) continue;
      if (k === 'ABST') {
        obj[k] = v instanceof Date ? formatEmsDateTime(v) : v;
      } else {
        obj[k] = v;
      }
    }
    return obj;
  }
}

// ---------------------------------------------------------------------------
// RtmdReport
// ---------------------------------------------------------------------------

const RTMD_REPORT_REQUIRED = ['CID', 'EDOP', 'EMFR', 'EMOD', 'EPQS', 'ESER', 'EMSV'];
const RTMD_REPORT_OPTIONAL = [
  'ACAT', 'ADOP', 'AID', 'AMFR', 'AMOD', 'APQS', 'ASER',
  'EID', 'RNAM', 'DNAM', 'FNAM', 'FID', 'LAT', 'LNG', 'SIGN', 'EXTRA',
];
const RTMD_REPORT_DATE_FIELDS = new Set(['EDOP', 'ADOP']);

export class RtmdReport {
  constructor(opts = {}) {
    for (const key of RTMD_REPORT_REQUIRED) {
      this[key] = opts[key];
    }
    for (const key of RTMD_REPORT_OPTIONAL) {
      if (opts[key] !== undefined) {
        this[key] = opts[key];
      }
    }
    this.records = opts.records || [];
  }

  toJSON() {
    const obj = {};
    for (const [k, v] of Object.entries(this)) {
      if (v === undefined || v === null) continue;
      if (k === 'records') {
        obj.records = v.map(r => (typeof r.toJSON === 'function' ? r.toJSON() : r));
      } else if (k === 'EXTRA') {
        if (v && Object.keys(v).length > 0) {
          obj[k] = v;
        }
      } else if (RTMD_REPORT_DATE_FIELDS.has(k)) {
        obj[k] = formatDate(v);
      } else {
        obj[k] = v;
      }
    }
    return obj;
  }
}

// ---------------------------------------------------------------------------
// Transfer wrappers
// ---------------------------------------------------------------------------

export class EmsTransfer {
  constructor({ meta, data = [] }) {
    this.meta = meta instanceof TransferMetadata ? meta : new TransferMetadata(meta);
    this.data = data;
  }

  toJSON() {
    return {
      meta: this.meta.toJSON(),
      data: this.data.map(r => (typeof r.toJSON === 'function' ? r.toJSON() : r)),
    };
  }
}

export class RtmdTransfer {
  constructor({ meta, data = [] }) {
    this.meta = meta instanceof TransferMetadata ? meta : new TransferMetadata(meta);
    this.data = data;
  }

  toJSON() {
    return {
      meta: this.meta.toJSON(),
      data: this.data.map(r => (typeof r.toJSON === 'function' ? r.toJSON() : r)),
    };
  }
}
