/**
 * Unit tests for js/src/events.js
 *
 * Port of tests/test_events.py
 */

import { describe, it, expect } from "vitest";
import { SeededRandom } from "./random.js";
import { EventConfig, FaultConfig, FaultType } from "./config.js";
import {
  DoorEvent,
  FaultEffects,
  DoorEventGenerator,
  FaultInjector,
  AlarmGenerator,
} from "./events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRng(seed = 42) {
  return new SeededRandom(seed);
}

/** Timestamp during working hours (noon UTC). */
function workingTimestamp() {
  return new Date(Date.UTC(2025, 5, 2, 12, 0, 0)); // June 2, 2025 12:00 UTC
}

/** Timestamp outside working hours (2 AM UTC). */
function offHoursTimestamp() {
  return new Date(Date.UTC(2025, 5, 2, 2, 0, 0)); // June 2, 2025 02:00 UTC
}

const SIM_START = new Date(Date.UTC(2025, 5, 1, 0, 0, 0)); // June 1, 2025

/** Add seconds to a Date and return a new Date. */
function addSeconds(date, s) {
  return new Date(date.getTime() + s * 1000);
}

function addMinutes(date, m) {
  return addSeconds(date, m * 60);
}

function addHours(date, h) {
  return addSeconds(date, h * 3600);
}

function addDays(date, d) {
  return addSeconds(date, d * 86400);
}

// ===================================================================
// 1. DoorEventGenerator
// ===================================================================

describe("DoorEventGenerator", () => {
  it("returns DoorEvent objects", () => {
    const gen = new DoorEventGenerator(
      new EventConfig({ door_rate_per_hour: 20.0 }),
      makeRng(),
    );
    const events = gen.getDoorEvents(workingTimestamp(), 900.0);
    for (const e of events) {
      expect(e).toHaveProperty("start_offset_s");
      expect(e).toHaveProperty("duration_s");
    }
  });

  it("offsets within interval", () => {
    const gen = new DoorEventGenerator(
      new EventConfig({ door_rate_per_hour: 20.0 }),
      makeRng(),
    );
    const events = gen.getDoorEvents(workingTimestamp(), 900.0);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.start_offset_s).toBeGreaterThanOrEqual(0);
      expect(e.start_offset_s).toBeLessThanOrEqual(900.0);
    }
  });

  it("durations positive and within interval", () => {
    const gen = new DoorEventGenerator(
      new EventConfig({ door_rate_per_hour: 20.0 }),
      makeRng(),
    );
    const events = gen.getDoorEvents(workingTimestamp(), 900.0);
    for (const e of events) {
      expect(e.duration_s).toBeGreaterThanOrEqual(1.0);
      expect(e.start_offset_s + e.duration_s).toBeLessThanOrEqual(900.0);
    }
  });

  it("zero rate produces no events", () => {
    const gen = new DoorEventGenerator(
      new EventConfig({ door_rate_per_hour: 0.0 }),
      makeRng(),
    );
    const events = gen.getDoorEvents(workingTimestamp(), 900.0);
    expect(events).toEqual([]);
  });
});

// ===================================================================
// 2. Working hours vs off-hours rate difference
// ===================================================================

describe("DoorEventRates", () => {
  it("working hours produce more events than off hours", () => {
    const config = new EventConfig({
      door_rate_per_hour: 10.0,
      off_hours_rate_fraction: 0.05,
    });
    const nTrials = 200;
    const interval_s = 900.0;

    let workTotal = 0;
    let offTotal = 0;
    for (let i = 0; i < nTrials; i++) {
      const rng = makeRng(99 + i);
      const gen = new DoorEventGenerator(config, rng);
      workTotal += gen.getDoorEvents(workingTimestamp(), interval_s).length;
      offTotal += gen.getDoorEvents(offHoursTimestamp(), interval_s).length;
    }
    expect(workTotal).toBeGreaterThan(offTotal * 3);
  });

  it("_isWorkingHours boundary", () => {
    const config = new EventConfig({ working_hours: [8, 17] });
    const gen = new DoorEventGenerator(config, makeRng());
    // 8:00 is working hours
    expect(gen._isWorkingHours(new Date(Date.UTC(2025, 5, 2, 8, 0, 0)))).toBe(true);
    // 17:00 is NOT working hours (end is exclusive)
    expect(gen._isWorkingHours(new Date(Date.UTC(2025, 5, 2, 17, 0, 0)))).toBe(false);
    // 7:59 is off hours
    expect(gen._isWorkingHours(new Date(Date.UTC(2025, 5, 2, 7, 59, 0)))).toBe(false);
    // 16:59 is working hours
    expect(gen._isWorkingHours(new Date(Date.UTC(2025, 5, 2, 16, 59, 0)))).toBe(true);
  });
});

