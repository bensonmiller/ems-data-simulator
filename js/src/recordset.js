/**
 * SimulatedRecordSet: the integration layer that orchestrates thermal, power,
 * and event models into schema-compatible record batches.
 *
 * Port of utils/simulator/recordset.py
 */

import { SeededRandom } from "./random.js";
import { ThermalModel, ThermalState, AmbientModel, DoorEvent as ThermalDoorEvent } from "./thermal.js";
import { MainsPowerModel, SolarPowerModel, PowerState } from "./power.js";
import { DoorEventGenerator, FaultInjector, AlarmGenerator, DoorEvent } from "./events.js";
import { RtmdRecord, EmsRecordMains, EmsRecordSolar, formatEmsDateTime } from "./schemas.js";

/**
 * Persistent state carried between successive generate() calls.
 *
 * Allows a device to call generate() repeatedly with continuity
 * in TVC, battery SOC, etc.
 */
export class SimulatorState {
  constructor({
    tvc = 5.0,
    compressor_on = false,
    battery_soc = 0.8,
    cumulative_powered_s = 0.0,
    rng_state = null,
    icebank_soc = 1.0,
    tvc_contents = null,
    // Internal sub-model state
    _power_in_outage = false,
    _power_outage_end = null,
    _alarm_last_power_loss = null,
    _alarm_power_was_available = true,
    _alarm_heat_excursion_start = null,
    _alarm_frze_excursion_start = null,
    _alarm_continuous_door_start = null,
    _alarm_door_open_at_prev_end = false,
  } = {}) {
    this.tvc = tvc;
    this.compressor_on = compressor_on;
    this.battery_soc = battery_soc;
    this.cumulative_powered_s = cumulative_powered_s;
    this.rng_state = rng_state;
    this.icebank_soc = icebank_soc;
    this.tvc_contents = tvc_contents;
    this._power_in_outage = _power_in_outage;
    this._power_outage_end = _power_outage_end;
    this._alarm_last_power_loss = _alarm_last_power_loss;
    this._alarm_power_was_available = _alarm_power_was_available;
    this._alarm_heat_excursion_start = _alarm_heat_excursion_start;
    this._alarm_frze_excursion_start = _alarm_frze_excursion_start;
    this._alarm_continuous_door_start = _alarm_continuous_door_start;
    this._alarm_door_open_at_prev_end = _alarm_door_open_at_prev_end;
  }
}

/**
 * Convert events.js DoorEvent (start_offset_s, duration_s) to thermal.js
 * DoorEvent (startOffsetS, durationS) for the thermal model.
 * @param {Array} events - Array of {start_offset_s, duration_s} objects
 * @returns {Array} Array of ThermalDoorEvent objects
 */
function toThermalDoorEvents(events) {
  return events.map(e => new ThermalDoorEvent(e.start_offset_s, e.duration_s));
}

/**
 * A batch of simulated CCE records with conversion methods.
 */
export class SimulatedRecordSet {
  /**
   * @param {Array<object>} records - Array of record dicts.
   * @param {SimulatorState} state - State for continuity.
   * @param {string} powerType - "mains" or "solar".
   */
  constructor(records, state, powerType) {
    this.records = records;
    this.state = state;
    this._powerType = powerType;
  }

