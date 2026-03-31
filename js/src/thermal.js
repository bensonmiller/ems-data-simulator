/**
 * RC-circuit thermal model with thermostat control for CCE simulation.
 *
 * Models the vaccine chamber temperature (TVC) as a thermal mass exchanging
 * heat with the environment, cooled by a compressor, and heated by door openings.
 */

/**
 * A single door opening event within a sample interval.
 */
export class DoorEvent {
  /**
   * @param {number} startOffsetS - Seconds from interval start when door opens.
   * @param {number} durationS - How long the door stays open (seconds).
   */
  constructor(startOffsetS, durationS) {
    this.startOffsetS = startOffsetS;
    this.durationS = durationS;
  }
}

/**
 * Mutable state carried between simulation intervals.
 */
export class ThermalState {
  /**
   * @param {object} opts
   * @param {number} opts.tvc - Current vaccine chamber temperature (C).
   * @param {boolean} opts.compressorOn - Whether the compressor is currently running.
   * @param {number} [opts.icebankSoc=1.0] - Icebank state of charge (0-1).
   * @param {number|null} [opts.tvcContents=null] - Bulk contents temperature (C).
   */
  constructor({ tvc, compressorOn, icebankSoc = 1.0, tvcContents = null }) {
    this.tvc = tvc;
    this.compressorOn = compressorOn;
    this.icebankSoc = icebankSoc;
    this.tvcContents = tvcContents;
  }
}

/**
 * Default thermal configuration matching Python ThermalConfig defaults.
 */
export const DEFAULT_THERMAL_CONFIG = {
  R: 0.12,
  C: 15000.0,
  Q_compressor: 300.0,
  R_door: 0.15,
  C_air: 0.0,
  R_air_contents: 0.4,
  T_setpoint_low: 2.0,
  T_setpoint_high: 8.0,
  initial_tvc: 5.0,
  sub_step_seconds: 10.0,
  icebank_capacity_j: 0.0,
  icebank_initial_soc: 1.0,
  R_icebank: 0.08,
  compressor_targets_icebank: false,
};

/**
 * Default ambient configuration matching Python AmbientConfig defaults.
 */
export const DEFAULT_AMBIENT_CONFIG = {
  T_mean: 28.0,
  T_amplitude: 5.0,
  noise_sigma: 0.5,
  peak_hour: 14.0,
};

/**
 * Generates ambient temperature following a daily sinusoidal cycle with noise.
 */
export class AmbientModel {
  /**
   * @param {object} config - Ambient configuration (T_mean, T_amplitude, noise_sigma, peak_hour).
   * @param {object} rng - SeededRandom instance with gauss() method.
   */
  constructor(config, rng) {
    this.config = { ...DEFAULT_AMBIENT_CONFIG, ...config };
    this.rng = rng;
  }

  /**
   * Compute ambient temperature for a given timestamp.
   * @param {Date} timestamp - JS Date object.
   * @returns {number} Ambient temperature rounded to 1 decimal.
   */
  getTamb(timestamp) {
    const hour =
      timestamp.getUTCHours() +
      timestamp.getUTCMinutes() / 60.0 +
      timestamp.getUTCSeconds() / 3600.0;
    const phase =
      (2.0 * Math.PI * (hour - this.config.peak_hour)) / 24.0;
    const base =
      this.config.T_mean + this.config.T_amplitude * Math.cos(phase);
    const noise = this.rng.gauss(0, this.config.noise_sigma);
    return Math.round((base + noise) * 10) / 10;
  }
}

/**
 * RC-circuit thermal simulation with thermostat control.
 *
 * When C_air > 0, uses a two-node air/contents model.
 * When C_air = 0, falls back to the legacy single-node model.
 */
export class ThermalModel {
  /**
   * @param {object} config - Thermal configuration object.
   */
  constructor(config) {
    this.config = { ...DEFAULT_THERMAL_CONFIG, ...config };
    this.rc = this.config.R * this.config.C;
    this._twoNode = this.config.C_air > 0;
    if (this._twoNode) {
      this._cAir = this.config.C_air;
      this._cContents = this.config.C - this.config.C_air;
    }
  }

