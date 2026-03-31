/**
 * Event generators for door openings, fault injection, and alarm derivation.
 *
 * Port of utils/simulator/events.py
 */

import { FaultType } from "./config.js";

/**
 * A single door opening event within a sample interval.
 * @typedef {Object} DoorEvent
 * @property {number} start_offset_s - Seconds from interval start when door opens.
 * @property {number} duration_s - Duration of the door opening in seconds.
 */

/**
 * Create a DoorEvent object.
 * @param {number} start_offset_s
 * @param {number} duration_s
 * @returns {DoorEvent}
 */
export function DoorEvent(start_offset_s, duration_s) {
  return { start_offset_s, duration_s };
}

/**
 * The effects of an active fault on the simulation.
 */
export class FaultEffects {
  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.compressor_available=true]
   * @param {boolean} [opts.door_forced_open=false]
   * @param {number} [opts.q_compressor_multiplier=1.0]
   * @param {boolean|null} [opts.power_available_override=null]
   */
  constructor({
    compressor_available = true,
    door_forced_open = false,
    q_compressor_multiplier = 1.0,
    power_available_override = null,
  } = {}) {
    this.compressor_available = compressor_available;
    this.door_forced_open = door_forced_open;
    this.q_compressor_multiplier = q_compressor_multiplier;
    this.power_available_override = power_available_override;
  }
}

/**
 * Generates door opening events using a non-homogeneous Poisson process.
 */
export class DoorEventGenerator {
  /**
   * @param {import('./config.js').EventConfig} config
   * @param {import('./random.js').SeededRandom} rng
   */
  constructor(config, rng) {
    this.config = config;
    this.rng = rng;
  }

  /**
   * Check whether a timestamp falls within working hours.
   * @param {Date} timestamp
   * @returns {boolean}
   */
  _isWorkingHours(timestamp) {
    const hour = timestamp.getUTCHours() + timestamp.getUTCMinutes() / 60.0;
    const [start, end] = this.config.working_hours;
    return start <= hour && hour < end;
  }

  /**
   * Generate door events for one sample interval.
   * @param {Date} intervalStart
   * @param {number} interval_s - Interval length in seconds.
   * @returns {DoorEvent[]}
   */
  getDoorEvents(intervalStart, interval_s) {
    const rate = this._isWorkingHours(intervalStart)
      ? this.config.door_rate_per_hour
      : this.config.door_rate_per_hour * this.config.off_hours_rate_fraction;

    const expected = rate * (interval_s / 3600.0);
    const nEvents = this.rng.poisson(expected);

    const events = [];
    for (let i = 0; i < nEvents; i++) {
      const offset = this.rng.uniform(0, interval_s);
      let duration = Math.max(
        1.0,
        this.rng.gauss(
          this.config.door_mean_duration_s,
          this.config.door_std_duration_s,
        ),
      );
      // Clamp so it doesn't extend beyond interval
      duration = Math.min(duration, interval_s - offset);
      events.push(DoorEvent(offset, duration));
    }

    return events;
  }
}

/**
 * Manages fault state and computes fault effects over time.
 */
export class FaultInjector {
  /**
   * @param {import('./config.js').FaultConfig} config
   * @param {Date} simStart
   */
  constructor(config, simStart) {
    this.config = config;
    this.simStart = simStart;

    if (config.fault_type !== FaultType.NONE) {
      this.faultStart = new Date(
        simStart.getTime() + config.fault_start_offset_s * 1000,
      );
      if (config.fault_duration_s > 0) {
        this.faultEnd = new Date(
          this.faultStart.getTime() + config.fault_duration_s * 1000,
        );
      } else {
        this.faultEnd = null; // Permanent fault
      }
    } else {
      this.faultStart = null;
      this.faultEnd = null;
    }
  }

  /**
   * @param {Date} timestamp
   * @returns {boolean}
   */
  isFaultActive(timestamp) {
    if (this.config.fault_type === FaultType.NONE) return false;
    if (this.faultStart === null) return false;
    if (timestamp.getTime() < this.faultStart.getTime()) return false;
    if (
      this.faultEnd !== null &&
      timestamp.getTime() >= this.faultEnd.getTime()
    )
      return false;
    return true;
  }

