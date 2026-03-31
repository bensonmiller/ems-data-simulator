import { describe, it, expect } from "vitest";
import {
  MonitoringDeviceConfig,
  BaseRtmDevice,
  randomSerial,
  transferMetadata,
} from "./device.js";
import { RtmdReport, EmsReport, RtmdRecord } from "./schemas.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides = {}) {
  return new MonitoringDeviceConfig({
    type: "rtmd",
    uploadInterval: 3600,
    sampleInterval: 900,
    powerType: "mains",
    amfr: "Vestfrost",
    amod: "VLS-054",
    apqs: "E003/034",
    cid: "KEN",
    lat: -1.3,
    lng: 36.8,
    lmfr: "B Medical",
    lmod: "WT-100",
    lpqs: "E006/001",
    ...overrides,
  });
}

function makeEmsConfig(overrides = {}) {
  return new MonitoringDeviceConfig({
    type: "ems",
    uploadInterval: 3600,
    sampleInterval: 900,
    powerType: "mains",
    amfr: "Haier",
    amod: "HBC-200",
    apqs: "E003/100",
    cid: "NGA",
    lat: 9.0,
    lng: 7.5,
    ...overrides,
  });
}

const REPORT_TIME = new Date("2024-06-15T12:00:00Z");

// ---------------------------------------------------------------------------
// MonitoringDeviceConfig
// ---------------------------------------------------------------------------

