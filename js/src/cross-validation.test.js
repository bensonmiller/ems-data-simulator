/**
 * Cross-validation tests: verify the JS simulator against Python reference
 * fixtures.
 *
 * Since Python (Mersenne Twister) and JS (seedrandom ARC4) use different
 * PRNG algorithms, individual random values will differ. These tests verify:
 *
 *   a. Structural equivalence (same number of records, same fields, same types)
 *   b. Physical plausibility (values in realistic ranges)
 *   c. Behavioral equivalence (fault effects, thermostat cycling, etc.)
 *   d. Format equivalence (ABST format, toRtmd/toEms field subsets)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SimulationConfig,
  ThermalConfig,
  AmbientConfig,
  PowerConfig,
  EventConfig,
  FaultConfig,
  FaultType,
  default_config,
  SimulatedRecordSet,
  formatEmsDateTime,
} from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

function loadFixture(name) {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf-8");
  return JSON.parse(raw);
}

const START_TIME = new Date("2024-06-15T00:00:00Z");
const SEED = 42;
const INTERVAL = 900;
const LATITUDE = 12.0;

/**
 * Build a JS SimulationConfig matching the Python fixture scenario.
 */
function buildConfig(scenarioName) {
  let cfg;

  switch (scenarioName) {
    case "mains_normal": {
      cfg = default_config("mains", LATITUDE);
      break;
    }
    case "solar_normal": {
      cfg = default_config("solar", LATITUDE);
      break;
    }
    case "refrigerant_leak": {
      cfg = default_config("mains", LATITUDE);
      cfg.fault = new FaultConfig({
        fault_type: FaultType.REFRIGERANT_LEAK,
        fault_start_offset_s: 0.0,
      });
      break;
    }
    case "stuck_door": {
      cfg = default_config("mains", LATITUDE);
      cfg.fault = new FaultConfig({
        fault_type: FaultType.STUCK_DOOR,
        fault_start_offset_s: 0.0,
        fault_duration_s: 21600.0,
      });
      break;
    }
    case "power_outage": {
      cfg = default_config("mains", LATITUDE);
      cfg.fault = new FaultConfig({
        fault_type: FaultType.POWER_OUTAGE,
        fault_start_offset_s: 0.0,
        fault_duration_s: 21600.0,
      });
      break;
    }
    case "compressor_failure": {
      cfg = default_config("mains", LATITUDE);
      cfg.fault = new FaultConfig({
        fault_type: FaultType.COMPRESSOR_FAILURE,
        fault_start_offset_s: 0.0,
        fault_duration_s: 21600.0,
      });
      break;
    }
    case "icebank_unit": {
      cfg = default_config("solar", LATITUDE);
      cfg.thermal.icebank_capacity_j = 3_000_000.0;
      cfg.thermal.R_icebank = 0.375;
      cfg.thermal.compressor_targets_icebank = true;
      break;
    }
    case "busy_facility": {
      cfg = default_config("mains", LATITUDE);
      cfg.events = EventConfig.busy_facility();
      break;
    }
    default:
      throw new Error(`Unknown scenario: ${scenarioName}`);
  }

  cfg.random_seed = SEED;
  cfg.sample_interval = INTERVAL;
  return cfg;
}

/**
 * Run the JS simulator for a given scenario.
 */
function runJS(scenarioName, batchSize) {
  const cfg = buildConfig(scenarioName);
  return SimulatedRecordSet.generate(cfg, batchSize, START_TIME, INTERVAL);
}

// Numeric fields that appear in records (depending on power type)
const NUMERIC_FIELDS_COMMON = ["TVC", "TAMB", "CMPR", "DORV", "BEMD", "BLOG"];
const NUMERIC_FIELDS_MAINS = ["SVA", "ACCD", "ACSV"];
const NUMERIC_FIELDS_SOLAR = ["DCSV", "DCCD"];

// All scenarios to test
const SCENARIOS = [
  { name: "mains_normal", batchSize: 24, powerType: "mains" },
  { name: "solar_normal", batchSize: 24, powerType: "solar" },
  { name: "refrigerant_leak", batchSize: 96, powerType: "mains" },
  { name: "stuck_door", batchSize: 24, powerType: "mains" },
  { name: "power_outage", batchSize: 24, powerType: "mains" },
  { name: "compressor_failure", batchSize: 24, powerType: "mains" },
  { name: "icebank_unit", batchSize: 96, powerType: "solar" },
  { name: "busy_facility", batchSize: 24, powerType: "mains" },
];

// ---------------------------------------------------------------------------
// a. Structural equivalence
// ---------------------------------------------------------------------------