// ===================================================================
// 3. FaultInjector activation/deactivation
// ===================================================================

describe("FaultInjector", () => {
  it("no fault always inactive", () => {
    const cfg = new FaultConfig({ fault_type: FaultType.NONE });
    const inj = new FaultInjector(cfg, SIM_START);
    expect(inj.isFaultActive(SIM_START)).toBe(false);
    expect(inj.isFaultActive(addHours(SIM_START, 10))).toBe(false);
  });

  it("fault activates at offset", () => {
    const cfg = new FaultConfig({
      fault_type: FaultType.POWER_OUTAGE,
      fault_start_offset_s: 3600.0,
      fault_duration_s: 1800.0,
    });
    const inj = new FaultInjector(cfg, SIM_START);
    expect(inj.isFaultActive(addSeconds(SIM_START, 3599))).toBe(false);
    expect(inj.isFaultActive(addSeconds(SIM_START, 3600))).toBe(true);
    expect(inj.isFaultActive(addSeconds(SIM_START, 4000))).toBe(true);
    expect(inj.isFaultActive(addSeconds(SIM_START, 5400))).toBe(false);
    expect(inj.isFaultActive(addSeconds(SIM_START, 6000))).toBe(false);
  });

  it("permanent fault", () => {
    const cfg = new FaultConfig({
      fault_type: FaultType.STUCK_DOOR,
      fault_start_offset_s: 100.0,
      fault_duration_s: 0,
    });
    const inj = new FaultInjector(cfg, SIM_START);
    expect(inj.isFaultActive(addSeconds(SIM_START, 99))).toBe(false);
    expect(inj.isFaultActive(addSeconds(SIM_START, 100))).toBe(true);
    expect(inj.isFaultActive(addDays(SIM_START, 365))).toBe(true);
  });

  it("inactive fault returns default effects", () => {
    const cfg = new FaultConfig({
      fault_type: FaultType.POWER_OUTAGE,
      fault_start_offset_s: 3600.0,
      fault_duration_s: 1800.0,
    });
    const inj = new FaultInjector(cfg, SIM_START);
    const effects = inj.getFaultEffects(SIM_START);
    expect(effects.compressor_available).toBe(true);
    expect(effects.door_forced_open).toBe(false);
    expect(effects.q_compressor_multiplier).toBe(1.0);
    expect(effects.power_available_override).toBe(null);
  });
});

// ===================================================================
// 4. FaultType -> FaultEffects mapping
// ===================================================================

