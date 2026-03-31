/**
 * Configuration classes for the CCE thermal simulator.
 *
 * All tunable parameters are organized into focused config objects
 * that are composed into a single SimulationConfig.
 */

/** FaultType enum — frozen object mirroring the Python Enum. */
export const FaultType = Object.freeze({
  NONE: "none",
  POWER_OUTAGE: "power_outage",
  STUCK_DOOR: "stuck_door",
  COMPRESSOR_FAILURE: "compressor_failure",
  REFRIGERANT_LEAK: "refrigerant_leak",
});

/** Parameters for the RC-circuit thermal model. */
export class ThermalConfig {
  constructor({
    R = 0.12,
    C = 15000.0,
    Q_compressor = 300.0,
    R_door = 0.15,
    C_air = 0.0,
    R_air_contents = 0.4,
    T_setpoint_low = 2.0,
    T_setpoint_high = 8.0,
    initial_tvc = 5.0,
    sub_step_seconds = 10.0,
    icebank_capacity_j = 0.0,
    icebank_initial_soc = 1.0,
    R_icebank = 0.08,
    compressor_targets_icebank = false,
  } = {}) {
    this.R = R;
    this.C = C;
    this.Q_compressor = Q_compressor;
    this.R_door = R_door;
    this.C_air = C_air;
    this.R_air_contents = R_air_contents;
    this.T_setpoint_low = T_setpoint_low;
    this.T_setpoint_high = T_setpoint_high;
    this.initial_tvc = initial_tvc;
    this.sub_step_seconds = sub_step_seconds;
    this.icebank_capacity_j = icebank_capacity_j;
    this.icebank_initial_soc = icebank_initial_soc;
    this.R_icebank = R_icebank;
    this.compressor_targets_icebank = compressor_targets_icebank;
  }
}

/** Parameters for ambient temperature generation. */
export class AmbientConfig {
  constructor({
    T_mean = 28.0,
    T_amplitude = 5.0,
    noise_sigma = 0.5,
    peak_hour = 14.0,
  } = {}) {
    this.T_mean = T_mean;
    this.T_amplitude = T_amplitude;
    this.noise_sigma = noise_sigma;
    this.peak_hour = peak_hour;
  }
}

/** Parameters for power system models. */
export class PowerConfig {
  constructor({
    power_type = "mains",
    nominal_voltage = 600,
    outage_probability_per_hour = 0.005,
    mean_outage_duration_hours = 2.0,
    peak_dcsv = 20.0,
    sunrise_hour = 5.5,
    sunset_hour = 17.5,
    battery_capacity_wh = 1200.0,
    battery_initial_soc = 0.9,
    min_operating_voltage = 12.0,
    charge_efficiency = 0.85,
    blog_voltage_empty = 13.2,
    blog_voltage_range = 1.4,
  } = {}) {
    this.power_type = power_type;
    this.nominal_voltage = nominal_voltage;
    this.outage_probability_per_hour = outage_probability_per_hour;
    this.mean_outage_duration_hours = mean_outage_duration_hours;
    this.peak_dcsv = peak_dcsv;
    this.sunrise_hour = sunrise_hour;
    this.sunset_hour = sunset_hour;
    this.battery_capacity_wh = battery_capacity_wh;
    this.battery_initial_soc = battery_initial_soc;
    this.min_operating_voltage = min_operating_voltage;
    this.charge_efficiency = charge_efficiency;
    this.blog_voltage_empty = blog_voltage_empty;
    this.blog_voltage_range = blog_voltage_range;
  }
}

/** Parameters for door event generation. */
export class EventConfig {
  constructor({
    door_rate_per_hour = 2.0,
    door_mean_duration_s = 30.0,
    door_std_duration_s = 15.0,
    working_hours = [8, 17],
    off_hours_rate_fraction = 0.05,
  } = {}) {
    this.door_rate_per_hour = door_rate_per_hour;
    this.door_mean_duration_s = door_mean_duration_s;
    this.door_std_duration_s = door_std_duration_s;
    this.working_hours = working_hours;
    this.off_hours_rate_fraction = off_hours_rate_fraction;
  }

  /** Well-managed facility with minimal, brief door openings. */
  static bestpractice() {
    return new EventConfig({
      door_rate_per_hour: 0.25,
      door_mean_duration_s: 25.0,
      door_std_duration_s: 10.0,
      working_hours: [8, 17],
      off_hours_rate_fraction: 0.05,
    });
  }

