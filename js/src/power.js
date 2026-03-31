/**
 * Power system models for mains-powered and solar direct drive (SDD) refrigerators.
 *
 * Each model determines when the compressor can run and produces
 * power-related telemetry fields for the output records.
 */

import { PowerConfig } from "./config.js";

/**
 * Mutable power system state carried between intervals.
 */
export class PowerState {
  /**
   * @param {object} opts
   * @param {number} [opts.cumulative_powered_s=0.0] - Total seconds with power available.
   * @param {number} [opts.battery_soc=0.8] - Logger battery state of charge (0.0 to 1.0).
   * @param {boolean} [opts.in_outage=false] - Whether a mains outage is currently active.
   * @param {Date|null} [opts.outage_end=null] - Timestamp when current outage ends (mains only).
   */
  constructor({
    cumulative_powered_s = 0.0,
    battery_soc = 0.8,
    in_outage = false,
    outage_end = null,
  } = {}) {
    this.cumulative_powered_s = cumulative_powered_s;
    this.battery_soc = battery_soc;
    this.in_outage = in_outage;
    this.outage_end = outage_end;
  }
}

/**
 * Mains power with stochastic outage events.
 */
export class MainsPowerModel {
  /**
   * @param {PowerConfig} config
   * @param {import('./random.js').SeededRandom} rng
   */
  constructor(config, rng) {
    this.config = config;
    this.rng = rng;
  }

  /**
   * Update outage state for the current interval.
   * @param {PowerState} state
   * @param {Date} timestamp
   * @param {number} interval_s
   * @returns {PowerState}
   */
  _check_outage(state, timestamp, interval_s) {
    if (state.in_outage) {
      if (state.outage_end !== null && timestamp >= state.outage_end) {
        state.in_outage = false;
        state.outage_end = null;
      }
    } else {
      // Probability of starting an outage in this interval
      const hours = interval_s / 3600.0;
      const p =
        1.0 - Math.pow(1.0 - this.config.outage_probability_per_hour, hours);
      if (this.rng.random() < p) {
        // Exponential duration: Python's expovariate(1/mean) = mean * -ln(U)
        const u = this.rng.random();
        const duration_h =
          -Math.log(u) * this.config.mean_outage_duration_hours;
        state.in_outage = true;
        state.outage_end = new Date(
          timestamp.getTime() + duration_h * 3600 * 1000
        );
      }
    }
    return state;
  }

  /**
   * Compute power readings for one interval.
   * @param {PowerState} state
   * @param {Date} timestamp
   * @param {number} interval_s
   * @param {number} compressor_runtime_s
   * @returns {[PowerState, {SVA: number, ACCD: number, ACSV: number}]}
   */
  simulate_interval(state, timestamp, interval_s, compressor_runtime_s) {
    state = this._check_outage(state, timestamp, interval_s);

    let sva, acsv, powered_s;
    if (state.in_outage) {
      sva = 0;
      acsv = 0.0;
      powered_s = 0.0;
    } else {
      sva = this.config.nominal_voltage;
      // Add small voltage variation
      acsv = round1(sva + this.rng.gauss(0, sva * 0.02));
      powered_s = interval_s;
    }

    state.cumulative_powered_s += powered_s;

    const readings = {
      SVA: sva,
      ACCD: round1(powered_s),
      ACSV: round1(acsv),
    };
    return [state, readings];
  }

  /**
   * @param {PowerState} state
   * @returns {boolean}
   */
  is_power_available(state) {
    return !state.in_outage;
  }
}

/**
 * Solar direct drive (SDD) power model.
 *
 * In an SDD fridge the compressor runs directly from solar panels -- there
 * is no electrical battery for the compressor. Energy is stored thermally
 * in the ice lining. The BLOG field reflects a small primary-cell or
 * rechargeable battery that keeps the data logger running when solar
 * power is unavailable.
 */
export class SolarPowerModel {
  /**
   * @param {PowerConfig} config
   * @param {import('./random.js').SeededRandom} rng
   */
  constructor(config, rng) {
    this.config = config;
    this.rng = rng;
  }

  /**
   * Compute instantaneous DC solar voltage from a bell curve.
   * @param {Date} timestamp
   * @returns {number}
   */
  _solar_voltage(timestamp) {
    const hour =
      timestamp.getUTCHours() +
      timestamp.getUTCMinutes() / 60.0 +
      timestamp.getUTCSeconds() / 3600.0;
    const solar_noon =
      (this.config.sunrise_hour + this.config.sunset_hour) / 2.0;
    const daylight_hours =
      this.config.sunset_hour - this.config.sunrise_hour;

    if (hour < this.config.sunrise_hour || hour > this.config.sunset_hour) {
      return 0.0;
    }

    const phase = (Math.PI * (hour - solar_noon)) / daylight_hours;
    const voltage = this.config.peak_dcsv * Math.max(0.0, Math.cos(phase));
    // Add noise for cloud variation
    const noise = voltage > 0 ? this.rng.gauss(0, voltage * 0.05) : 0;
    return Math.max(0.0, voltage + noise);
  }

  /**
   * Compute power readings and update logger battery SOC.
   * @param {PowerState} state
   * @param {Date} timestamp
   * @param {number} interval_s
   * @param {number} compressor_runtime_s
   * @returns {[PowerState, {DCSV: number, DCCD: number, BLOG: number, BEMD: number}]}
   */
  simulate_interval(state, timestamp, interval_s, compressor_runtime_s) {
    const dcsv = round1(this._solar_voltage(timestamp));
    const solar_power_available =
      dcsv >= this.config.min_operating_voltage;

    // Logger battery dynamics (BLOG)
    const hours = interval_s / 3600.0;
    if (solar_power_available) {
      // Charge logger battery from solar (fast -- small battery)
      const charge_rate = this.config.charge_efficiency * 0.3; // SOC/hour
      state.battery_soc += charge_rate * hours;
    } else {
      // Logger drains battery slowly (very low power draw)
      const drain_rate = 0.015; // SOC/hour
      state.battery_soc -= drain_rate * hours;
    }

    state.battery_soc = Math.max(0.0, Math.min(1.0, state.battery_soc));

    // DCCD: cumulative seconds with DC power available to the compressor
    const powered_s = solar_power_available ? interval_s : 0.0;
    state.cumulative_powered_s += powered_s;

    // BLOG/BEMD: logger battery voltage mapped from SOC
    const blog = round1(
      this.config.blog_voltage_empty +
        state.battery_soc * this.config.blog_voltage_range
    );

    const readings = {
      DCSV: dcsv,
      DCCD: round1(powered_s),
      BLOG: blog,
      BEMD: blog,
    };
    return [state, readings];
  }

  /**
   * Compressor power is available only when solar voltage is sufficient.
   * @param {PowerState} state
   * @param {Date} timestamp
   * @returns {boolean}
   */
  is_power_available(state, timestamp) {
    const dcsv = this._solar_voltage(timestamp);
    return dcsv >= this.config.min_operating_voltage;
  }
}

/** Round to 1 decimal place. */
function round1(v) {
  return Math.round(v * 10) / 10;
}
