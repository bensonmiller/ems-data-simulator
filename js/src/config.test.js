import { describe, it, expect } from "vitest";
import {
  FaultType,
  ThermalConfig,
  AmbientConfig,
  PowerConfig,
  EventConfig,
  FaultConfig,
  SimulationConfig,
  default_config,
} from "./config.js";

// ---------- FaultType enum ----------

describe("FaultType", () => {
  it("has all expected values", () => {
    expect(FaultType.NONE).toBe("none");
    expect(FaultType.POWER_OUTAGE).toBe("power_outage");
    expect(FaultType.STUCK_DOOR).toBe("stuck_door");
    expect(FaultType.COMPRESSOR_FAILURE).toBe("compressor_failure");
    expect(FaultType.REFRIGERANT_LEAK).toBe("refrigerant_leak");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(FaultType)).toBe(true);
  });
});

// ---------- ThermalConfig ----------

describe("ThermalConfig", () => {
  it("instantiates with correct defaults", () => {
    const tc = new ThermalConfig();
    expect(tc.R).toBe(0.12);
    expect(tc.C).toBe(15000.0);
    expect(tc.Q_compressor).toBe(300.0);
    expect(tc.R_door).toBe(0.15);
    expect(tc.C_air).toBe(0.0);
    expect(tc.R_air_contents).toBe(0.4);
    expect(tc.T_setpoint_low).toBe(2.0);
    expect(tc.T_setpoint_high).toBe(8.0);
    expect(tc.initial_tvc).toBe(5.0);
    expect(tc.sub_step_seconds).toBe(10.0);
    expect(tc.icebank_capacity_j).toBe(0.0);
    expect(tc.icebank_initial_soc).toBe(1.0);
    expect(tc.R_icebank).toBe(0.08);
    expect(tc.compressor_targets_icebank).toBe(false);
  });

  it("accepts overrides", () => {
    const tc = new ThermalConfig({ R: 1.63, C: 50000.0 });
    expect(tc.R).toBe(1.63);
    expect(tc.C).toBe(50000.0);
    // other fields keep defaults
    expect(tc.Q_compressor).toBe(300.0);
  });
});

// ---------- AmbientConfig ----------

describe("AmbientConfig", () => {
  it("instantiates with correct defaults", () => {
    const ac = new AmbientConfig();
    expect(ac.T_mean).toBe(28.0);
    expect(ac.T_amplitude).toBe(5.0);
    expect(ac.noise_sigma).toBe(0.5);
    expect(ac.peak_hour).toBe(14.0);
  });
});

// ---------- PowerConfig ----------

describe("PowerConfig", () => {
  it("instantiates with correct defaults", () => {
    const pc = new PowerConfig();
    expect(pc.power_type).toBe("mains");
    expect(pc.nominal_voltage).toBe(600);
    expect(pc.outage_probability_per_hour).toBe(0.005);
    expect(pc.mean_outage_duration_hours).toBe(2.0);
    expect(pc.peak_dcsv).toBe(20.0);
    expect(pc.sunrise_hour).toBe(5.5);
    expect(pc.sunset_hour).toBe(17.5);
    expect(pc.battery_capacity_wh).toBe(1200.0);
    expect(pc.battery_initial_soc).toBe(0.9);
    expect(pc.min_operating_voltage).toBe(12.0);
    expect(pc.charge_efficiency).toBe(0.85);
    expect(pc.blog_voltage_empty).toBe(13.2);
    expect(pc.blog_voltage_range).toBe(1.4);
  });
});

// ---------- EventConfig ----------

