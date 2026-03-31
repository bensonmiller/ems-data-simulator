/**
 * Public API for the EMS data simulator.
 */

// Recordset & state
export { SimulatedRecordSet, SimulatorState } from "./recordset.js";

// Configuration
export {
  SimulationConfig,
  ThermalConfig,
  AmbientConfig,
  PowerConfig,
  EventConfig,
  FaultConfig,
  FaultType,
  default_config,
} from "./config.js";

// Schemas
export {
  TransferMetadata,
  EmsRecord,
  EmsRecordMains,
  EmsRecordSolar,
  EmsReport,
  EmsTransfer,
  RtmdRecord,
  RtmdReport,
  RtmdTransfer,
  formatEmsDateTime,
} from "./schemas.js";

// Device
export {
  MonitoringDeviceConfig,
  BaseRtmDevice,
  randomSerial,
  transferMetadata,
} from "./device.js";

// Events
export { FaultEffects, DoorEvent } from "./events.js";

// Random
export { SeededRandom } from "./random.js";