describe("FaultEffects mapping", () => {
  function activeEffects(faultType, extraCfg = {}) {
    const cfg = new FaultConfig({
      fault_type: faultType,
      fault_start_offset_s: 0.0,
      fault_duration_s: 7200.0,
      ...extraCfg,
    });
    const inj = new FaultInjector(cfg, SIM_START);
    return inj.getFaultEffects(addSeconds(SIM_START, 1));
  }

  it("power outage", () => {
    const fx = activeEffects(FaultType.POWER_OUTAGE);
    expect(fx.compressor_available).toBe(false);
    expect(fx.power_available_override).toBe(false);
    expect(fx.door_forced_open).toBe(false);
    expect(fx.q_compressor_multiplier).toBe(1.0);
  });

  it("stuck door", () => {
    const fx = activeEffects(FaultType.STUCK_DOOR);
    expect(fx.door_forced_open).toBe(true);
    expect(fx.compressor_available).toBe(true);
    expect(fx.power_available_override).toBe(null);
  });

  it("compressor failure", () => {
    const fx = activeEffects(FaultType.COMPRESSOR_FAILURE);
    expect(fx.compressor_available).toBe(false);
    expect(fx.door_forced_open).toBe(false);
    expect(fx.power_available_override).toBe(null);
  });

  it("refrigerant leak initial", () => {
    const cfg = new FaultConfig({
      fault_type: FaultType.REFRIGERANT_LEAK,
      fault_start_offset_s: 0.0,
      fault_duration_s: 7200.0,
      refrigerant_leak_rate: 0.002,
    });
    const inj = new FaultInjector(cfg, SIM_START);
    const fx = inj.getFaultEffects(addSeconds(SIM_START, 1));
    expect(fx.q_compressor_multiplier).toBeGreaterThan(0.99);
    expect(fx.q_compressor_multiplier).toBeLessThanOrEqual(1.0);
  });

  it("refrigerant leak progresses exponentially", () => {
    const cfg = new FaultConfig({
      fault_type: FaultType.REFRIGERANT_LEAK,
      fault_start_offset_s: 0.0,
      fault_duration_s: 0, // permanent
      refrigerant_leak_rate: 0.1,
    });
    const inj = new FaultInjector(cfg, SIM_START);
    const fx = inj.getFaultEffects(addHours(SIM_START, 5));
    const expected = Math.exp(-0.1 * 5);
    expect(Math.abs(fx.q_compressor_multiplier - expected)).toBeLessThan(0.001);
  });

  it("refrigerant leak clamps to zero", () => {
    const cfg = new FaultConfig({
      fault_type: FaultType.REFRIGERANT_LEAK,
      fault_start_offset_s: 0.0,
      fault_duration_s: 0,
      refrigerant_leak_rate: 0.5,
    });
    const inj = new FaultInjector(cfg, SIM_START);
    const fx = inj.getFaultEffects(addHours(SIM_START, 20));
    expect(fx.q_compressor_multiplier).toBe(0.0);
  });

  it("refrigerant leak above threshold not clamped", () => {
    const cfg = new FaultConfig({
      fault_type: FaultType.REFRIGERANT_LEAK,
      fault_start_offset_s: 0.0,
      fault_duration_s: 0,
      refrigerant_leak_rate: 0.002,
    });
    const inj = new FaultInjector(cfg, SIM_START);
    const fx = inj.getFaultEffects(addDays(SIM_START, 30));
    expect(fx.q_compressor_multiplier).toBeGreaterThan(0.05);
  });

  it("refrigerant leak realistic timeline", () => {
    const cfg = new FaultConfig({
      fault_type: FaultType.REFRIGERANT_LEAK,
      fault_start_offset_s: 0.0,
      fault_duration_s: 0,
      refrigerant_leak_rate: 0.002,
    });
    const inj = new FaultInjector(cfg, SIM_START);
    // After 1 week
    let fx = inj.getFaultEffects(addDays(SIM_START, 7));
    expect(fx.q_compressor_multiplier).toBeGreaterThan(0.7);
    expect(fx.q_compressor_multiplier).toBeLessThan(0.75);
    // After 1 month
    fx = inj.getFaultEffects(addDays(SIM_START, 30));
    expect(fx.q_compressor_multiplier).toBeGreaterThan(0.2);
    expect(fx.q_compressor_multiplier).toBeLessThan(0.27);
    // After 2 months
    fx = inj.getFaultEffects(addDays(SIM_START, 60));
    expect(fx.q_compressor_multiplier).toBeLessThan(0.07);
  });
});

// ===================================================================
// 5. AlarmGenerator: ALRM values
// ===================================================================

