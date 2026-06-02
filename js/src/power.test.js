/**
 * Unit tests for power module — mirrors tests/test_power.py.
 */

import { describe, it, expect } from "vitest";
import { PowerConfig } from "./config.js";
import { SeededRandom } from "./random.js";
import { PowerState, MainsPowerModel, SolarPowerModel } from "./power.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mainsConfig(overrides = {}) {
  return new PowerConfig({
    power_type: "mains",
    nominal_voltage: 600,
    outage_probability_per_hour: 0.0,
    ...overrides,
  });
}

function solarConfig(overrides = {}) {
  return new PowerConfig({
    power_type: "solar",
    peak_dcsv: 48.0,
    sunrise_hour: 6.0,
    sunset_hour: 18.0,
    battery_capacity_wh: 2400.0,
    min_operating_voltage: 10.0,
    charge_efficiency: 0.85,
    ...overrides,
  });
}

const NOON = new Date(Date.UTC(2025, 5, 15, 12, 0, 0)); // June 15, 2025 12:00:00 UTC
const MIDNIGHT = new Date(Date.UTC(2025, 5, 15, 0, 0, 0)); // June 15, 2025 00:00:00 UTC
const INTERVAL = 900.0; // 15 minutes

// ===========================================================================
// MainsPowerModel tests
// ===========================================================================

describe("MainsPowerModel.simulate_interval", () => {
  it("returns SVA, ACCD, ACSV keys", () => {
    const model = new MainsPowerModel(mainsConfig(), new SeededRandom(42));
    let state = new PowerState();
    let readings;
    [state, readings] = model.simulate_interval(state, NOON, INTERVAL, 0.0);
    expect(Object.keys(readings).sort()).toEqual(["ACCD", "ACSV", "SVA"]);
  });

  it("SVA is in-bounds seconds (not voltage) when no outage", () => {
    // SVA = number of in-bounds AC seconds in the period (full interval when
    // powered, capped at 900), NOT the supply voltage.
    const cfg = mainsConfig({ nominal_voltage: 230 });
    const model = new MainsPowerModel(cfg, new SeededRandom(42));
    let state = new PowerState();
    let readings;
    [state, readings] = model.simulate_interval(state, NOON, INTERVAL, 0.0);
    expect(readings.SVA).toBe(900);
    expect(readings.SVA).toBeLessThanOrEqual(900);
  });

  it("ACCD is baseline current when compressor idle", () => {
    const cfg = mainsConfig();
    const model = new MainsPowerModel(cfg, new SeededRandom(42));
    let state = new PowerState();
    let readings;
    // Compressor idle for the whole interval -> only the baseline draw.
    [state, readings] = model.simulate_interval(state, NOON, INTERVAL, 0.0);
    expect(readings.ACCD).toBeCloseTo(cfg.mains_baseline_current_a, 5);
  });

  it("ACCD scales with compressor duty cycle", () => {
    const cfg = mainsConfig();
    const model = new MainsPowerModel(cfg, new SeededRandom(42));
    let state = new PowerState();
    let readings;
    // Compressor runs the full interval -> baseline + full running draw.
    [state, readings] = model.simulate_interval(state, NOON, INTERVAL, INTERVAL);
    const expected =
      cfg.mains_baseline_current_a + cfg.mains_compressor_current_a;
    expect(readings.ACCD).toBeCloseTo(expected, 5);
    expect(readings.ACCD).toBeGreaterThanOrEqual(0.01);
    expect(readings.ACCD).toBeLessThanOrEqual(49.99);
  });

  it("ACSV near nominal voltage", () => {
    const cfg = mainsConfig({ nominal_voltage: 600 });
    const model = new MainsPowerModel(cfg, new SeededRandom(42));
    let state = new PowerState();
    let readings;
    [state, readings] = model.simulate_interval(state, NOON, INTERVAL, 0.0);
    // Gaussian noise with sigma = 0.02 * 600 = 12, so within ~50V is safe
    expect(Math.abs(readings.ACSV - 600)).toBeLessThan(50);
  });
});

