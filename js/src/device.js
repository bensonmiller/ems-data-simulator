/**
 * Device module — slimmed-down port of utils/device.py.
 *
 * No facility/device catalogs: the game provides all metadata via config.
 */

import { SimulatedRecordSet, SimulatorState } from "./recordset.js";
import { SimulationConfig, default_config } from "./config.js";
import { RtmdReport, EmsReport } from "./schemas.js";

// ---------------------------------------------------------------------------
// Generator utilities (from utils/generator.py)
// ---------------------------------------------------------------------------

/**
 * Generate a random hex serial (UUID v4 without dashes).
 * @returns {string} 32-character hex string
 */
export function randomSerial() {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Generate a supplier-internal Appliance Monitoring ID (AMID).
 *
 * Per cce-interop, AMID references the appliance in the RTMD supplier's cloud
 * platform -- deliberately NOT the serial/asset number. A random 12-hex token
 * (e.g. "4bb74045097e") matches the schema examples; mint once per device and
 * reuse across reports to keep it stable.
 *
 * @returns {string} 12-character hex string
 */
export function randomAmid() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Build a TransferMetadata plain object.
 * @param {'rtmd'|'ems'} type
 * @returns {object}
 */
export function transferMetadata(type = "rtmd") {
  return {
    transferId: crypto.randomUUID(),
    transferSrc: "org.nhgh",
    transferredAt: new Date(),
    transferType: type === "ems" ? "ems" : "rtm",
    schemaVersion: "0.8.0",
    callbackUrl: null,
  };
}

// ---------------------------------------------------------------------------
// MonitoringDeviceConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for a virtual CCE monitoring device.
 *
 * All metadata is passed in explicitly — no random selection from catalogs.
 */
export class MonitoringDeviceConfig {
  /**
   * @param {object} opts
   * @param {'rtmd'|'ems'} opts.type - Device type.
   * @param {number} opts.uploadInterval - Seconds between uploads.
   * @param {number} opts.sampleInterval - Seconds between samples.
   * @param {'mains'|'solar'} [opts.powerType='mains'] - Power source.
   *
   * Appliance identity:
   * @param {string} opts.amfr - Appliance manufacturer.
   * @param {string} opts.amod - Appliance model.
   * @param {string} [opts.apqs] - Appliance PQS code.
   * @param {string} [opts.aser] - Appliance serial (auto-generated if omitted).
   * @param {string} [opts.adop] - Appliance date of placement (YYYY-MM-DD).
   *
   * Logger identity (RTMD only — ignored for EMS):
   * @param {string} [opts.lmfr] - Logger manufacturer.
   * @param {string} [opts.lmod] - Logger model.
   * @param {string} [opts.lpqs] - Logger PQS code.
   * @param {string} [opts.lser] - Logger serial (auto-generated if omitted).
   * @param {string} [opts.ldop] - Logger date of placement.
   *
   * Facility:
   * @param {string} [opts.cid] - Country ISO code.
   * @param {number} [opts.lat] - Latitude.
   * @param {number} [opts.lng] - Longitude.
   *
   * @param {SimulationConfig} [opts.simConfig] - Override simulation config.
   */
  constructor({
    type,
    uploadInterval,
    sampleInterval,
    powerType = "mains",

    amfr,
    amod,
    apqs = null,
    aser = null,
    adop = null,

    lmfr = null,
    lmod = null,
    lpqs = null,
    lser = null,
    ldop = null,

    cid = null,
    lat = null,
    lng = null,

    simConfig = null,
  }) {
    if (!type || !["rtmd", "ems"].includes(type)) {
      throw new Error(`type must be 'rtmd' or 'ems', got '${type}'`);
    }
    if (uploadInterval < sampleInterval) {
      throw new Error("uploadInterval must be >= sampleInterval");
    }
    if (uploadInterval % sampleInterval !== 0) {
      throw new Error("uploadInterval must be a multiple of sampleInterval");
    }

    this.type = type;
    this.uploadInterval = uploadInterval;
    this.sampleInterval = sampleInterval;
    this.powerType = powerType;
    this.batchSize = uploadInterval / sampleInterval;

    // Appliance
    this.amfr = amfr;
    this.amod = amod;
    this.apqs = apqs;
    this.aser = aser;
    this.adop = adop;

    // Logger (separate identity for RTMD; mirrors appliance for EMS)
    this.lmfr = lmfr;
    this.lmod = lmod;
    this.lpqs = lpqs;
    this.lser = lser;
    this.ldop = ldop;

    // Facility
    this.cid = cid;
    this.lat = lat;
    this.lng = lng;

    // Simulation config
    this.simConfig = simConfig;
  }
}

// ---------------------------------------------------------------------------
// BaseRtmDevice
// ---------------------------------------------------------------------------

/**
 * A simulated RTMD or EMS monitoring device.
 *
 * Call createReport(reportTime) repeatedly to produce sequential reports
 * with thermal state continuity.
 */
export class BaseRtmDevice {
  /**
   * @param {MonitoringDeviceConfig} config
   */
  constructor(config) {
    this.config = config;
    this.lastSampleTime = null;
    this.simulatorState = null;

    // Build simulation config
    this.simConfig =
      config.simConfig ??
      default_config(config.powerType, config.lat);
    this.simConfig.sample_interval = config.sampleInterval;

    // Appliance identity
    this.amfr = config.amfr;
    this.amod = config.amod;
    this.apqs = config.apqs;
    this.aser = config.aser ?? randomSerial();
    this.adop = config.adop ?? _mockAdop();

    // Logger / EMD identity
    if (config.type === "rtmd") {
      this.lmfr = config.lmfr;
      this.lmod = config.lmod;
      this.lpqs = config.lpqs;
    } else {
      // EMS: logger = appliance
      this.lmfr = this.amfr;
      this.lmod = this.amod;
      this.lpqs = this.apqs;
    }
    this.lser = config.lser ?? randomSerial();
    this.ldop = config.ldop ?? this.adop;
    this.lsv = "0.1.x";

    // EMD mirrors logger
    this.emfr = this.lmfr;
    this.emod = this.lmod;
    this.epqs = this.lpqs;
    this.eser = this.lser;
    this.edop = this.ldop;
    this.emsv = this.lsv;

    // Facility
    this.cid = config.cid;
    this.lat = config.lat;
    this.lng = config.lng;

    // Supplier-internal appliance monitoring id, minted once and held stable
    // across all reports this device produces.
    this.amid = randomAmid();
  }

  /**
   * Build the cce-interop DLST: maps the performance properties this RTMD
   * reports (TVC, TAMB) to sensor definitions. The sensor maker mirrors the
   * EMD/logger manufacturer (EMFR); SIDs are the logger serial plus a sensor
   * port, per the schema's $comment.
   *
   * @returns {object}
   */
  _buildDlst() {
    return {
      TVC: {
        SID: `${this.eser}-P1`,
        SMFR: this.emfr,
        SMOD: `${this.emod} External Probe`,
        SDOP: this.edop,
      },
      TAMB: {
        SID: `${this.eser}-P2`,
        SMFR: this.emfr,
        SMOD: `${this.emod} Onboard Sensor`,
        SDOP: this.edop,
      },
    };
  }

  /**
   * Create a report covering the period since the last report.
   *
   * @param {Date} reportTime - End of the reporting window (defaults to now).
   * @returns {RtmdReport|EmsReport}
   */
  createReport(reportTime = null) {
    if (reportTime === null) {
      reportTime = new Date();
    }
    if (!(reportTime instanceof Date)) {
      throw new Error("reportTime must be a Date");
    }

    if (this.lastSampleTime === null) {
      this.lastSampleTime = new Date(
        reportTime.getTime() - this.config.uploadInterval * 1000,
      );
    }

    if (this.lastSampleTime >= reportTime) {
      throw new Error(
        "reportTime must be after the last sample time",
      );
    }

    const gapMs = reportTime.getTime() - this.lastSampleTime.getTime();
    const batchSize = Math.floor(gapMs / (this.config.sampleInterval * 1000));
    const firstRecordTime = new Date(
      this.lastSampleTime.getTime() + this.config.sampleInterval * 1000,
    );

    // Generate simulated records
    const recordset = SimulatedRecordSet.generate(
      this.simConfig,
      batchSize,
      firstRecordTime,
      this.config.sampleInterval,
      this.simulatorState,
    );
    this.simulatorState = recordset.state;

    const reportObj = {
      CID: this.cid,
      ADOP: this.adop,
      AMFR: this.amfr,
      AMOD: this.amod,
      APQS: this.apqs,
      ASER: this.aser,
      EDOP: this.edop,
      EMFR: this.emfr,
      EMOD: this.emod,
      EPQS: this.epqs,
      ESER: this.eser,
      EMSV: this.emsv,
      LDOP: this.ldop,
      LMFR: this.lmfr,
      LMOD: this.lmod,
      LPQS: this.lpqs,
      LSER: this.lser,
      LSV: this.lsv,
      LAT: this.lat,
      LNG: this.lng,
    };

    let report;
    if (this.config.type === "rtmd") {
      reportObj.AMID = this.amid;
      reportObj.DLST = this._buildDlst();
      reportObj.records = recordset.toRtmd();
      report = new RtmdReport(reportObj);
    } else {
      reportObj.records = recordset.toEms(this.config.powerType);
      report = new EmsReport(reportObj);
    }

    // Advance last sample time
    this.lastSampleTime = new Date(
      this.lastSampleTime.getTime() + batchSize * this.config.sampleInterval * 1000,
    );

    return report;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a random YYYY-MM-DD date between 2018-01-01 and 2024-12-31.
 * @returns {string}
 */
function _mockAdop() {
  const start = new Date("2018-01-01").getTime();
  const end = new Date("2024-12-31").getTime();
  const d = new Date(start + Math.random() * (end - start));
  return d.toISOString().slice(0, 10);
}