describe("AlarmGenerator HEAT", () => {
  it("no heat alarm before 10 hours", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    let result;
    for (let i = 0; i < 36; i++) {
      result = ag.deriveAlarms({ tvc: 10.0, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    expect(result.ALRM).toBe(null);
  });

  it("heat alarm triggers at 10 hours", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    let result;
    for (let i = 0; i < 41; i++) {
      result = ag.deriveAlarms({ tvc: 10.0, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    expect(result.ALRM).toBe("HEAT");
  });

  it("heat alarm clears when temp recovers", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    for (let i = 0; i < 44; i++) {
      ag.deriveAlarms({ tvc: 10.0, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    const result = ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: t });
    expect(result.ALRM).toBe(null);
  });

  it("heat timer resets after recovery", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    for (let i = 0; i < 44; i++) {
      ag.deriveAlarms({ tvc: 10.0, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: t });
    t = addMinutes(t, 15);
    let result;
    for (let i = 0; i < 36; i++) {
      result = ag.deriveAlarms({ tvc: 9.0, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    expect(result.ALRM).toBe(null);
  });

  it("heat interrupted excursion resets", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    for (let i = 0; i < 36; i++) {
      ag.deriveAlarms({ tvc: 10.0, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    ag.deriveAlarms({ tvc: 7.0, power_available: true, timestamp: t });
    t = addMinutes(t, 15);
    let result;
    for (let i = 0; i < 8; i++) {
      result = ag.deriveAlarms({ tvc: 10.0, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    expect(result.ALRM).toBe(null);
  });

  it("heat boundary at exactly 8", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    let result;
    for (let i = 0; i < 50; i++) {
      result = ag.deriveAlarms({ tvc: 8.0, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    expect(result.ALRM).toBe(null);
  });
});

describe("AlarmGenerator FRZE", () => {
  it("no frze alarm before 60 minutes", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    let result;
    for (let i = 0; i < 3; i++) {
      result = ag.deriveAlarms({ tvc: -2.0, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    expect(result.ALRM).toBe(null);
  });

  it("frze alarm triggers at 60 minutes", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    let result;
    for (let i = 0; i < 5; i++) {
      result = ag.deriveAlarms({ tvc: -2.0, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    expect(result.ALRM).toBe("FRZE");
  });

  it("frze alarm clears when temp recovers", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    for (let i = 0; i < 5; i++) {
      ag.deriveAlarms({ tvc: -2.0, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    const result = ag.deriveAlarms({ tvc: 3.0, power_available: true, timestamp: t });
    expect(result.ALRM).toBe(null);
  });

  it("frze boundary at minus half", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    let result;
    for (let i = 0; i < 5; i++) {
      result = ag.deriveAlarms({ tvc: -0.5, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    expect(result.ALRM).toBe("FRZE");
  });

  it("frze boundary just above", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    let result;
    for (let i = 0; i < 10; i++) {
      result = ag.deriveAlarms({ tvc: -0.4, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    expect(result.ALRM).toBe(null);
  });

  it("no alarm in normal range", () => {
    const ag = new AlarmGenerator(makeRng(1));
    const result = ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: SIM_START });
    expect(result.ALRM).toBe(null);
  });
});

// ===================================================================
// 5b. DOOR alarm
// ===================================================================

describe("AlarmGenerator DOOR", () => {
  it("no alarm short door event", () => {
    const ag = new AlarmGenerator(makeRng(1));
    const events = [DoorEvent(100, 240)]; // 4 min
    const result = ag.deriveAlarms({
      tvc: 5.0,
      power_available: true,
      timestamp: SIM_START,
      door_events: events,
      interval_s: 900.0,
    });
    expect(result.ALRM).toBe(null);
  });

  it("alarm triggers single long event", () => {
    const ag = new AlarmGenerator(makeRng(1));
    const events = [DoorEvent(100, 360)]; // 6 min
    const result = ag.deriveAlarms({
      tvc: 5.0,
      power_available: true,
      timestamp: SIM_START,
      door_events: events,
      interval_s: 900.0,
    });
    expect(result.ALRM).toBe("DOOR");
  });

  it("alarm boundary exactly 5 minutes", () => {
    const ag = new AlarmGenerator(makeRng(1));
    const events = [DoorEvent(0, 300)];
    const result = ag.deriveAlarms({
      tvc: 5.0,
      power_available: true,
      timestamp: SIM_START,
      door_events: events,
      interval_s: 900.0,
    });
    expect(result.ALRM).toBe("DOOR");
  });

  it("no alarm many short events", () => {
    const ag = new AlarmGenerator(makeRng(1));
    const events = [];
    for (let i = 0; i < 10; i++) {
      events.push(DoorEvent(i * 90, 60));
    }
    const result = ag.deriveAlarms({
      tvc: 5.0,
      power_available: true,
      timestamp: SIM_START,
      door_events: events,
      interval_s: 900.0,
    });
    expect(result.ALRM).toBe(null);
  });

  it("alarm cross interval continuity", () => {
    const ag = new AlarmGenerator(makeRng(1));
    const t0 = SIM_START;
    const interval = 900.0;

    // Interval 0: door open for last 200s
    const events0 = [DoorEvent(700, 200)];
    ag.deriveAlarms({
      tvc: 5.0,
      power_available: true,
      timestamp: t0,
      door_events: events0,
      interval_s: interval,
    });

    // Interval 1: door open from start for 200s
    const t1 = addSeconds(t0, interval);
    const events1 = [DoorEvent(0, 200)];
    const result = ag.deriveAlarms({
      tvc: 5.0,
      power_available: true,
      timestamp: t1,
      door_events: events1,
      interval_s: interval,
    });
    // 200s + 200s = 400s > 300s threshold
    expect(result.ALRM).toBe("DOOR");
  });

  it("no alarm cross interval gap", () => {
    const ag = new AlarmGenerator(makeRng(1));
    const t0 = SIM_START;
    const interval = 900.0;

    const events0 = [DoorEvent(700, 200)];
    ag.deriveAlarms({
      tvc: 5.0,
      power_available: true,
      timestamp: t0,
      door_events: events0,
      interval_s: interval,
    });

    const t1 = addSeconds(t0, interval);
    const events1 = [DoorEvent(10, 200)]; // gap at start
    const result = ag.deriveAlarms({
      tvc: 5.0,
      power_available: true,
      timestamp: t1,
      door_events: events1,
      interval_s: interval,
    });
    expect(result.ALRM).toBe(null);
  });

  it("alarm stuck door across intervals", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    const interval = 900.0;
    let result;

    for (let i = 0; i < 2; i++) {
      const events = [DoorEvent(0, interval)];
      result = ag.deriveAlarms({
        tvc: 5.0,
        power_available: true,
        timestamp: t,
        door_events: events,
        interval_s: interval,
      });
      t = addSeconds(t, interval);
    }
    expect(result.ALRM).toBe("DOOR");
  });

  it("alarm clears when door closes", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    const interval = 900.0;

    for (let i = 0; i < 2; i++) {
      const events = [DoorEvent(0, interval)];
      ag.deriveAlarms({
        tvc: 5.0,
        power_available: true,
        timestamp: t,
        door_events: events,
        interval_s: interval,
      });
      t = addSeconds(t, interval);
    }

    const result = ag.deriveAlarms({
      tvc: 5.0,
      power_available: true,
      timestamp: t,
      door_events: [],
      interval_s: interval,
    });
    expect(result.ALRM).toBe(null);
  });

  it("no alarm when no door events passed", () => {
    const ag = new AlarmGenerator(makeRng(1));
    const result = ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: SIM_START });
    expect(result.ALRM).toBe(null);
  });
});

// ===================================================================
// 5c. POWR alarm
// ===================================================================

describe("AlarmGenerator POWR", () => {
  it("no alarm before 24 hours", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: t });
    t = addHours(t, 1);
    ag.deriveAlarms({ tvc: 5.0, power_available: false, timestamp: t });
    t = addHours(t, 23);
    const result = ag.deriveAlarms({ tvc: 5.0, power_available: false, timestamp: t });
    expect(result.ALRM).toBe(null);
  });

  it("alarm triggers at 24 hours", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: t });
    t = addHours(t, 1);
    ag.deriveAlarms({ tvc: 5.0, power_available: false, timestamp: t });
    t = addHours(t, 25);
    const result = ag.deriveAlarms({ tvc: 5.0, power_available: false, timestamp: t });
    expect(result.ALRM).toBe("POWR");
  });

  it("alarm clears when power restored", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: t });
    t = addHours(t, 1);
    ag.deriveAlarms({ tvc: 5.0, power_available: false, timestamp: t });
    t = addHours(t, 26);
    ag.deriveAlarms({ tvc: 5.0, power_available: false, timestamp: t });
    t = addHours(t, 1);
    const result = ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: t });
    expect(result.ALRM).toBe(null);
  });

  it("POWR coexists with HEAT", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: t });
    t = addHours(t, 1);
    let result;
    for (let i = 0; i < 100; i++) {
      result = ag.deriveAlarms({ tvc: 12.0, power_available: false, timestamp: t });
      t = addMinutes(t, 15);
    }
    expect(result.ALRM).toContain("HEAT");
    expect(result.ALRM).toContain("POWR");
  });
});

// ===================================================================
// 5d. Multi-code ALRM field
// ===================================================================

describe("Multi-code ALRM", () => {
  it("HEAT and DOOR together", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    let result;
    for (let i = 0; i < 44; i++) {
      const events = [DoorEvent(0, 900.0)];
      result = ag.deriveAlarms({
        tvc: 10.0,
        power_available: true,
        timestamp: t,
        door_events: events,
        interval_s: 900.0,
      });
      t = addMinutes(t, 15);
    }
    expect(result.ALRM).toContain("HEAT");
    expect(result.ALRM).toContain("DOOR");
  });

  it("single alarm no trailing space", () => {
    const ag = new AlarmGenerator(makeRng(1));
    let t = new Date(SIM_START);
    let result;
    for (let i = 0; i < 5; i++) {
      result = ag.deriveAlarms({ tvc: -2.0, power_available: true, timestamp: t });
      t = addMinutes(t, 15);
    }
    expect(result.ALRM).toBe("FRZE");
    expect(result.ALRM).not.toContain("  ");
  });
});

// ===================================================================
// 6. HOLD tracking during power loss
// ===================================================================

describe("HOLD tracking", () => {
  it("HOLD null when power available", () => {
    const ag = new AlarmGenerator(makeRng(1));
    const result = ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: SIM_START });
    expect(result.HOLD).toBe(null);
  });

  it("HOLD starts at zero on power loss", () => {
    const ag = new AlarmGenerator(makeRng(1));
    const t0 = SIM_START;
    ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: t0 });
    const t1 = addSeconds(t0, 100);
    const result = ag.deriveAlarms({ tvc: 5.0, power_available: false, timestamp: t1 });
    expect(result.HOLD).toBe(0.0);
  });

  it("HOLD increments during outage", () => {
    const ag = new AlarmGenerator(makeRng(1));
    const t0 = SIM_START;
    ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: t0 });
    const t1 = addSeconds(t0, 100);
    ag.deriveAlarms({ tvc: 5.0, power_available: false, timestamp: t1 });
    const t2 = addSeconds(t1, 300);
    const result = ag.deriveAlarms({ tvc: 5.0, power_available: false, timestamp: t2 });
    expect(result.HOLD).toBe(300.0);
  });

  it("HOLD resets when power restored", () => {
    const ag = new AlarmGenerator(makeRng(1));
    const t0 = SIM_START;
    ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: t0 });
    const t1 = addSeconds(t0, 100);
    ag.deriveAlarms({ tvc: 5.0, power_available: false, timestamp: t1 });
    const t2 = addSeconds(t1, 500);
    const result = ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: t2 });
    expect(result.HOLD).toBe(null);
  });

  it("HOLD tracks second outage independently", () => {
    const ag = new AlarmGenerator(makeRng(1));
    const t0 = SIM_START;
    ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: t0 });
    const t1 = addSeconds(t0, 100);
    ag.deriveAlarms({ tvc: 5.0, power_available: false, timestamp: t1 });
    const t2 = addSeconds(t1, 500);
    ag.deriveAlarms({ tvc: 5.0, power_available: true, timestamp: t2 });
    const t3 = addSeconds(t2, 200);
    ag.deriveAlarms({ tvc: 5.0, power_available: false, timestamp: t3 });
    const t4 = addSeconds(t3, 60);
    const result = ag.deriveAlarms({ tvc: 5.0, power_available: false, timestamp: t4 });
    expect(result.HOLD).toBe(60.0);
  });
});