  /**
   * Run the simulation and produce a batch of records.
   *
   * @param {import('./config.js').SimulationConfig} config
   * @param {number} batchSize - Number of records to generate.
   * @param {Date} startTime - Timestamp of the first record.
   * @param {number} [interval=900] - Seconds between records.
   * @param {SimulatorState|null} [state=null] - Previous state for continuity.
   * @returns {SimulatedRecordSet}
   */
  static generate(config, batchSize, startTime, interval = 900, state = null) {
    // Initialize RNG
    let rng;
    if (state !== null && state.rng_state !== null) {
      rng = new SeededRandom(0);
      rng.setState(state.rng_state);
    } else if (config.random_seed !== null) {
      rng = new SeededRandom(config.random_seed);
    } else {
      rng = new SeededRandom(Date.now());
    }

    // Initialize state
    if (state === null) {
      state = new SimulatorState({
        tvc: config.thermal.initial_tvc,
        battery_soc: config.power.battery_initial_soc,
        icebank_soc: config.thermal.icebank_initial_soc,
      });
    }

    // Build sub-models
    const thermalModel = new ThermalModel(config.thermal);
    const ambientModel = new AmbientModel(config.ambient, rng);
    const doorGen = new DoorEventGenerator(config.events, rng);
    const faultInjector = new FaultInjector(config.fault, startTime);
    const alarmGen = new AlarmGenerator(rng);

    // Restore alarm generator state
    alarmGen._lastPowerLoss = state._alarm_last_power_loss;
    alarmGen._powerWasAvailable = state._alarm_power_was_available;
    alarmGen._heatExcursionStart = state._alarm_heat_excursion_start;
    alarmGen._frzeExcursionStart = state._alarm_frze_excursion_start;
    alarmGen._continuousDoorStart = state._alarm_continuous_door_start;
    alarmGen._doorOpenAtPrevEnd = state._alarm_door_open_at_prev_end;

    // Build power model
    const powerState = new PowerState({
      cumulative_powered_s: state.cumulative_powered_s,
      battery_soc: state.battery_soc,
      in_outage: state._power_in_outage,
      outage_end: state._power_outage_end,
    });

    const isSolar = config.power.power_type === "solar";
    const powerModel = isSolar
      ? new SolarPowerModel(config.power, rng)
      : new MainsPowerModel(config.power, rng);

    // Thermal state
    let thermalState = new ThermalState({
      tvc: state.tvc,
      compressorOn: state.compressor_on,
      icebankSoc: state.icebank_soc,
      tvcContents: state.tvc_contents,
    });

    const records = [];

    for (let i = 0; i < batchSize; i++) {
      const timestamp = new Date(startTime.getTime() + i * interval * 1000);

      // 1. Ambient temperature
      const tamb = ambientModel.getTamb(timestamp);

      // 2. Door events (events.js format: start_offset_s, duration_s)
      let doorEvents = doorGen.getDoorEvents(timestamp, interval);

      // 3. Fault effects
      const faultEffects = faultInjector.getFaultEffects(timestamp);

      // 4. Power availability
      let powerAvailable;
      if (faultEffects.power_available_override !== null) {
        powerAvailable = faultEffects.power_available_override;
      } else if (isSolar) {
        powerAvailable = powerModel.is_power_available(powerState, timestamp);
      } else {
        powerAvailable = powerModel.is_power_available(powerState);
      }

      // 5. Compressor availability (power + fault)
      const compressorAvailable = powerAvailable && faultEffects.compressor_available;

      // 6. Apply stuck door fault
      if (faultEffects.door_forced_open) {
        doorEvents = [DoorEvent(0, interval)];
      }

      // 7. Compute Q_compressor override for refrigerant leak
      let qOverride = null;
      if (faultEffects.q_compressor_multiplier < 1.0) {
        qOverride = config.thermal.Q_compressor * faultEffects.q_compressor_multiplier;
      }

      // 8. Thermal simulation (convert door events to thermal format)
      const thermalDoorEvents = toThermalDoorEvents(doorEvents);
      const [newThermalState, thermalRecord] = thermalModel.simulateInterval(
        thermalState,
        tamb,
        interval,
        compressorAvailable,
        thermalDoorEvents,
        qOverride,
      );
      thermalState = newThermalState;

      // 9. Power readings
      const [, powerRecord] = powerModel.simulate_interval(
        powerState,
        timestamp,
        interval,
        thermalRecord.CMPR,
      );

      // 10. Alarms (uses events.js door event format)
      const alarmRecord = alarmGen.deriveAlarms({
        tvc: thermalState.tvc,
        power_available: powerAvailable,
        timestamp,
        door_events: doorEvents,
        interval_s: interval,
      });

      // 11. Battery/BLOG for mains
      if (!isSolar) {
        const blog = Math.round(Math.max(0, Math.min(14.0, rng.gauss(12.0, 0.3))) * 10) / 10;
        powerRecord.BLOG = blog;
        powerRecord.BEMD = blog;
      }

      // Assemble the record
      const record = { ABST: timestamp };
      Object.assign(record, thermalRecord);
      Object.assign(record, powerRecord);
      Object.assign(record, alarmRecord);

      records.push(record);
    }

    // Save state for next call
    const newState = new SimulatorState({
      tvc: thermalState.tvc,
      compressor_on: thermalState.compressorOn,
      battery_soc: powerState.battery_soc,
      cumulative_powered_s: powerState.cumulative_powered_s,
      rng_state: rng.getState(),
      icebank_soc: thermalState.icebankSoc,
      tvc_contents: thermalState.tvcContents,
      _power_in_outage: powerState.in_outage,
      _power_outage_end: powerState.outage_end,
      _alarm_last_power_loss: alarmGen._lastPowerLoss,
      _alarm_power_was_available: alarmGen._powerWasAvailable,
      _alarm_heat_excursion_start: alarmGen._heatExcursionStart,
      _alarm_frze_excursion_start: alarmGen._frzeExcursionStart,
      _alarm_continuous_door_start: alarmGen._continuousDoorStart,
      _alarm_door_open_at_prev_end: alarmGen._doorOpenAtPrevEnd,
    });

    return new SimulatedRecordSet(records, newState, config.power.power_type);
  }

  /**
   * Convert records to RTMD format (subset of fields).
   * @returns {RtmdRecord[]}
   */
  toRtmd() {
    const rtmdFields = ["ABST", "BEMD", "TVC", "TAMB", "ALRM", "EERR"];
    return this.records.map(r => {
      const filtered = {};
      for (const k of rtmdFields) {
        if (k in r && r[k] !== undefined) {
          filtered[k] = r[k];
        }
      }
      return new RtmdRecord(filtered);
    });
  }

  /**
   * Convert records to EMS format.
   * @param {string|null} [powersource=null] - "mains" or "solar". If null, inferred from config.
   * @returns {Array<EmsRecordMains|EmsRecordSolar>}
   */
  toEms(powersource = null) {
    if (powersource === null) {
      powersource = this._powerType;
    }

    const baseFields = [
      "ABST", "ALRM", "BEMD", "BLOG", "CMPR", "DORV",
      "HAMB", "HOLD", "EERR", "TAMB", "TCON", "TVC",
    ];

    let extraFields, Schema;
    if (powersource === "solar") {
      extraFields = ["DCCD", "DCSV"];
      Schema = EmsRecordSolar;
    } else {
      extraFields = ["ACCD", "ACSV", "SVA"];
      Schema = EmsRecordMains;
    }

    const allFields = [...baseFields, ...extraFields];

    return this.records.map(r => {
      const filtered = {};
      for (const k of allFields) {
        if (k in r && r[k] !== undefined) {
          filtered[k] = r[k];
        }
      }
      // Map EERR to LERR for EMS schema compatibility
      if ("EERR" in filtered) {
        filtered.LERR = filtered.EERR;
        delete filtered.EERR;
      }
      return new Schema(filtered);
    });
  }
}
