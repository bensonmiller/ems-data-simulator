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

  it("SVA equals nominal_voltage when no outage", () => {
    const cfg = mainsConfig({ nominal_voltage: 600 });
    const model = new MainsPowerModel(cfg, new SeededRandom(42));
    let state = new PowerState();
    let readings;
    [state, readings] = model.simulate_interval(state, NOON, INTERVAL, 0.0);
    expect(readings.SVA).toBe(600);
  });

  it("ACCD equals interval when no outage", () => {
    const model = new MainsPowerModel(mainsConfig(), new SeededRandom(42));
    let state = new PowerState();
    let readings;
    [state, readings] = model.simulate_interval(state, NOON, INTERVAL, 0.0);
    expect(readings.ACCD).toBe(INTERVAL);
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
    expect(readings.ACCD).toBe(0.0);
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
    expect(readings.SVA).toBe(model.config.nominal_voltage);
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

  it("BLOG range", () => {
    const model = new SolarPowerModel(solarConfig(), new SeededRandom(42));
    for (const soc of [0.0, 0.5, 1.0]) {
      let state = new PowerState({ battery_soc: soc });
      let readings;
      [state, readings] = model.simulate_interval(state, NOON, INTERVAL, 0.0);
      expect(readings.BLOG).toBeGreaterThanOrEqual(10.0);
      expect(readings.BLOG).toBeLessThanOrEqual(15.0);
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