describe("EventConfig", () => {
  it("instantiates with correct defaults", () => {
    const ec = new EventConfig();
    expect(ec.door_rate_per_hour).toBe(2.0);
    expect(ec.door_mean_duration_s).toBe(30.0);
    expect(ec.door_std_duration_s).toBe(15.0);
    expect(ec.working_hours).toEqual([8, 17]);
    expect(ec.off_hours_rate_fraction).toBe(0.05);
  });

  it("bestpractice preset", () => {
    const ec = EventConfig.bestpractice();
    expect(ec.door_rate_per_hour).toBe(0.25);
    expect(ec.door_mean_duration_s).toBe(25.0);
    expect(ec.door_std_duration_s).toBe(10.0);
    expect(ec.working_hours).toEqual([8, 17]);
    expect(ec.off_hours_rate_fraction).toBe(0.05);
  });

  it("normal preset", () => {
    const ec = EventConfig.normal();
    expect(ec.door_rate_per_hour).toBe(0.7);
    expect(ec.door_mean_duration_s).toBe(25.0);
    expect(ec.door_std_duration_s).toBe(10.0);
    expect(ec.working_hours).toEqual([8, 17]);
    expect(ec.off_hours_rate_fraction).toBe(0.05);
  });

  it("few_but_long preset", () => {
    const ec = EventConfig.few_but_long();
    expect(ec.door_rate_per_hour).toBe(0.3);
    expect(ec.door_mean_duration_s).toBe(180.0);
    expect(ec.door_std_duration_s).toBe(120.0);
    expect(ec.working_hours).toEqual([8, 17]);
    expect(ec.off_hours_rate_fraction).toBe(0.1);
  });

  it("frequent_short preset", () => {
    const ec = EventConfig.frequent_short();
    expect(ec.door_rate_per_hour).toBe(1.2);
    expect(ec.door_mean_duration_s).toBe(25.0);
    expect(ec.door_std_duration_s).toBe(10.0);
    expect(ec.working_hours).toEqual([8, 17]);
    expect(ec.off_hours_rate_fraction).toBe(0.05);
  });

  it("busy_facility preset", () => {
    const ec = EventConfig.busy_facility();
    expect(ec.door_rate_per_hour).toBe(1.2);
    expect(ec.door_mean_duration_s).toBe(25.0);
    expect(ec.door_std_duration_s).toBe(10.0);
    expect(ec.working_hours).toEqual([6, 20]);
    expect(ec.off_hours_rate_fraction).toBe(0.15);
  });
});

// ---------- FaultConfig ----------

describe("FaultConfig", () => {
  it("instantiates with correct defaults", () => {
    const fc = new FaultConfig();
    expect(fc.fault_type).toBe(FaultType.NONE);
    expect(fc.fault_start_offset_s).toBe(0.0);
    expect(fc.fault_duration_s).toBe(0.0);
    expect(fc.refrigerant_leak_rate).toBe(0.002);
  });
});

// ---------- SimulationConfig ----------

describe("SimulationConfig", () => {
  it("instantiates with correct defaults", () => {
    const sc = new SimulationConfig();
    expect(sc.thermal).toBeInstanceOf(ThermalConfig);
    expect(sc.ambient).toBeInstanceOf(AmbientConfig);
    expect(sc.power).toBeInstanceOf(PowerConfig);
    expect(sc.events).toBeInstanceOf(EventConfig);
    expect(sc.fault).toBeInstanceOf(FaultConfig);
    expect(sc.sample_interval).toBe(900);
    expect(sc.random_seed).toBeNull();
  });

  it("sub-config defaults are correct when composed", () => {
    const sc = new SimulationConfig();
    expect(sc.thermal.R).toBe(0.12);
    expect(sc.ambient.T_mean).toBe(28.0);
    expect(sc.power.power_type).toBe("mains");
    expect(sc.events.door_rate_per_hour).toBe(2.0);
    expect(sc.fault.fault_type).toBe(FaultType.NONE);
  });
});

// ---------- default_config ----------