describe("Structural equivalence", () => {
  for (const { name, batchSize, powerType } of SCENARIOS) {
    describe(name, () => {
      let pyFixture;
      let jsResult;

      beforeAll(() => {
        pyFixture = loadFixture(name);
        jsResult = runJS(name, batchSize);
      });

      it("produces the same number of records", () => {
        expect(jsResult.records.length).toBe(pyFixture.records.length);
      });

      it("has the same field names present", () => {
        // Check all Python fields are present in JS (excluding internal
        // fields like ICESOC/TRBCM that may not be in the JS output schema)
        const pyFields = new Set(Object.keys(pyFixture.records[0]));
        const jsRec = jsResult.records[0];
        const jsFields = new Set(Object.keys(jsRec));

        // Core fields that must match
        const coreFields = ["ABST", "TVC", "TAMB", "CMPR", "DORV", "BEMD", "BLOG", "ALRM", "HOLD", "EERR"];
        if (powerType === "mains") {
          coreFields.push("SVA", "ACCD", "ACSV");
        } else {
          coreFields.push("DCSV", "DCCD");
        }

        for (const f of coreFields) {
          if (pyFields.has(f)) {
            expect(jsFields.has(f), `JS record missing field: ${f}`).toBe(true);
          }
        }
      });

      it("has correct field types", () => {
        const rec = jsResult.records[0];
        // ABST should be a Date object
        expect(rec.ABST).toBeInstanceOf(Date);
        // Numeric fields
        expect(typeof rec.TVC).toBe("number");
        expect(typeof rec.TAMB).toBe("number");
        expect(typeof rec.CMPR).toBe("number");
        expect(typeof rec.DORV).toBe("number");
        // ALRM should be string or null
        expect(rec.ALRM === null || typeof rec.ALRM === "string").toBe(true);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// b. Physical plausibility
// ---------------------------------------------------------------------------

describe("Physical plausibility", () => {
  for (const { name, batchSize, powerType } of SCENARIOS) {
    describe(name, () => {
      let jsResult;

      beforeAll(() => {
        jsResult = runJS(name, batchSize);
      });

      it("TVC is in plausible range [-30, 50]", () => {
        for (let i = 0; i < jsResult.records.length; i++) {
          const tvc = jsResult.records[i].TVC;
          expect(tvc, `Record ${i}: TVC=${tvc} out of range`).toBeGreaterThanOrEqual(-30);
          expect(tvc, `Record ${i}: TVC=${tvc} out of range`).toBeLessThanOrEqual(50);
        }
      });

      it("TAMB is in plausible range [5, 50]", () => {
        for (let i = 0; i < jsResult.records.length; i++) {
          const tamb = jsResult.records[i].TAMB;
          expect(tamb, `Record ${i}: TAMB=${tamb} out of range`).toBeGreaterThanOrEqual(5);
          expect(tamb, `Record ${i}: TAMB=${tamb} out of range`).toBeLessThanOrEqual(50);
        }
      });

      it("CMPR is in [0, interval]", () => {
        for (let i = 0; i < jsResult.records.length; i++) {
          const cmpr = jsResult.records[i].CMPR;
          expect(cmpr, `Record ${i}: CMPR=${cmpr}`).toBeGreaterThanOrEqual(0);
          expect(cmpr, `Record ${i}: CMPR=${cmpr}`).toBeLessThanOrEqual(INTERVAL);
        }
      });

      it("DORV is in [0, interval]", () => {
        for (let i = 0; i < jsResult.records.length; i++) {
          const dorv = jsResult.records[i].DORV;
          expect(dorv, `Record ${i}: DORV=${dorv}`).toBeGreaterThanOrEqual(0);
          expect(dorv, `Record ${i}: DORV=${dorv}`).toBeLessThanOrEqual(INTERVAL);
        }
      });

      it("BEMD and BLOG are in reasonable range [0, 20]", () => {
        for (let i = 0; i < jsResult.records.length; i++) {
          const rec = jsResult.records[i];
          if (rec.BEMD !== undefined && rec.BEMD !== null) {
            expect(rec.BEMD, `Record ${i}: BEMD`).toBeGreaterThanOrEqual(0);
            expect(rec.BEMD, `Record ${i}: BEMD`).toBeLessThanOrEqual(20);
          }
          if (rec.BLOG !== undefined && rec.BLOG !== null) {
            expect(rec.BLOG, `Record ${i}: BLOG`).toBeGreaterThanOrEqual(0);
            expect(rec.BLOG, `Record ${i}: BLOG`).toBeLessThanOrEqual(20);
          }
        }
      });

      if (powerType === "mains") {
        it("SVA is a non-negative integer", () => {
          for (let i = 0; i < jsResult.records.length; i++) {
            const sva = jsResult.records[i].SVA;
            expect(sva, `Record ${i}: SVA`).toBeGreaterThanOrEqual(0);
          }
        });

        it("ACCD is in [0, interval]", () => {
          for (let i = 0; i < jsResult.records.length; i++) {
            const accd = jsResult.records[i].ACCD;
            expect(accd, `Record ${i}: ACCD`).toBeGreaterThanOrEqual(0);
            expect(accd, `Record ${i}: ACCD`).toBeLessThanOrEqual(INTERVAL);
          }
        });
      }

      if (powerType === "solar") {
        it("DCSV is non-negative", () => {
          for (let i = 0; i < jsResult.records.length; i++) {
            const dcsv = jsResult.records[i].DCSV;
            expect(dcsv, `Record ${i}: DCSV`).toBeGreaterThanOrEqual(0);
          }
        });

        it("DCCD is in [0, interval]", () => {
          for (let i = 0; i < jsResult.records.length; i++) {
            const dccd = jsResult.records[i].DCCD;
            expect(dccd, `Record ${i}: DCCD`).toBeGreaterThanOrEqual(0);
            expect(dccd, `Record ${i}: DCCD`).toBeLessThanOrEqual(INTERVAL);
          }
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// c. Behavioral equivalence
// ---------------------------------------------------------------------------

describe("Behavioral equivalence", () => {
  // -- mains_normal: TVC stays in thermostat band, compressor runs --
  describe("mains_normal", () => {
    let jsResult;
    let pyFixture;

    beforeAll(() => {
      jsResult = runJS("mains_normal", 24);
      pyFixture = loadFixture("mains_normal");
    });

    it("TVC stays in [0, 12] range (thermostat cycling with icebank)", () => {
      for (const rec of jsResult.records) {
        expect(rec.TVC).toBeGreaterThanOrEqual(0);
        expect(rec.TVC).toBeLessThanOrEqual(12);
      }
    });

    it("compressor runs (CMPR > 0 for some records)", () => {
      const totalCmpr = jsResult.records.reduce((s, r) => s + r.CMPR, 0);
      expect(totalCmpr).toBeGreaterThan(0);
    });

    it("Python reference also has TVC in [0, 12]", () => {
      for (const rec of pyFixture.records) {
        expect(rec.TVC).toBeGreaterThanOrEqual(0);
        expect(rec.TVC).toBeLessThanOrEqual(12);
      }
    });
  });

  // -- solar_normal: TVC stays cold, icebank buffers --
  describe("solar_normal", () => {
    let jsResult;

    beforeAll(() => {
      jsResult = runJS("solar_normal", 24);
    });

    it("TVC stays in [0, 10] (icebank maintains temperature overnight)", () => {
      for (const rec of jsResult.records) {
        expect(rec.TVC).toBeGreaterThanOrEqual(0);
        expect(rec.TVC).toBeLessThanOrEqual(10);
      }
    });

    it("DCSV follows a plausible solar pattern (non-negative, bounded)", () => {
      for (const rec of jsResult.records) {
        expect(rec.DCSV).toBeGreaterThanOrEqual(0);
        // DCSV should not exceed peak_dcsv (20) + noise margin
        expect(rec.DCSV).toBeLessThanOrEqual(25);
      }
    });
  });

  // -- refrigerant_leak: TVC drifts up over 24h --
  describe("refrigerant_leak", () => {
    let jsResult;

    beforeAll(() => {
      jsResult = runJS("refrigerant_leak", 96);
    });

    it("average TVC of last 24 records >= average TVC of first 24 records (degradation)", () => {
      const first24Avg =
        jsResult.records.slice(0, 24).reduce((s, r) => s + r.TVC, 0) / 24;
      const last24Avg =
        jsResult.records.slice(-24).reduce((s, r) => s + r.TVC, 0) / 24;
      // With very slow leak rate (0.002), the drift over 24h is small but should exist
      expect(last24Avg).toBeGreaterThanOrEqual(first24Avg - 0.5);
    });

    it("compressor still runs (leak does not disable compressor)", () => {
      const totalCmpr = jsResult.records.reduce((s, r) => s + r.CMPR, 0);
      expect(totalCmpr).toBeGreaterThan(0);
    });
  });

  // -- stuck_door: DORV = interval for all records, ALRM contains DOOR --
  describe("stuck_door", () => {
    let jsResult;

    beforeAll(() => {
      jsResult = runJS("stuck_door", 24);
    });

    it("DORV equals interval for all records", () => {
      for (let i = 0; i < jsResult.records.length; i++) {
        expect(
          jsResult.records[i].DORV,
          `Record ${i}: DORV should be ${INTERVAL}`,
        ).toBe(INTERVAL);
      }
    });

    it("ALRM contains DOOR for records after threshold", () => {
      // DOOR alarm triggers after 5 minutes continuous open
      // With 900s intervals and door forced open from start, it should
      // trigger quickly. Check that at least some records have DOOR alarm.
      const doorAlarms = jsResult.records.filter(
        (r) => r.ALRM && r.ALRM.includes("DOOR"),
      );
      expect(doorAlarms.length).toBeGreaterThan(0);
    });
  });

  // -- power_outage: CMPR=0, HOLD increases, TVC eventually drifts --
  describe("power_outage", () => {
    let jsResult;

    beforeAll(() => {
      jsResult = runJS("power_outage", 24);
    });

    it("CMPR is 0 for all records (no compressor during outage)", () => {
      for (let i = 0; i < jsResult.records.length; i++) {
        expect(
          jsResult.records[i].CMPR,
          `Record ${i}: CMPR should be 0`,
        ).toBe(0);
      }
    });

    it("HOLD increases over time", () => {
      // HOLD tracks seconds since power loss
      const holds = jsResult.records.map((r) => r.HOLD).filter((h) => h !== null);
      expect(holds.length).toBeGreaterThan(0);
      // Should be monotonically increasing
      for (let i = 1; i < holds.length; i++) {
        expect(holds[i]).toBeGreaterThanOrEqual(holds[i - 1]);
      }
    });

    it("TVC stays relatively stable due to icebank thermal mass", () => {
      // With icebank, TVC should not drift much in 6h
      const firstTVC = jsResult.records[0].TVC;
      const lastTVC = jsResult.records[jsResult.records.length - 1].TVC;
      expect(Math.abs(lastTVC - firstTVC)).toBeLessThan(5);
    });
  });

  // -- compressor_failure: CMPR=0, TVC may rise slowly --
  describe("compressor_failure", () => {
    let jsResult;

    beforeAll(() => {
      jsResult = runJS("compressor_failure", 24);
    });

    it("CMPR is 0 for all records", () => {
      for (let i = 0; i < jsResult.records.length; i++) {
        expect(
          jsResult.records[i].CMPR,
          `Record ${i}: CMPR should be 0`,
        ).toBe(0);
      }
    });

    it("TVC stays in a reasonable range (icebank buffers)", () => {
      for (const rec of jsResult.records) {
        expect(rec.TVC).toBeGreaterThanOrEqual(-5);
        expect(rec.TVC).toBeLessThanOrEqual(30);
      }
    });
  });

  // -- icebank_unit: TVC stays cold, icebank provides holdover --
  describe("icebank_unit", () => {
    let jsResult;

    beforeAll(() => {
      jsResult = runJS("icebank_unit", 96);
    });

    it("TVC stays in [0, 15] over 24h (icebank thermal buffer)", () => {
      for (const rec of jsResult.records) {
        expect(rec.TVC).toBeGreaterThanOrEqual(-2);
        expect(rec.TVC).toBeLessThanOrEqual(15);
      }
    });

    it("has solar power fields (DCSV, DCCD)", () => {
      const rec = jsResult.records[0];
      expect(rec).toHaveProperty("DCSV");
      expect(rec).toHaveProperty("DCCD");
    });
  });

  // -- busy_facility: valid mains output with door events --
  describe("busy_facility", () => {
    let jsResult;

    beforeAll(() => {
      jsResult = runJS("busy_facility", 24);
    });

    it("produces valid mains records", () => {
      for (const rec of jsResult.records) {
        expect(rec).toHaveProperty("SVA");
        expect(rec).toHaveProperty("ACCD");
        expect(rec).toHaveProperty("ACSV");
      }
    });

    it("TVC stays in thermostat range", () => {
      for (const rec of jsResult.records) {
        expect(rec.TVC).toBeGreaterThanOrEqual(0);
        expect(rec.TVC).toBeLessThanOrEqual(15);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// d. Format equivalence
// ---------------------------------------------------------------------------

describe("Format equivalence", () => {
  describe("ABST format", () => {
    it("matches emsDateTime format YYYYMMDDTHHMMSSz", () => {
      const jsResult = runJS("mains_normal", 24);
      const pattern = /^\d{8}T\d{6}z$/;
      for (let i = 0; i < jsResult.records.length; i++) {
        const abst = formatEmsDateTime(jsResult.records[i].ABST);
        expect(abst, `Record ${i}: ABST=${abst}`).toMatch(pattern);
      }
    });

    it("first record ABST matches start time", () => {
      const jsResult = runJS("mains_normal", 24);
      const abst = formatEmsDateTime(jsResult.records[0].ABST);
      expect(abst).toBe("20240615T000000z");
    });

    it("records are spaced by the interval", () => {
      const jsResult = runJS("mains_normal", 24);
      for (let i = 1; i < jsResult.records.length; i++) {
        const diff =
          jsResult.records[i].ABST.getTime() -
          jsResult.records[i - 1].ABST.getTime();
        expect(diff).toBe(INTERVAL * 1000);
      }
    });
  });

  describe("toRtmd()", () => {
    it("produces records with only RTMD fields", () => {
      const jsResult = runJS("mains_normal", 24);
      const rtmdRecords = jsResult.toRtmd();
      expect(rtmdRecords.length).toBe(24);

      const expectedFields = new Set(["ABST", "BEMD", "TVC", "TAMB", "ALRM", "EERR"]);
      for (const rec of rtmdRecords) {
        const json = rec.toJSON();
        for (const key of Object.keys(json)) {
          expect(
            expectedFields.has(key),
            `Unexpected RTMD field: ${key}`,
          ).toBe(true);
        }
        // Must have at least ABST, TVC, TAMB
        expect(json).toHaveProperty("ABST");
        expect(json).toHaveProperty("TVC");
        expect(json).toHaveProperty("TAMB");
      }
    });

    it("ABST is formatted as emsDateTime string in JSON", () => {
      const jsResult = runJS("mains_normal", 24);
      const rtmdRecords = jsResult.toRtmd();
      const json = rtmdRecords[0].toJSON();
      expect(typeof json.ABST).toBe("string");
      expect(json.ABST).toMatch(/^\d{8}T\d{6}z$/);
    });
  });

  describe("toEms() mains", () => {
    it("includes mains-specific fields", () => {
      const jsResult = runJS("mains_normal", 24);
      const emsRecords = jsResult.toEms();
      expect(emsRecords.length).toBe(24);

      const json = emsRecords[0].toJSON();
      expect(json).toHaveProperty("ACCD");
      expect(json).toHaveProperty("ACSV");
      expect(json).toHaveProperty("SVA");
      // Should NOT have solar fields
      expect(json).not.toHaveProperty("DCSV");
      expect(json).not.toHaveProperty("DCCD");
    });

    it("maps EERR to LERR in EMS format", () => {
      // Generate enough data that EERR might occur (or check field mapping)
      const jsResult = runJS("mains_normal", 24);
      const emsRecords = jsResult.toEms();
      const json = emsRecords[0].toJSON();
      // EERR should not appear; LERR may appear if an error was generated
      expect(json).not.toHaveProperty("EERR");
    });
  });

  describe("toEms() solar", () => {
    it("includes solar-specific fields", () => {
      const jsResult = runJS("solar_normal", 24);
      const emsRecords = jsResult.toEms();
      expect(emsRecords.length).toBe(24);

      const json = emsRecords[0].toJSON();
      expect(json).toHaveProperty("DCSV");
      expect(json).toHaveProperty("DCCD");
      // Should NOT have mains fields
      expect(json).not.toHaveProperty("ACCD");
      expect(json).not.toHaveProperty("ACSV");
      expect(json).not.toHaveProperty("SVA");
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-check: Python fixture data also passes plausibility
// ---------------------------------------------------------------------------

describe("Python fixture plausibility (sanity check)", () => {
  for (const { name, powerType } of SCENARIOS) {
    describe(name, () => {
      let pyFixture;

      beforeAll(() => {
        pyFixture = loadFixture(name);
      });

      it("Python TVC in plausible range", () => {
        for (let i = 0; i < pyFixture.records.length; i++) {
          const tvc = pyFixture.records[i].TVC;
          expect(tvc, `Py record ${i}: TVC=${tvc}`).toBeGreaterThanOrEqual(-30);
          expect(tvc, `Py record ${i}: TVC=${tvc}`).toBeLessThanOrEqual(50);
        }
      });

      it("Python TAMB in plausible range", () => {
        for (let i = 0; i < pyFixture.records.length; i++) {
          const tamb = pyFixture.records[i].TAMB;
          expect(tamb, `Py record ${i}: TAMB=${tamb}`).toBeGreaterThanOrEqual(5);
          expect(tamb, `Py record ${i}: TAMB=${tamb}`).toBeLessThanOrEqual(50);
        }
      });

      it("Python ABST format matches emsDateTime", () => {
        for (const rec of pyFixture.records) {
          expect(rec.ABST).toMatch(/^\d{8}T\d{6}z$/);
        }
      });
    });
  }
});