  /** Typical facility with adequate door practices. */
  static normal() {
    return new EventConfig({
      door_rate_per_hour: 0.7,
      door_mean_duration_s: 25.0,
      door_std_duration_s: 10.0,
      working_hours: [8, 17],
      off_hours_rate_fraction: 0.05,
    });
  }

  /** Staff leave the door open for extended periods (2-5+ minutes). */
  static few_but_long() {
    return new EventConfig({
      door_rate_per_hour: 0.3,
      door_mean_duration_s: 180.0,
      door_std_duration_s: 120.0,
      working_hours: [8, 17],
      off_hours_rate_fraction: 0.1,
    });
  }

  /** Staff open the door frequently but briefly (~25s each). */
  static frequent_short() {
    return new EventConfig({
      door_rate_per_hour: 1.2,
      door_mean_duration_s: 25.0,
      door_std_duration_s: 10.0,
      working_hours: [8, 17],
      off_hours_rate_fraction: 0.05,
    });
  }

  /** High-traffic facility with extended operating hours (06:00-20:00). */
  static busy_facility() {
    return new EventConfig({
      door_rate_per_hour: 1.2,
      door_mean_duration_s: 25.0,
      door_std_duration_s: 10.0,
      working_hours: [6, 20],
      off_hours_rate_fraction: 0.15,
    });
  }
}

/** Parameters for fault injection. */
export class FaultConfig {
  constructor({
    fault_type = FaultType.NONE,
    fault_start_offset_s = 0.0,
    fault_duration_s = 0.0,
    refrigerant_leak_rate = 0.002,
  } = {}) {
    this.fault_type = fault_type;
    this.fault_start_offset_s = fault_start_offset_s;
    this.fault_duration_s = fault_duration_s;
    this.refrigerant_leak_rate = refrigerant_leak_rate;
  }
}

/** Top-level configuration composing all sub-configs. */
export class SimulationConfig {
  constructor({
    thermal = new ThermalConfig(),
    ambient = new AmbientConfig(),
    power = new PowerConfig(),
    events = new EventConfig(),
    fault = new FaultConfig(),
    sample_interval = 900,
    random_seed = null,
  } = {}) {
    this.thermal = thermal;
    this.ambient = ambient;
    this.power = power;
    this.events = events;
    this.fault = fault;
    this.sample_interval = sample_interval;
    this.random_seed = random_seed;
  }
}

/**
 * Create a SimulationConfig with sensible defaults.
 *
 * @param {string} powerType - "mains" or "solar"
 * @param {number|null} latitude - Facility latitude
 * @returns {SimulationConfig}
 */
export function default_config(powerType = "mains", latitude = null) {
  // Estimate ambient temperature from latitude
  let t_mean, t_amplitude;
  if (latitude !== null) {
    const abs_lat = Math.abs(latitude);
    t_mean = Math.max(15.0, 30.0 - abs_lat * 0.4);
    t_amplitude = abs_lat < 25 ? Math.max(1.5, 5.0 - abs_lat * 0.08) : 5.0;
  } else {
    t_mean = 28.0;
    t_amplitude = 5.0;
  }

  const ambient = new AmbientConfig({ T_mean: t_mean, T_amplitude: t_amplitude });
  const power = new PowerConfig({ power_type: powerType });

  let thermal, events;

  if (powerType === "solar") {
    thermal = new ThermalConfig({
      R: 1.63,
      C: 50000.0,
      Q_compressor: 34.0,
      R_door: 0.24,
      C_air: 5000.0,
      R_air_contents: 0.6,
      T_setpoint_low: 2.0,
      T_setpoint_high: 5.0,
      initial_tvc: 4.0,
      icebank_capacity_j: 10_020_000.0 * 0.85,
      icebank_initial_soc: 1.0,
      R_icebank: 0.375,
      compressor_targets_icebank: true,
    });
    events = new EventConfig({ door_rate_per_hour: 0.5 });
  } else {
    thermal = new ThermalConfig({
      R: 1.63,
      C: 50000.0,
      Q_compressor: 50.0,
      R_door: 0.15,
      C_air: 3000.0,
      R_air_contents: 0.4,
      T_setpoint_low: 2.0,
      T_setpoint_high: 8.0,
      initial_tvc: 5.0,
      icebank_capacity_j: 10_020_000.0 * 0.85,
      icebank_initial_soc: 1.0,
      R_icebank: 0.375,
      compressor_targets_icebank: true,
    });
    events = new EventConfig();
  }

  return new SimulationConfig({
    thermal,
    ambient,
    power,
    events,
  });
}