describe("default_config", () => {
  it("mains defaults", () => {
    const cfg = default_config("mains");
    expect(cfg).toBeInstanceOf(SimulationConfig);
    expect(cfg.power.power_type).toBe("mains");
    expect(cfg.thermal.R).toBe(1.63);
    expect(cfg.thermal.C).toBe(50000.0);
    expect(cfg.thermal.Q_compressor).toBe(50.0);
    expect(cfg.thermal.R_door).toBe(0.15);
    expect(cfg.thermal.C_air).toBe(3000.0);
    expect(cfg.thermal.R_air_contents).toBe(0.4);
    expect(cfg.thermal.T_setpoint_low).toBe(2.0);
    expect(cfg.thermal.T_setpoint_high).toBe(8.0);
    expect(cfg.thermal.initial_tvc).toBe(5.0);
    expect(cfg.thermal.icebank_capacity_j).toBeCloseTo(10_020_000.0 * 0.85);
    expect(cfg.thermal.icebank_initial_soc).toBe(1.0);
    expect(cfg.thermal.R_icebank).toBe(0.375);
    expect(cfg.thermal.compressor_targets_icebank).toBe(true);
    // mains default events = EventConfig() defaults
    expect(cfg.events.door_rate_per_hour).toBe(2.0);
    // ambient defaults when no latitude
    expect(cfg.ambient.T_mean).toBe(28.0);
    expect(cfg.ambient.T_amplitude).toBe(5.0);
  });

  it("solar defaults", () => {
    const cfg = default_config("solar");
    expect(cfg.power.power_type).toBe("solar");
    expect(cfg.thermal.Q_compressor).toBe(34.0);
    expect(cfg.thermal.R_door).toBe(0.24);
    expect(cfg.thermal.C_air).toBe(5000.0);
    expect(cfg.thermal.R_air_contents).toBe(0.6);
    expect(cfg.thermal.T_setpoint_high).toBe(5.0);
    expect(cfg.thermal.initial_tvc).toBe(4.0);
    expect(cfg.thermal.compressor_targets_icebank).toBe(true);
    // solar events: door_rate_per_hour=0.5, rest are EventConfig defaults
    expect(cfg.events.door_rate_per_hour).toBe(0.5);
    expect(cfg.events.door_mean_duration_s).toBe(30.0);
  });

  it("latitude-to-temperature mapping — equator", () => {
    const cfg = default_config("mains", 0);
    expect(cfg.ambient.T_mean).toBe(30.0);
    expect(cfg.ambient.T_amplitude).toBe(5.0);
  });

  it("latitude-to-temperature mapping — tropics (15N)", () => {
    const cfg = default_config("mains", 15);
    // t_mean = 30 - 15*0.4 = 24.0
    expect(cfg.ambient.T_mean).toBe(24.0);
    // t_amplitude = max(1.5, 5.0 - 15*0.08) = max(1.5, 3.8) = 3.8
    expect(cfg.ambient.T_amplitude).toBe(3.8);
  });

  it("latitude-to-temperature mapping — subtropics (30N)", () => {
    const cfg = default_config("mains", 30);
    // t_mean = max(15, 30 - 30*0.4) = max(15, 18) = 18.0
    expect(cfg.ambient.T_mean).toBe(18.0);
    // abs_lat >= 25, so t_amplitude = 5.0
    expect(cfg.ambient.T_amplitude).toBe(5.0);
  });

  it("latitude-to-temperature mapping — high latitude (50N)", () => {
    const cfg = default_config("mains", 50);
    // t_mean = max(15, 30 - 50*0.4) = max(15, 10) = 15.0
    expect(cfg.ambient.T_mean).toBe(15.0);
    // abs_lat >= 25, so t_amplitude = 5.0
    expect(cfg.ambient.T_amplitude).toBe(5.0);
  });

  it("latitude-to-temperature mapping — southern hemisphere", () => {
    const cfg = default_config("mains", -5);
    // abs_lat = 5; t_mean = 30 - 5*0.4 = 28.0
    expect(cfg.ambient.T_mean).toBe(28.0);
    // t_amplitude = max(1.5, 5.0 - 5*0.08) = max(1.5, 4.6) = 4.6
    expect(cfg.ambient.T_amplitude).toBe(4.6);
  });

  it("default (no args) uses mains", () => {
    const cfg = default_config();
    expect(cfg.power.power_type).toBe("mains");
  });
});