// ===================================================================
// 7. EventConfig door use presets
// ===================================================================

function simulateDailyDoorStats(config, nDays = 30, seed = 42) {
  const rng = makeRng(seed);
  const gen = new DoorEventGenerator(config, rng);
  const interval_s = 900.0;
  const intervalsPerDay = Math.floor(86400 / interval_s);
  const base = new Date(Date.UTC(2025, 0, 1, 0, 0, 0));

  let totalOpens = 0;
  let totalSecs = 0.0;
  for (let day = 0; day < nDays; day++) {
    for (let i = 0; i < intervalsPerDay; i++) {
      const ts = new Date(base.getTime() + (day * 86400 + i * interval_s) * 1000);
      const events = gen.getDoorEvents(ts, interval_s);
      totalOpens += events.length;
      totalSecs += events.reduce((sum, e) => sum + e.duration_s, 0);
    }
  }

  const opensPd = totalOpens / nDays;
  const secsPd = totalSecs / nDays;
  const avgDur = totalOpens > 0 ? totalSecs / totalOpens : 0;
  return { opensPd, secsPd, avgDur };
}

describe("EventConfig presets", () => {
  it("bestpractice opens per day", () => {
    const { opensPd } = simulateDailyDoorStats(EventConfig.bestpractice());
    expect(opensPd).toBeGreaterThanOrEqual(1);
    expect(opensPd).toBeLessThanOrEqual(5);
  });

  it("bestpractice secs per day", () => {
    const { secsPd } = simulateDailyDoorStats(EventConfig.bestpractice());
    expect(secsPd).toBeGreaterThanOrEqual(20);
    expect(secsPd).toBeLessThanOrEqual(120);
  });

  it("normal opens per day", () => {
    const { opensPd } = simulateDailyDoorStats(EventConfig.normal());
    expect(opensPd).toBeGreaterThanOrEqual(3);
    expect(opensPd).toBeLessThanOrEqual(12);
  });

  it("normal short durations", () => {
    const { avgDur } = simulateDailyDoorStats(EventConfig.normal());
    expect(avgDur).toBeLessThan(40);
  });

  it("normal more opens than bestpractice", () => {
    const bp = simulateDailyDoorStats(EventConfig.bestpractice());
    const norm = simulateDailyDoorStats(EventConfig.normal());
    expect(norm.opensPd).toBeGreaterThan(bp.opensPd);
  });

  it("few_but_long opens per day", () => {
    const { opensPd } = simulateDailyDoorStats(EventConfig.few_but_long());
    expect(opensPd).toBeGreaterThanOrEqual(1);
    expect(opensPd).toBeLessThanOrEqual(8);
  });

  it("few_but_long high avg duration", () => {
    const { avgDur } = simulateDailyDoorStats(EventConfig.few_but_long());
    expect(avgDur).toBeGreaterThan(60);
  });

  it("few_but_long high secs per day", () => {
    const { secsPd } = simulateDailyDoorStats(EventConfig.few_but_long());
    expect(secsPd).toBeGreaterThan(80);
  });

  it("frequent_short opens per day", () => {
    const { opensPd } = simulateDailyDoorStats(EventConfig.frequent_short());
    expect(opensPd).toBeGreaterThanOrEqual(5);
    expect(opensPd).toBeLessThanOrEqual(20);
  });

  it("frequent_short low avg duration", () => {
    const { avgDur } = simulateDailyDoorStats(EventConfig.frequent_short());
    expect(avgDur).toBeLessThan(45);
  });

  it("busy_facility high opens", () => {
    const { opensPd } = simulateDailyDoorStats(EventConfig.busy_facility());
    expect(opensPd).toBeGreaterThanOrEqual(12);
  });

  it("busy_facility extended hours", () => {
    const config = EventConfig.busy_facility();
    expect(config.working_hours).toEqual([6, 20]);
  });

  it("busy_facility more opens than frequent_short", () => {
    const busy = simulateDailyDoorStats(EventConfig.busy_facility());
    const freq = simulateDailyDoorStats(EventConfig.frequent_short());
    expect(busy.opensPd).toBeGreaterThan(freq.opensPd);
  });
});