  /**
   * Get the effects of any active fault at the given timestamp.
   * @param {Date} timestamp
   * @returns {FaultEffects}
   */
  getFaultEffects(timestamp) {
    if (!this.isFaultActive(timestamp)) {
      return new FaultEffects();
    }

    const fault = this.config.fault_type;

    if (fault === FaultType.POWER_OUTAGE) {
      return new FaultEffects({
        compressor_available: false,
        power_available_override: false,
      });
    } else if (fault === FaultType.STUCK_DOOR) {
      return new FaultEffects({ door_forced_open: true });
    } else if (fault === FaultType.COMPRESSOR_FAILURE) {
      return new FaultEffects({ compressor_available: false });
    } else if (fault === FaultType.REFRIGERANT_LEAK) {
      const elapsed_h =
        (timestamp.getTime() - this.faultStart.getTime()) / 1000 / 3600.0;
      let multiplier = Math.exp(
        -this.config.refrigerant_leak_rate * elapsed_h,
      );
      // Below 5% capacity, the syphon can't sustain two-phase flow
      if (multiplier < 0.05) {
        multiplier = 0.0;
      }
      return new FaultEffects({ q_compressor_multiplier: multiplier });
    }

    return new FaultEffects();
  }
}

/**
 * Derives alarm fields from simulation state.
 *
 * Alarm codes follow the WHO PQS E003 specification.
 *
 * Supported alarms and their continuous-excursion thresholds:
 * - HEAT: TVC > +8 C for 10 continuous hours.
 * - FRZE: TVC <= -0.5 C for 60 continuous minutes.
 * - DOOR: door/lid continuously open for >= 5 minutes.
 * - POWR: continuous no-power condition for >= 24 hours.
 */
export class AlarmGenerator {
  /** Duration thresholds (seconds) */
  static HEAT_THRESHOLD_S = 10 * 3600; // 10 hours
  static FRZE_THRESHOLD_S = 60 * 60; // 60 minutes
  static DOOR_THRESHOLD_S = 5 * 60; // 5 minutes
  static POWR_THRESHOLD_S = 24 * 3600; // 24 hours

  /**
   * @param {import('./random.js').SeededRandom} rng
   */
  constructor(rng) {
    this.rng = rng;
    /** @type {Date|null} */
    this._lastPowerLoss = null;
    this._powerWasAvailable = true;
    // Continuous excursion tracking
    /** @type {Date|null} */
    this._heatExcursionStart = null;
    /** @type {Date|null} */
    this._frzeExcursionStart = null;
    // Cross-interval door continuity tracking
    /** @type {Date|null} */
    this._continuousDoorStart = null;
    this._doorOpenAtPrevEnd = false;
  }

  /**
   * Merge overlapping/adjacent door events into continuous spans.
   * @param {DoorEvent[]} doorEvents
   * @returns {Array<[number, number]>} Sorted list of [start_offset_s, end_offset_s]
   */
  _mergeDoorSpans(doorEvents) {
    if (!doorEvents || doorEvents.length === 0) return [];
    const EPSILON = 1.0;
    const events = [...doorEvents].sort(
      (a, b) => a.start_offset_s - b.start_offset_s,
    );
    const spans = [];
    let curStart = events[0].start_offset_s;
    let curEnd = events[0].start_offset_s + events[0].duration_s;
    for (let i = 1; i < events.length; i++) {
      const e = events[i];
      const eEnd = e.start_offset_s + e.duration_s;
      if (e.start_offset_s <= curEnd + EPSILON) {
        curEnd = Math.max(curEnd, eEnd);
      } else {
        spans.push([curStart, curEnd]);
        curStart = e.start_offset_s;
        curEnd = eEnd;
      }
    }
    spans.push([curStart, curEnd]);
    return spans;
  }