describe("MainsPowerModel outage behavior", () => {
  it("readings zero during outage", () => {
    const model = new MainsPowerModel(mainsConfig(), new SeededRandom(42));
    const state = new PowerState({
      in_outage: true,
      outage_end: new Date(NOON.getTime() + 5 * 3600 * 1000),
    });
    const [, readings] = model.simulate_interval(state, NOON, INTERVAL, 0.0);
    expect(readings.SVA).toBe(0);
    // No AC current during an outage, floored to the schema minimum (0.01).
    expect(readings.ACCD).toBe(0.01);
    expect(readings.ACSV).toBe(0.0);
  });

  it("cumulative_powered_s does not increase during outage", () => {
    const model = new MainsPowerModel(mainsConfig(), new SeededRandom(42));
    const state = new PowerState({
      cumulative_powered_s: 100.0,
      in_outage: true,
      outage_end: new Date(NOON.getTime() + 5 * 3600 * 1000),
    });
    const [updatedState] = model.simulate_interval(
      state,
      NOON,
      INTERVAL,
      0.0
    );
    expect(updatedState.cumulative_powered_s).toBe(100.0);
  });

  it("outage ends when timestamp passes outage_end", () => {
    const model = new MainsPowerModel(mainsConfig(), new SeededRandom(42));
    const outage_end = new Date(NOON.getTime() - 60 * 1000); // 1 min before noon
    const state = new PowerState({ in_outage: true, outage_end });
    const [updatedState, readings] = model.simulate_interval(
      state,
      NOON,
      INTERVAL,
      0.0
    );
    expect(updatedState.in_outage).toBe(false);
    // SVA reflects the full in-bounds interval seconds (capped at 900).
    expect(readings.SVA).toBe(900);
  });

  it("outage can start stochastically", () => {
    const cfg = mainsConfig({
      outage_probability_per_hour: 1.0,
      mean_outage_duration_hours: 1.0,
    });
    const model = new MainsPowerModel(cfg, new SeededRandom(42));
    const state = new PowerState();
    const [updatedState, readings] = model.simulate_interval(
      state,
      NOON,
      INTERVAL,
      0.0
    );
    expect(updatedState.in_outage).toBe(true);
    expect(readings.SVA).toBe(0);
  });

  it("no outage when probability zero", () => {
    const cfg = mainsConfig({ outage_probability_per_hour: 0.0 });
    const model = new MainsPowerModel(cfg, new SeededRandom(42));
    let state = new PowerState();
    for (let i = 0; i < 100; i++) {
      const ts = new Date(NOON.getTime() + INTERVAL * i * 1000);
      let readings;
      [state, readings] = model.simulate_interval(state, ts, INTERVAL, 0.0);
      expect(state.in_outage).toBe(false);
    }
  });
});

describe("MainsPowerModel.is_power_available", () => {
  it("available when not in outage", () => {
    const model = new MainsPowerModel(mainsConfig(), new SeededRandom(42));
    expect(model.is_power_available(new PowerState({ in_outage: false }))).toBe(
      true
    );
  });

  it("not available during outage", () => {
    const model = new MainsPowerModel(mainsConfig(), new SeededRandom(42));
    expect(model.is_power_available(new PowerState({ in_outage: true }))).toBe(
      false
    );
  });
});

// ===========================================================================
// SolarPowerModel tests
// ===========================================================================