  /**
   * Simulate one sample interval using Euler integration.
   *
   * @param {ThermalState} state - Current thermal state.
   * @param {number} tamb - Ambient temperature for this interval (C).
   * @param {number} intervalS - Duration of the interval (seconds).
   * @param {boolean} compressorAvailable - Whether compressor can run.
   * @param {DoorEvent[]|null} [doorEvents=null] - Door openings during interval.
   * @param {number|null} [qCompressorOverride=null] - Override cooling power.
   * @returns {[ThermalState, object]} Tuple of [updated state, record dict].
   */
  simulateInterval(
    state,
    tamb,
    intervalS,
    compressorAvailable,
    doorEvents = null,
    qCompressorOverride = null
  ) {
    const cfg = this.config;
    const dtStep = cfg.sub_step_seconds;
    const qComp =
      qCompressorOverride !== null ? qCompressorOverride : cfg.Q_compressor;

    let tvc = state.tvc;
    let compressorOn = state.compressorOn;
    let icebankSoc = state.icebankSoc;
    let tvcContents =
      state.tvcContents !== null ? state.tvcContents : tvc;
    const hasIcebank = cfg.icebank_capacity_j > 0;
    let cmprSeconds = 0.0;
    let dorvSeconds = 0.0;

    // Pre-compute which sub-steps have door open
    const nSteps = Math.trunc(intervalS / dtStep);
    const doorOpenAtStep = new Array(nSteps).fill(false);
    if (doorEvents) {
      for (const event of doorEvents) {
        const startStep = Math.trunc(event.startOffsetS / dtStep);
        const endStep = Math.trunc(
          (event.startOffsetS + event.durationS) / dtStep
        );
        for (
          let s = Math.max(0, startStep);
          s < Math.min(nSteps, endStep);
          s++
        ) {
          doorOpenAtStep[s] = true;
        }
      }
    }

    for (let stepI = 0; stepI < nSteps; stepI++) {
      const doorOpen = doorOpenAtStep[stepI];
      if (doorOpen) {
        dorvSeconds += dtStep;
      }

      // --- Thermostat logic ---
      if (compressorAvailable) {
        if (
          hasIcebank &&
          cfg.compressor_targets_icebank &&
          icebankSoc > 0
        ) {
          compressorOn = true;
        } else {
          if (!compressorOn && tvc >= cfg.T_setpoint_high) {
            compressorOn = true;
          } else if (compressorOn && tvc <= cfg.T_setpoint_low) {
            compressorOn = false;
          }
        }
      } else {
        compressorOn = false;
      }

      if (compressorOn) {
        cmprSeconds += dtStep;
      }

      // --- Thermal dynamics ---
      if (this._twoNode) {
        const qAmbient = (tamb - tvc) / cfg.R;
        const qDoor = doorOpen ? (tamb - tvc) / cfg.R_door : 0.0;
        const qAirContents = (tvcContents - tvc) / cfg.R_air_contents;

        if (hasIcebank && icebankSoc > 0) {
          const T_ice = 0.0;
          const qToIcebank = (tvc - T_ice) / cfg.R_icebank;

          const dTAir =
            (qAmbient + qDoor + qAirContents - qToIcebank) / this._cAir;
          tvc += dTAir * dtStep;

          const dTContents = -qAirContents / this._cContents;
          tvcContents += dTContents * dtStep;

          const icebankHeatW =
            qToIcebank - (compressorOn ? qComp : 0.0);
          icebankSoc -=
            (icebankHeatW * dtStep) / cfg.icebank_capacity_j;
          icebankSoc = Math.max(0.0, Math.min(1.0, icebankSoc));
        } else {
          const dTAir = (qAmbient + qDoor + qAirContents) / this._cAir;
          tvc += dTAir * dtStep;

          let dTContents;
          if (
            compressorOn &&
            hasIcebank &&
            cfg.compressor_targets_icebank
          ) {
            icebankSoc +=
              (qComp * dtStep) / cfg.icebank_capacity_j;
            icebankSoc = Math.min(1.0, icebankSoc);
            dTContents = -qAirContents / this._cContents;
          } else if (compressorOn) {
            dTContents = (-qAirContents - qComp) / this._cContents;
          } else {
            dTContents = -qAirContents / this._cContents;
          }
          tvcContents += dTContents * dtStep;
        }
      } else if (hasIcebank && icebankSoc > 0) {
        // Legacy single-node + icebank model
        const T_ice = 0.0;
        const qAmbient = (tamb - tvc) / cfg.R;
        const qToIcebank = (tvc - T_ice) / cfg.R_icebank;
        const qDoor = doorOpen ? (tamb - tvc) / cfg.R_door : 0.0;

        const dT = (qAmbient - qToIcebank + qDoor) / cfg.C;
        tvc += dT * dtStep;

        const icebankHeatW =
          qToIcebank - (compressorOn ? qComp : 0.0);
        icebankSoc -=
          (icebankHeatW * dtStep) / cfg.icebank_capacity_j;
        icebankSoc = Math.max(0.0, Math.min(1.0, icebankSoc));
      } else {
        // Legacy single-node RC model (no icebank or depleted)
        let dT = (tamb - tvc) / this.rc;
        if (doorOpen) {
          dT += (tamb - tvc) / (cfg.R_door * cfg.C);
        }

        if (
          compressorOn &&
          hasIcebank &&
          cfg.compressor_targets_icebank
        ) {
          icebankSoc +=
            (qComp * dtStep) / cfg.icebank_capacity_j;
          icebankSoc = Math.min(1.0, icebankSoc);
        } else if (compressorOn) {
          dT -= qComp / cfg.C;
        }

        tvc += dT * dtStep;
      }
    }

    // Derive TRBCM (rollbond temperature) for diagnostic output.
    let trbcm = null;
    if (hasIcebank && icebankSoc > 0) {
      const T_ice_surface = 0.0;
      let syphonEff;
      if (qComp > 0) {
        syphonEff =
          cfg.Q_compressor > 0
            ? Math.min(1.0, qComp / cfg.Q_compressor)
            : 0.0;
      } else {
        syphonEff = 0.0;
      }
      const alpha = 0.1 + 0.4 * (1.0 - syphonEff);
      trbcm = T_ice_surface + alpha * (tvc - T_ice_surface);
    } else if (hasIcebank) {
      trbcm = tvc - 0.3;
    }

    const record = {
      TVC: Math.round(tvc * 10) / 10,
      TAMB: Math.round(tamb * 10) / 10,
      CMPR: Math.trunc(cmprSeconds),
      DORV: Math.trunc(dorvSeconds),
      ICESOC: hasIcebank
        ? Math.round(icebankSoc * 10000) / 10000
        : null,
      TRBCM: trbcm !== null ? Math.round(trbcm * 10) / 10 : null,
    };

    const newState = new ThermalState({
      tvc,
      compressorOn,
      icebankSoc,
      tvcContents: this._twoNode ? tvcContents : null,
    });

    return [newState, record];
  }
}