  /**
   * Evaluate DOOR alarm using sub-interval door events.
   * Detects continuous door-open periods >= DOOR_THRESHOLD_S, including
   * spans that straddle interval boundaries.
   * @param {DoorEvent[]} doorEvents
   * @param {number} interval_s
   * @param {Date} timestamp
   * @returns {boolean}
   */
  _checkDoorAlarm(doorEvents, interval_s, timestamp) {
    const EPSILON = 1.0;
    const spans = this._mergeDoorSpans(doorEvents);

    if (spans.length === 0) {
      this._continuousDoorStart = null;
      this._doorOpenAtPrevEnd = false;
      return false;
    }

    const openAtStart = spans[0][0] <= EPSILON;
    const openAtEnd = spans[spans.length - 1][1] >= interval_s - EPSILON;

    let triggered = false;

    if (this._doorOpenAtPrevEnd && openAtStart) {
      // Continuity from previous interval
      const continuousEnd = spans[0][1];
      const totalS =
        (timestamp.getTime() - this._continuousDoorStart.getTime()) / 1000 +
        continuousEnd;
      if (totalS >= AlarmGenerator.DOOR_THRESHOLD_S) {
        triggered = true;
      }
      // If the first span doesn't reach interval end, the carry-over chain breaks
      if (!openAtEnd || (spans.length > 1 && spans[0][1] < interval_s - EPSILON)) {
        if (openAtEnd) {
          // A *different* span reaches the end -- new chain
          const lastStart = spans[spans.length - 1][0];
          this._continuousDoorStart = new Date(
            timestamp.getTime() + lastStart * 1000,
          );
        } else {
          this._continuousDoorStart = null;
        }
      }
      // else: single span covers start-to-end, keep existing _continuousDoorStart
    } else {
      // No carry-over -- check individual spans within this interval
      for (const [sStart, sEnd] of spans) {
        if (sEnd - sStart >= AlarmGenerator.DOOR_THRESHOLD_S) {
          triggered = true;
          break;
        }
      }
      // Seed carry-over from the span that reaches the interval end
      if (openAtEnd) {
        this._continuousDoorStart = new Date(
          timestamp.getTime() + spans[spans.length - 1][0] * 1000,
        );
      } else {
        this._continuousDoorStart = null;
      }
    }

    this._doorOpenAtPrevEnd = openAtEnd;
    return triggered;
  }

  /**
   * Compute ALRM, HOLD, and EERR fields.
   *
   * @param {Object} opts
   * @param {number} opts.tvc - Current vaccine chamber temperature.
   * @param {boolean} opts.power_available - Whether power is currently available.
   * @param {Date} opts.timestamp - Current timestamp.
   * @param {DoorEvent[]|null} [opts.door_events=null] - Sub-interval door events.
   * @param {number} [opts.interval_s=900.0] - Length of the sample interval in seconds.
   * @returns {{ALRM: string|null, HOLD: number|null, EERR: string|null}}
   */
  deriveAlarms({ tvc, power_available, timestamp, door_events = null, interval_s = 900.0 }) {
    // Track power loss for HOLD calculation
    if (!power_available && this._powerWasAvailable) {
      this._lastPowerLoss = timestamp;
    }
    if (power_available) {
      this._lastPowerLoss = null;
    }
    this._powerWasAvailable = power_available;

    // Collect active alarm codes
    const codes = [];

    // HEAT: continuous TVC > 8.0 C for 10 hours
    if (tvc > 8.0) {
      if (this._heatExcursionStart === null) {
        this._heatExcursionStart = timestamp;
      }
      const elapsed =
        (timestamp.getTime() - this._heatExcursionStart.getTime()) / 1000;
      if (elapsed >= AlarmGenerator.HEAT_THRESHOLD_S) {
        codes.push("HEAT");
      }
    } else {
      this._heatExcursionStart = null;
    }

    // FRZE: continuous TVC <= -0.5 C for 60 minutes
    if (tvc <= -0.5) {
      if (this._frzeExcursionStart === null) {
        this._frzeExcursionStart = timestamp;
      }
      const elapsed =
        (timestamp.getTime() - this._frzeExcursionStart.getTime()) / 1000;
      if (elapsed >= AlarmGenerator.FRZE_THRESHOLD_S) {
        codes.push("FRZE");
      }
    } else {
      this._frzeExcursionStart = null;
    }

    // DOOR: continuous door open >= 5 minutes
    if (door_events !== null && this._checkDoorAlarm(door_events, interval_s, timestamp)) {
      codes.push("DOOR");
    }

    // POWR: continuous no-power >= 24 hours
    if (this._lastPowerLoss !== null) {
      const powerElapsed =
        (timestamp.getTime() - this._lastPowerLoss.getTime()) / 1000;
      if (powerElapsed >= AlarmGenerator.POWR_THRESHOLD_S) {
        codes.push("POWR");
      }
    }

    // HOLD: seconds since power loss (holdover time)
    let hold = null;
    if (this._lastPowerLoss !== null) {
      hold =
        Math.round(
          ((timestamp.getTime() - this._lastPowerLoss.getTime()) / 1000) * 10,
        ) / 10;
    }

    // EERR: random low-probability error
    let eerr = null;
    if (this.rng.random() < 0.001) {
      const chars = "abcdefghijklmnopqrstuvwxyz";
      eerr = "";
      for (let i = 0; i < 5; i++) {
        eerr += chars[Math.floor(this.rng.random() * chars.length)];
      }
    }

    return {
      ALRM: codes.length > 0 ? codes.join(" ") : null,
      HOLD: hold,
      EERR: eerr,
    };
  }
}