describe("MonitoringDeviceConfig", () => {
  it("derives batchSize from uploadInterval / sampleInterval", () => {
    const cfg = makeConfig();
    expect(cfg.batchSize).toBe(4); // 3600 / 900
  });

  it("derives batchSize for different intervals", () => {
    const cfg = makeConfig({ uploadInterval: 7200, sampleInterval: 600 });
    expect(cfg.batchSize).toBe(12);
  });

  it("throws when uploadInterval < sampleInterval", () => {
    expect(() => makeConfig({ uploadInterval: 300, sampleInterval: 900 })).toThrow();
  });

  it("throws when uploadInterval is not a multiple of sampleInterval", () => {
    expect(() => makeConfig({ uploadInterval: 1000, sampleInterval: 900 })).toThrow();
  });

  it("throws for invalid type", () => {
    expect(() => makeConfig({ type: "foo" })).toThrow();
  });

  it("stores all metadata fields", () => {
    const cfg = makeConfig();
    expect(cfg.type).toBe("rtmd");
    expect(cfg.amfr).toBe("Vestfrost");
    expect(cfg.amod).toBe("VLS-054");
    expect(cfg.apqs).toBe("E003/034");
    expect(cfg.cid).toBe("KEN");
    expect(cfg.lat).toBe(-1.3);
    expect(cfg.lng).toBe(36.8);
    expect(cfg.lmfr).toBe("B Medical");
    expect(cfg.lmod).toBe("WT-100");
  });

  it("uses default simConfig when not provided", () => {
    const cfg = makeConfig();
    expect(cfg.simConfig).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BaseRtmDevice — RTMD
// ---------------------------------------------------------------------------

describe("BaseRtmDevice (RTMD)", () => {
  it("initializes with correct metadata", () => {
    const dev = new BaseRtmDevice(makeConfig());
    expect(dev.amfr).toBe("Vestfrost");
    expect(dev.amod).toBe("VLS-054");
    expect(dev.cid).toBe("KEN");
    expect(dev.simulatorState).toBeNull();
    // RTMD: logger has its own identity
    expect(dev.lmfr).toBe("B Medical");
    expect(dev.lmod).toBe("WT-100");
  });

  it("auto-generates aser and lser when not provided", () => {
    const dev = new BaseRtmDevice(makeConfig());
    expect(dev.aser).toMatch(/^[0-9a-f]{32}$/);
    expect(dev.lser).toMatch(/^[0-9a-f]{32}$/);
    expect(dev.aser).not.toBe(dev.lser);
  });

  it("createReport returns an RtmdReport with correct structure", () => {
    const dev = new BaseRtmDevice(makeConfig());
    const report = dev.createReport(REPORT_TIME);

    expect(report).toBeInstanceOf(RtmdReport);
    expect(report.CID).toBe("KEN");
    expect(report.AMFR).toBe("Vestfrost");
    expect(report.AMOD).toBe("VLS-054");
    expect(report.APQS).toBe("E003/034");
    expect(report.EMFR).toBe("B Medical");
    expect(report.EMOD).toBe("WT-100");
    expect(report.records).toHaveLength(4); // 3600/900
  });

  it("report records have RTMD fields", () => {
    const dev = new BaseRtmDevice(makeConfig());
    const report = dev.createReport(REPORT_TIME);
    const rec = report.records[0];

    expect(rec).toBeInstanceOf(RtmdRecord);
    expect(rec.ABST).toBeInstanceOf(Date);
    expect(typeof rec.TVC).toBe("number");
    expect(typeof rec.TAMB).toBe("number");
    expect(typeof rec.BEMD).toBe("number");
  });

  it("RTMD report has separate logger metadata from appliance", () => {
    const dev = new BaseRtmDevice(makeConfig());
    const report = dev.createReport(REPORT_TIME);
    // Logger identity comes from the RTMD device, not the appliance
    expect(report.EMFR).toBe("B Medical");
    expect(report.AMFR).toBe("Vestfrost");
    expect(report.EMFR).not.toBe(report.AMFR);
  });
});

// ---------------------------------------------------------------------------
// BaseRtmDevice — EMS
// ---------------------------------------------------------------------------

describe("BaseRtmDevice (EMS)", () => {
  it("EMS logger mirrors appliance identity", () => {
    const dev = new BaseRtmDevice(makeEmsConfig());
    expect(dev.lmfr).toBe(dev.amfr);
    expect(dev.lmod).toBe(dev.amod);
    expect(dev.lpqs).toBe(dev.apqs);
    // EMD also mirrors
    expect(dev.emfr).toBe(dev.amfr);
    expect(dev.emod).toBe(dev.amod);
  });

  it("createReport returns an EmsReport", () => {
    const dev = new BaseRtmDevice(makeEmsConfig());
    const report = dev.createReport(REPORT_TIME);

    expect(report).toBeInstanceOf(EmsReport);
    expect(report.CID).toBe("NGA");
    expect(report.AMFR).toBe("Haier");
    expect(report.AMOD).toBe("HBC-200");
    expect(report.LMFR).toBe("Haier"); // mirrors appliance
    expect(report.records).toHaveLength(4);
  });

  it("EMS report metadata: ADOP, ASER, APQS present", () => {
    const dev = new BaseRtmDevice(makeEmsConfig());
    const report = dev.createReport(REPORT_TIME);
    expect(report.ADOP).toBeDefined();
    expect(report.ASER).toBeDefined();
    expect(report.APQS).toBe("E003/100");
  });

  it("EMS records have correct field types", () => {
    const dev = new BaseRtmDevice(makeEmsConfig());
    const report = dev.createReport(REPORT_TIME);
    const rec = report.records[0];

    expect(rec.ABST).toBeInstanceOf(Date);
    expect(typeof rec.TVC).toBe("number");
    expect(typeof rec.TAMB).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Sequential reports — state continuity
// ---------------------------------------------------------------------------

describe("Sequential reports", () => {
  it("state persists between createReport calls", () => {
    const dev = new BaseRtmDevice(makeConfig());
    let t = new Date(REPORT_TIME);

    const reports = [];
    for (let i = 0; i < 5; i++) {
      reports.push(dev.createReport(t));
      t = new Date(t.getTime() + 3600_000);
    }

    expect(dev.simulatorState).not.toBeNull();
    for (const r of reports) {
      expect(r.records).toHaveLength(4);
    }
  });

  it("record timestamps are correctly spaced", () => {
    const dev = new BaseRtmDevice(makeEmsConfig());
    const report = dev.createReport(REPORT_TIME);
    const timestamps = report.records.map((r) => r.ABST.getTime());

    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] - timestamps[i - 1]).toBe(900_000);
    }
  });

  it("TVC stays in reasonable range over many reports", () => {
    const dev = new BaseRtmDevice(makeEmsConfig());
    let t = new Date(REPORT_TIME);
    const allTvcs = [];

    for (let i = 0; i < 10; i++) {
      const report = dev.createReport(t);
      for (const rec of report.records) {
        allTvcs.push(rec.TVC);
      }
      t = new Date(t.getTime() + 3600_000);
    }

    expect(Math.min(...allTvcs)).toBeGreaterThan(-10);
    expect(Math.max(...allTvcs)).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------------------
// transferMetadata / randomSerial
// ---------------------------------------------------------------------------

describe("transferMetadata", () => {
  it("returns correct structure for RTMD", () => {
    const meta = transferMetadata("rtmd");
    expect(meta.transferId).toBeDefined();
    expect(meta.transferSrc).toBe("org.nhgh");
    expect(meta.schemaVersion).toBe("rtm:1.0");
    expect(meta.callbackUrl).toBeNull();
    expect(meta.transferredAt).toBeInstanceOf(Date);
  });

  it("returns ems:1.0 schema version for EMS", () => {
    const meta = transferMetadata("ems");
    expect(meta.schemaVersion).toBe("ems:1.0");
  });
});

describe("randomSerial", () => {
  it("returns a 32-char hex string", () => {
    const s = randomSerial();
    expect(s).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates unique values", () => {
    const a = randomSerial();
    const b = randomSerial();
    expect(a).not.toBe(b);
  });
});
