import { describe, it, expect } from "vitest";
import { SeededRandom } from "./random.js";
import {
  DoorEvent,
  ThermalState,
  AmbientModel,
  ThermalModel,
  DEFAULT_THERMAL_CONFIG,
  DEFAULT_AMBIENT_CONFIG,
} from "./thermal.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultModel(overrides = {}) {
  return new ThermalModel(overrides);
}

function state(opts) {
  return new ThermalState({
    compressorOn: false,
    icebankSoc: 1.0,
    tvcContents: null,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// 1. simulate_interval produces correct output fields
// ---------------------------------------------------------------------------

describe("simulateInterval output fields", () => {
  it("record contains required keys", () => {
    const model = defaultModel();
    const [, record] = model.simulateInterval(
      state({ tvc: 5.0 }),
      25.0,
      900,
      true
    );
    expect(record).toHaveProperty("TVC");
    expect(record).toHaveProperty("TAMB");
    expect(record).toHaveProperty("CMPR");
    expect(record).toHaveProperty("DORV");
  });

  it("TAMB matches input", () => {
    const model = defaultModel();
    const [, record] = model.simulateInterval(
      state({ tvc: 5.0 }),
      30.5,
      900,
      true
    );
    expect(record.TAMB).toBe(30.5);
  });

  it("TVC is rounded to 1 decimal", () => {
    const model = defaultModel();
    const [, record] = model.simulateInterval(
      state({ tvc: 5.0 }),
      25.0,
      900,
      true
    );
    expect(record.TVC).toBe(Math.round(record.TVC * 10) / 10);
  });

  it("CMPR and DORV are integers", () => {
    const model = defaultModel();
    const [, record] = model.simulateInterval(
      state({ tvc: 5.0 }),
      25.0,
      900,
      true
    );
    expect(Number.isInteger(record.CMPR)).toBe(true);
    expect(Number.isInteger(record.DORV)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Thermostat hysteresis
// ---------------------------------------------------------------------------

describe("thermostat hysteresis", () => {
  it("compressor turns on at high setpoint", () => {
    const model = defaultModel();
    const [, record] = model.simulateInterval(
      state({ tvc: 8.0 }),
      25.0,
      900,
      true
    );
    expect(record.CMPR).toBeGreaterThan(0);
  });

  it("compressor turns off at low setpoint", () => {
    const model = defaultModel();
    const [newState] = model.simulateInterval(
      state({ tvc: 2.0, compressorOn: true }),
      25.0,
      10,
      true
    );
    expect(newState.compressorOn).toBe(false);
  });

  it("compressor stays on in hysteresis band", () => {
    const model = defaultModel();
    const [, record] = model.simulateInterval(
      state({ tvc: 5.0, compressorOn: true }),
      5.0,
      10,
      true
    );
    expect(record.CMPR).toBeGreaterThan(0);
  });

  it("compressor stays off in hysteresis band", () => {
    const model = defaultModel();
    const [, record] = model.simulateInterval(
      state({ tvc: 5.0 }),
      5.0,
      900,
      true
    );
    expect(record.CMPR).toBe(0);
  });

  it("compressor unavailable forces off", () => {
    const model = defaultModel();
    const [newState, record] = model.simulateInterval(
      state({ tvc: 8.0, compressorOn: true }),
      25.0,
      900,
      false
    );
    expect(record.CMPR).toBe(0);
    expect(newState.compressorOn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Door events increase TVC
// ---------------------------------------------------------------------------

describe("door events", () => {
  it("door event raises TVC", () => {
    const model = defaultModel();
    const [, recNoDoor] = model.simulateInterval(
      state({ tvc: 5.0 }),
      25.0,
      900,
      false
    );
    const [, recDoor] = model.simulateInterval(
      state({ tvc: 5.0 }),
      25.0,
      900,
      false,
      [new DoorEvent(0, 300)]
    );
    expect(recDoor.TVC).toBeGreaterThan(recNoDoor.TVC);
  });

  it("DORV accumulates door seconds", () => {
    const model = defaultModel();
    const [, record] = model.simulateInterval(
      state({ tvc: 5.0 }),
      25.0,
      900,
      true,
      [new DoorEvent(100, 200)]
    );
    expect(record.DORV).toBe(200);
  });

  it("multiple door events tracked correctly", () => {
    const model = defaultModel();
    const [, record] = model.simulateInterval(
      state({ tvc: 5.0 }),
      25.0,
      900,
      true,
      [new DoorEvent(0, 100), new DoorEvent(200, 100)]
    );
    expect(record.DORV).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 4. Compressor cools TVC down
// ---------------------------------------------------------------------------

describe("compressor cooling", () => {
  it("compressor cools TVC", () => {
    const model = defaultModel();
    const [, record] = model.simulateInterval(
      state({ tvc: 8.0, compressorOn: true }),
      25.0,
      900,
      true
    );
    expect(record.TVC).toBeLessThan(8.0);
  });

  it("without compressor TVC drifts up", () => {
    const model = defaultModel();
    const [, record] = model.simulateInterval(
      state({ tvc: 5.0 }),
      35.0,
      900,
      false
    );
    expect(record.TVC).toBeGreaterThan(5.0);
  });

  it("q_compressor_override reduces cooling", () => {
    const model = defaultModel();
    const [, recFull] = model.simulateInterval(
      state({ tvc: 8.0, compressorOn: true }),
      25.0,
      900,
      true
    );
    const [, recWeak] = model.simulateInterval(
      state({ tvc: 8.0, compressorOn: true }),
      25.0,
      900,
      true,
      null,
      50.0
    );
    expect(recFull.TVC).toBeLessThan(recWeak.TVC);
  });
});

// ---------------------------------------------------------------------------
// 5. AmbientModel
// ---------------------------------------------------------------------------

describe("AmbientModel", () => {
  function makeAmbientModel(overrides = {}) {
    const cfg = {
      T_mean: 28.0,
      T_amplitude: 5.0,
      noise_sigma: 0.0,
      peak_hour: 14.0,
      ...overrides,
    };
    const rng = new SeededRandom(42);
    return new AmbientModel(cfg, rng);
  }

  it("peak at peak hour", () => {
    const model = makeAmbientModel();
    // 2025-06-15 14:00 UTC
    const ts = new Date(Date.UTC(2025, 5, 15, 14, 0, 0));
    const tamb = model.getTamb(ts);
    // T_mean + T_amplitude = 33
    expect(tamb).toBeCloseTo(33.0, 0);
  });

  it("trough 12h from peak", () => {
    const model = makeAmbientModel();
    const ts = new Date(Date.UTC(2025, 5, 15, 2, 0, 0));
    const tamb = model.getTamb(ts);
    // T_mean - T_amplitude = 23
    expect(tamb).toBeCloseTo(23.0, 0);
  });

  it("mid-day between peak and trough is near mean", () => {
    const model = makeAmbientModel();
    const ts = new Date(Date.UTC(2025, 5, 15, 8, 0, 0));
    const tamb = model.getTamb(ts);
    expect(tamb).toBeCloseTo(28.0, 0);
  });

  it("noise adds variability", () => {
    const rng = new SeededRandom(99);
    const model = new AmbientModel(
      { T_mean: 28.0, T_amplitude: 5.0, noise_sigma: 2.0, peak_hour: 14.0 },
      rng
    );
    const ts = new Date(Date.UTC(2025, 5, 15, 12, 0, 0));
    const values = [];
    for (let i = 0; i < 50; i++) {
      values.push(model.getTamb(ts));
    }
    const spread = Math.max(...values) - Math.min(...values);
    expect(spread).toBeGreaterThan(1.0);
  });

  it("zero noise is deterministic", () => {
    const model = makeAmbientModel();
    const ts = new Date(Date.UTC(2025, 5, 15, 10, 0, 0));
    const vals = new Set();
    for (let i = 0; i < 10; i++) {
      vals.add(model.getTamb(ts));
    }
    expect(vals.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Euler integration
// ---------------------------------------------------------------------------

describe("Euler integration", () => {
  it("no driving force keeps TVC stable", () => {
    const model = defaultModel({ sub_step_seconds: 10.0 });
    const [, record] = model.simulateInterval(
      state({ tvc: 5.0 }),
      5.0,
      900,
      false
    );
    expect(record.TVC).toBeCloseTo(5.0, 1);
  });

  it("single step matches manual calculation", () => {
    const cfg = {
      R: 0.12,
      C: 15000.0,
      Q_compressor: 300.0,
      R_door: 0.15,
      T_setpoint_low: 2.0,
      T_setpoint_high: 8.0,
      sub_step_seconds: 10.0,
    };
    const model = new ThermalModel(cfg);
    const rc = cfg.R * cfg.C; // 1800
    const tamb = 25.0;
    const tvcInit = 5.0;

    const [newState] = model.simulateInterval(
      state({ tvc: tvcInit }),
      tamb,
      10,
      false
    );
    const expected = tvcInit + ((tamb - tvcInit) / rc) * 10.0;
    expect(newState.tvc).toBeCloseTo(expected, 10);
  });

  it("single step with compressor", () => {
    const cfg = { sub_step_seconds: 10.0 };
    const model = new ThermalModel(cfg);
    const fullCfg = model.config;
    const rc = fullCfg.R * fullCfg.C;
    const tamb = 25.0;
    const tvcInit = 8.0;

    const [newState, record] = model.simulateInterval(
      state({ tvc: tvcInit, compressorOn: true }),
      tamb,
      10,
      true
    );
    const dT =
      (tamb - tvcInit) / rc - fullCfg.Q_compressor / fullCfg.C;
    const expected = tvcInit + dT * 10.0;
    expect(newState.tvc).toBeCloseTo(expected, 10);
    expect(record.CMPR).toBe(10);
  });

  it("single step with door", () => {
    const cfg = { sub_step_seconds: 10.0 };
    const model = new ThermalModel(cfg);
    const fullCfg = model.config;
    const rc = fullCfg.R * fullCfg.C;
    const tamb = 25.0;
    const tvcInit = 5.0;

    const [newState, record] = model.simulateInterval(
      state({ tvc: tvcInit }),
      tamb,
      10,
      false,
      [new DoorEvent(0, 10)]
    );
    const dT =
      (tamb - tvcInit) / rc +
      (tamb - tvcInit) / (fullCfg.R_door * fullCfg.C);
    const expected = tvcInit + dT * 10.0;
    expect(newState.tvc).toBeCloseTo(expected, 10);
    expect(record.DORV).toBe(10);
  });

  it("finer substep gives different result", () => {
    const tamb = 35.0;
    const tvcInit = 5.0;

    const modelCoarse = new ThermalModel({ sub_step_seconds: 100.0 });
    const modelFine = new ThermalModel({ sub_step_seconds: 1.0 });

    const [, recC] = modelCoarse.simulateInterval(
      state({ tvc: tvcInit }),
      tamb,
      900,
      false
    );
    const [, recF] = modelFine.simulateInterval(
      state({ tvc: tvcInit }),
      tamb,
      900,
      false
    );
    expect(recC.TVC).not.toBe(recF.TVC);
    expect(recC.TVC).toBeGreaterThan(tvcInit);
    expect(recF.TVC).toBeGreaterThan(tvcInit);
  });

  it("state carries between intervals", () => {
    const model = defaultModel();
    const [state1] = model.simulateInterval(
      state({ tvc: 5.0 }),
      25.0,
      450,
      false
    );
    const [state2] = model.simulateInterval(state1, 25.0, 450, false);

    const [stateSingle] = model.simulateInterval(
      state({ tvc: 5.0 }),
      25.0,
      900,
      false
    );
    expect(state2.tvc).toBeCloseTo(stateSingle.tvc, 10);
  });
});

// ---------------------------------------------------------------------------
// 7. Two-node model: air responds faster than contents
// ---------------------------------------------------------------------------

describe("two-node model", () => {
  it("air responds faster than contents to door opening", () => {
    const model = new ThermalModel({ C_air: 500.0 });
    const s = state({ tvc: 5.0 });
    const [newState] = model.simulateInterval(s, 25.0, 900, false, [
      new DoorEvent(0, 300),
    ]);
    // Air (tvc) should have moved more from initial than contents
    const airDelta = Math.abs(newState.tvc - 5.0);
    const contentsDelta = Math.abs(newState.tvcContents - 5.0);
    expect(airDelta).toBeGreaterThan(contentsDelta);
  });

  it("two-node door TVC matches Python reference", () => {
    const model = new ThermalModel({ C_air: 500.0, R_air_contents: 0.4 });
    const [newState, record] = model.simulateInterval(
      state({ tvc: 5.0 }),
      25.0,
      900,
      false,
      [new DoorEvent(0, 300)]
    );
    // Python reference values
    expect(newState.tvc).toBeCloseTo(20.882600241535503, 6);
    expect(newState.tvcContents).toBeCloseTo(7.266944723943867, 6);
    expect(record.TVC).toBe(20.9);
  });
});

// ---------------------------------------------------------------------------
// 8. Icebank
// ---------------------------------------------------------------------------

describe("icebank", () => {
  it("holds temperature near 0C while charged", () => {
    const model = new ThermalModel({
      icebank_capacity_j: 500000.0,
      R_icebank: 0.08,
    });
    // Run multiple intervals with charged icebank, no compressor
    let s = state({ tvc: 4.0, icebankSoc: 1.0 });
    for (let i = 0; i < 5; i++) {
      const [ns] = model.simulateInterval(s, 25.0, 900, false);
      s = ns;
    }
    // TVC should stay relatively low (icebank absorbing heat)
    // Without icebank it would drift much higher
    expect(s.tvc).toBeLessThan(15.0);
    expect(s.icebankSoc).toBeLessThan(1.0); // some melting
  });

  it("temperature rises when icebank depleted", () => {
    const model = new ThermalModel({
      icebank_capacity_j: 500000.0,
      R_icebank: 0.08,
    });
    // Depleted icebank: acts like regular single-node
    const [, recDepleted] = model.simulateInterval(
      state({ tvc: 5.0, icebankSoc: 0.0 }),
      25.0,
      900,
      false
    );
    // Charged icebank: absorbs heat
    const [, recCharged] = model.simulateInterval(
      state({ tvc: 5.0, icebankSoc: 1.0 }),
      25.0,
      900,
      false
    );
    // Depleted should warm more than charged
    expect(recDepleted.TVC).toBeGreaterThan(recCharged.TVC);
  });

  it("icebank charged matches Python reference", () => {
    const model = new ThermalModel({
      icebank_capacity_j: 500000.0,
      R_icebank: 0.08,
    });
    const [newState, record] = model.simulateInterval(
      state({ tvc: 5.0, icebankSoc: 1.0 }),
      25.0,
      900,
      false
    );
    expect(newState.tvc).toBeCloseTo(8.579972646142576, 6);
    expect(newState.icebankSoc).toBeCloseTo(0.8394395076305659, 6);
    expect(record.TVC).toBe(8.6);
  });

  it("ICESOC field present when icebank configured", () => {
    const model = new ThermalModel({
      icebank_capacity_j: 500000.0,
    });
    const [, record] = model.simulateInterval(
      state({ tvc: 5.0, icebankSoc: 1.0 }),
      25.0,
      900,
      false
    );
    expect(record.ICESOC).not.toBeNull();
    expect(typeof record.ICESOC).toBe("number");
  });

  it("ICESOC field null when no icebank", () => {
    const model = defaultModel();
    const [, record] = model.simulateInterval(
      state({ tvc: 5.0 }),
      25.0,
      900,
      false
    );
    expect(record.ICESOC).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. Compressor unavailable: temperature drifts toward ambient
// ---------------------------------------------------------------------------

describe("compressor unavailable", () => {
  it("temperature drifts toward ambient", () => {
    const model = defaultModel();
    let s = state({ tvc: 5.0 });
    for (let i = 0; i < 100; i++) {
      const [ns] = model.simulateInterval(s, 30.0, 900, false);
      s = ns;
    }
    // Should drift toward 30C
    expect(s.tvc).toBeGreaterThan(25.0);
  });
});

// ---------------------------------------------------------------------------
// 10. Side-by-side validation: Python reference values
// ---------------------------------------------------------------------------

describe("side-by-side Python validation", () => {
  it("20-interval thermostat cycling matches Python output", () => {
    // Python scenario: start at 8C, compressor available, ambient 25C,
    // default config, 20 intervals of 900s.
    // These are the exact Python raw TVC and CMPR values.
    const pythonResults = [
      { tvc: 4.482703645092603, CMPR: 690 },
      { tvc: 2.9248677242341365, CMPR: 560 },
      { tvc: 5.839050110771193, CMPR: 350 },
      { tvc: 6.867962694016689, CMPR: 470 },
      { tvc: 3.090412187103537, CMPR: 690 },
      { tvc: 3.903489459901908, CMPR: 440 },
      { tvc: 7.01288762996398, CMPR: 350 },
      { tvc: 5.620181477534852, CMPR: 590 },
      { tvc: 2.185890175320253, CMPR: 660 },
      { tvc: 4.936022209323116, CMPR: 350 },
      { tvc: 7.856196087099507, CMPR: 370 },
      { tvc: 4.28108759684298, CMPR: 690 },
      { tvc: 3.098008855419015, CMPR: 540 },
      { tvc: 6.038091669490695, CMPR: 350 },
      { tvc: 6.671085279567919, CMPR: 490 },
      { tvc: 2.8487328865472294, CMPR: 690 },
      { tvc: 4.0727782808674196, CMPR: 420 },
      { tvc: 7.216106776538725, CMPR: 350 },
      { tvc: 5.403887673157483, CMPR: 610 },
      { tvc: 2.3341420903328127, CMPR: 640 },
    ];

    const model = defaultModel();
    let s = state({ tvc: 8.0 });

    for (let i = 0; i < pythonResults.length; i++) {
      const [newState, record] = model.simulateInterval(
        s,
        25.0,
        900,
        true
      );
      expect(newState.tvc).toBeCloseTo(pythonResults[i].tvc, 9);
      expect(record.CMPR).toBe(pythonResults[i].CMPR);
      s = newState;
    }
  });
});