describe("SolarPowerModel._solar_voltage", () => {
  it("zero at midnight", () => {
    const model = new SolarPowerModel(solarConfig(), new SeededRandom(42));
    expect(model._solar_voltage(MIDNIGHT)).toBe(0.0);
  });

  it("zero before sunrise", () => {
    const model = new SolarPowerModel(
      solarConfig({ sunrise_hour: 6.0 }),
      new SeededRandom(42)
    );
    const ts = new Date(Date.UTC(2025, 5, 15, 5, 0, 0));
    expect(model._solar_voltage(ts)).toBe(0.0);
  });

  it("zero after sunset", () => {
    const model = new SolarPowerModel(
      solarConfig({ sunset_hour: 18.0 }),
      new SeededRandom(42)
    );
    const ts = new Date(Date.UTC(2025, 5, 15, 19, 0, 0));
    expect(model._solar_voltage(ts)).toBe(0.0);
  });

  it("peak near noon", () => {
    const model = new SolarPowerModel(solarConfig(), new SeededRandom(42));
    const v = model._solar_voltage(NOON);
    // At solar noon cos(0) = 1, so voltage should be near peak_dcsv (48)
    expect(v).toBeGreaterThan(40.0);
  });

  it("voltage symmetric around noon", () => {
    const morning = new Date(Date.UTC(2025, 5, 15, 9, 0, 0));
    const afternoon = new Date(Date.UTC(2025, 5, 15, 15, 0, 0));
    // Run many samples to average out noise
    let sum_morning = 0;
    let sum_afternoon = 0;
    for (let i = 0; i < 100; i++) {
      sum_morning += new SolarPowerModel(
        solarConfig(),
        new SeededRandom(i)
      )._solar_voltage(morning);
      sum_afternoon += new SolarPowerModel(
        solarConfig(),
        new SeededRandom(i + 1000)
      )._solar_voltage(afternoon);
    }
    const avg_morning = sum_morning / 100;
    const avg_afternoon = sum_afternoon / 100;
    expect(Math.abs(avg_morning - avg_afternoon)).toBeLessThan(2.0);
  });

  it("voltage never negative", () => {
    const model = new SolarPowerModel(solarConfig(), new SeededRandom(42));
    for (let hour = 0; hour < 24; hour++) {
      const ts = new Date(Date.UTC(2025, 5, 15, hour, 0, 0));
      expect(model._solar_voltage(ts)).toBeGreaterThanOrEqual(0.0);
    }
  });
});

describe("SolarPowerModel battery SOC", () => {
  it("SOC clamped to zero", () => {
    const model = new SolarPowerModel(solarConfig(), new SeededRandom(42));
    let state = new PowerState({ battery_soc: 0.01 });
    let ts = new Date(MIDNIGHT);
    for (let i = 0; i < 200; i++) {
      [state] = model.simulate_interval(state, ts, INTERVAL, INTERVAL);
      ts = new Date(ts.getTime() + INTERVAL * 1000);
    }
    expect(state.battery_soc).toBeGreaterThanOrEqual(0.0);
  });

  it("SOC clamped to one", () => {
    const model = new SolarPowerModel(solarConfig(), new SeededRandom(42));
    let state = new PowerState({ battery_soc: 0.99 });
    for (let i = 0; i < 200; i++) {
      [state] = model.simulate_interval(state, NOON, INTERVAL, 0.0);
    }
    expect(state.battery_soc).toBeLessThanOrEqual(1.0);
  });

  it("SOC decreases at night with compressor", () => {
    const model = new SolarPowerModel(solarConfig(), new SeededRandom(42));
    let state = new PowerState({ battery_soc: 0.8 });
    const initial_soc = state.battery_soc;
    let ts = new Date(MIDNIGHT);
    for (let i = 0; i < 5; i++) {
      [state] = model.simulate_interval(state, ts, INTERVAL, INTERVAL);
      ts = new Date(ts.getTime() + INTERVAL * 1000);
    }
    expect(state.battery_soc).toBeLessThan(initial_soc);
  });

  it("readings contain expected keys", () => {
    const model = new SolarPowerModel(solarConfig(), new SeededRandom(42));
    let state = new PowerState();
    let readings;
    [state, readings] = model.simulate_interval(state, NOON, INTERVAL, 0.0);
    expect(Object.keys(readings).sort()).toEqual(
      ["BEMD", "BLOG", "DCCD", "DCSV"].sort()
    );
  });

  it("BLOG is days-remaining, scaled from SOC (not voltage)", () => {
    const cfg = solarConfig();
    const model = new SolarPowerModel(cfg, new SeededRandom(42));
    for (const soc of [0.0, 0.5, 1.0]) {
      let state = new PowerState({ battery_soc: soc });
      let readings;
      // simulate_interval updates SOC before deriving BLOG, so compare against
      // the post-update SOC carried on the returned state.
      [state, readings] = model.simulate_interval(state, NOON, INTERVAL, 0.0);
      const expected =
        Math.round(state.battery_soc * cfg.blog_full_days * 10) / 10;
      expect(readings.BLOG).toBeCloseTo(expected, 5);
      expect(readings.BLOG).toBeGreaterThanOrEqual(0.0);
      expect(readings.BLOG).toBeLessThanOrEqual(9999.9);
      expect(readings.BEMD).toBe(readings.BLOG);
    }
  });
});

