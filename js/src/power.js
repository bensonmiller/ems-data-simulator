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
   *
   * power_available_override mirrors FaultEffects.power_available_override:
   * when false (e.g. a POWER_OUTAGE fault) the mains supply is forced off for
   * this interval even if no stochastic outage is active, so SVA/ACSV/ACCD all
   * reflect the outage. When null/undefined, behaviour is purely stochastic.
   *
   * @param {PowerState} state
   * @param {Date} timestamp
   * @param {number} interval_s
   * @param {number} compressor_runtime_s
   * @param {boolean|null} [power_available_override=null]
   * @returns {[PowerState, {SVA: number, ACCD: number, ACSV: number}]}
   */
  simulate_interval(
    state,
    timestamp,
    interval_s,
    compressor_runtime_s,
    power_available_override = null
  ) {
    state = this._check_outage(state, timestamp, interval_s);

    // Either a modeled stochastic outage or a fault that forces power off
    // leaves the appliance with no usable AC supply this interval.
    const outage = state.in_outage || power_available_override === false;

    let acsv, powered_s;
    if (outage) {
      acsv = 0.0;
      powered_s = 0.0;
    } else {
      const nominal = this.config.nominal_voltage;
      // ACSV is the average AC supply voltage; add small variation.
      acsv = round1(nominal + this.rng.gauss(0, nominal * 0.02));
      powered_s = interval_s;
    }

    state.cumulative_powered_s += powered_s;

    // SVA is the number of SECONDS within the (15-min) period that AC voltage
    // was in-bounds: the full interval when powered, 0 during an outage.
    // The interop schema bounds SVA to [0, 900].
    const sva = Math.round(Math.min(900.0, powered_s));

    // ACCD is the AC current (amps) drawn by the appliance, modeled from the
    // compressor duty cycle: a small always-on baseline plus the running
    // compressor draw scaled by the fraction of the interval it ran. With no
    // AC supply (mains outage) the appliance draws no current, so ACCD is 0 A
    // per the PQS E006 DS01.2 Annex-1 ACCD minimum of 0 (Data Format 00.00).
    const duty = interval_s > 0 ? compressor_runtime_s / interval_s : 0.0;
    let accd = outage
      ? 0.0
      : this.config.mains_baseline_current_a +
        this.config.mains_compressor_current_a * duty;
    accd = round2(Math.min(49.99, Math.max(0.0, accd)));

    const readings = {
      SVA: sva,
      ACCD: accd,
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
   * power_available_override mirrors FaultEffects.power_available_override:
   * when false (e.g. a POWER_OUTAGE fault) power is forced unavailable for this
   * interval regardless of solar voltage, so the compressor draws no DC current
   * and the logger battery drains.
   *
   * @param {PowerState} state
   * @param {Date} timestamp
   * @param {number} interval_s
   * @param {number} compressor_runtime_s
   * @param {boolean|null} [power_available_override=null]
   * @returns {[PowerState, {DCSV: number, DCCD: number, BLOG: number, BEMD: number}]}
   */
  simulate_interval(
    state,
    timestamp,
    interval_s,
    compressor_runtime_s,
    power_available_override = null
  ) {
    const dcsv = round1(this._solar_voltage(timestamp));
    let solar_power_available = dcsv >= this.config.min_operating_voltage;
    if (power_available_override === false) {
      solar_power_available = false;
    }

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

    const powered_s = solar_power_available ? interval_s : 0.0;
    state.cumulative_powered_s += powered_s;

    // DCCD is the DC current (amps) drawn by the compressor, modeled from the
    // compressor duty cycle while solar power is available (an SDD compressor
    // runs directly off the panels, so it draws no DC current without solar).
    // DCCD range is [0, 99.9]; the PQS E006 DS01.2 Annex-1 Data Format is
    // '00.0' (1 decimal place), unlike ACCD's '00.00'.
    const duty = interval_s > 0 ? compressor_runtime_s / interval_s : 0.0;
    let dccd = solar_power_available
      ? this.config.solar_compressor_current_a * duty
      : 0.0;
    dccd = round1(Math.min(99.9, Math.max(0.0, dccd)));

    // BLOG/BEMD: estimated DAYS of battery life remaining, scaled from the
    // logger battery state of charge (schema range [0, 9999.9]).
    const blog = round1(state.battery_soc * this.config.blog_full_days);
    const bemd = round1(state.battery_soc * this.config.bemd_full_days);

    const readings = {
      DCSV: dcsv,
      DCCD: dccd,
      BLOG: blog,
      BEMD: bemd,
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

/** Round to 2 decimal places. */
function round2(v) {
  return Math.round(v * 100) / 100;
}