// ===========================================================================
// PowerState cumulative_powered_s tests
// ===========================================================================

describe("PowerState cumulative_powered_s", () => {
  it("accumulates over multiple intervals (mains)", () => {
    const model = new MainsPowerModel(mainsConfig(), new SeededRandom(42));
    let state = new PowerState({ cumulative_powered_s: 0.0 });
    const n = 5;
    for (let i = 0; i < n; i++) {
      const ts = new Date(NOON.getTime() + INTERVAL * i * 1000);
      [state] = model.simulate_interval(state, ts, INTERVAL, 0.0);
    }
    expect(state.cumulative_powered_s).toBeCloseTo(INTERVAL * n, 1);
  });

  it("accumulates over multiple intervals (solar)", () => {
    const model = new SolarPowerModel(solarConfig(), new SeededRandom(42));
    let state = new PowerState({
      cumulative_powered_s: 0.0,
      battery_soc: 0.8,
    });
    const n = 3;
    for (let i = 0; i < n; i++) {
      const ts = new Date(NOON.getTime() + INTERVAL * i * 1000);
      [state] = model.simulate_interval(state, ts, INTERVAL, 0.0);
    }
    expect(state.cumulative_powered_s).toBeCloseTo(INTERVAL * n, 1);
  });

  it("no accumulation solar no power no battery", () => {
    const model = new SolarPowerModel(solarConfig(), new SeededRandom(42));
    let state = new PowerState({
      cumulative_powered_s: 0.0,
      battery_soc: 0.0,
    });
    let readings;
    [state, readings] = model.simulate_interval(
      state,
      MIDNIGHT,
      INTERVAL,
      0.0
    );
    expect(readings.DCCD).toBe(0.0);
    expect(state.cumulative_powered_s).toBe(0.0);
  });
});

// ===========================================================================
// SolarPowerModel.is_power_available tests
// ===========================================================================

describe("SolarPowerModel.is_power_available", () => {
  it("available at noon", () => {
    const model = new SolarPowerModel(solarConfig(), new SeededRandom(42));
    const state = new PowerState({ battery_soc: 0.5 });
    expect(model.is_power_available(state, NOON)).toBe(true);
  });

  it("not available at night even with logger battery", () => {
    const model = new SolarPowerModel(solarConfig(), new SeededRandom(42));
    const state = new PowerState({ battery_soc: 0.5 });
    expect(model.is_power_available(state, MIDNIGHT)).toBe(false);
  });

  it("not available at night no battery", () => {
    const model = new SolarPowerModel(solarConfig(), new SeededRandom(42));
    const state = new PowerState({ battery_soc: 0.0 });
    expect(model.is_power_available(state, MIDNIGHT)).toBe(false);
  });
});
