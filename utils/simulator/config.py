"""
Configuration dataclasses for the CCE thermal simulator.

All tunable parameters are organized into focused config objects
that are composed into a single SimulationConfig.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Tuple


class FaultType(Enum):
    NONE = "none"
    POWER_OUTAGE = "power_outage"
    STUCK_DOOR = "stuck_door"
    COMPRESSOR_FAILURE = "compressor_failure"
    REFRIGERANT_LEAK = "refrigerant_leak"


@dataclass
class ThermalConfig:
    """Parameters for the RC-circuit thermal model.

    R: Thermal resistance between chamber and ambient (K/W).
       Higher R = better insulation = slower temp drift.
    C: Thermal capacitance of the chamber (J/K).
       Higher C = more thermal mass = slower temp changes.
    Q_compressor: Cooling power when compressor is on (W).
    R_door: Thermal resistance of the open doorway (K/W).
        Models the door as a conductance path to ambient: heat flow = (TAMB - TVC) / R_door.
        Lower R_door = larger/leakier door = faster heat exchange with ambient.
    T_setpoint_low: Thermostat low threshold — compressor turns OFF (°C).
    T_setpoint_high: Thermostat high threshold — compressor turns ON (°C).
    initial_tvc: Starting vaccine chamber temperature (°C).
    sub_step_seconds: Integration time step for Euler method (s).
    """
    R: float = 0.12
    C: float = 15000.0
    Q_compressor: float = 300.0
    R_door: float = 0.15
    C_air: float = 0.0                 # Thermal capacitance of the chamber air + near-surface
                                        # layer (J/K).  When > 0, the model splits the chamber
                                        # into two coupled nodes: "air" (what the TVC probe reads)
                                        # and "contents" (vaccine thermal mass, C - C_air).
                                        # Door heat enters the air node, so TVC spikes on door
                                        # open then recovers as air re-equilibrates with cold
                                        # contents.  0 = legacy single-node model (C only).
    R_air_contents: float = 0.4         # Thermal resistance between chamber air and vaccine
                                        # contents (K/W).  Controls how fast TVC recovers after
                                        # a door event.  Lower = faster recovery.
    T_setpoint_low: float = 2.0
    T_setpoint_high: float = 8.0
    initial_tvc: float = 5.0
    sub_step_seconds: float = 10.0

    # Icebank (phase-change thermal storage) parameters.
    # When icebank_capacity_j > 0, the model uses a two-node approach:
    # the icebank acts as a 0°C latent-heat reservoir coupled to the
    # chamber, absorbing heat (melting) and storing compressor energy
    # (freezing).  See the holdover calculator paper for equations.
    #
    # C_ice = 334 kJ/kg;  E_ice_bank = M_ice * C_ice
    # E_new = E_old + E_compressor - E_leakage
    # E_leakage = (TVC - T_ice) / R_icebank * dt
    icebank_capacity_j: float = 0.0        # Total latent heat capacity (J). 0 = no icebank.
    icebank_initial_soc: float = 1.0       # Initial state of charge (0.0–1.0, 1.0 = fully frozen).
    R_icebank: float = 0.08                # Thermal resistance between chamber air and icebank (K/W).
    compressor_targets_icebank: bool = False  # If True, compressor cools icebank (SDD/ILR mode).


@dataclass
class AmbientConfig:
    """Parameters for ambient temperature generation.

    T_mean: Daily mean ambient temperature (°C).
    T_amplitude: Half-amplitude of daily sinusoidal cycle (°C).
    noise_sigma: Std dev of Gaussian noise added to each reading (°C).
    peak_hour: Hour of day (0-23) when ambient temp peaks.
    """
    T_mean: float = 28.0
    T_amplitude: float = 5.0
    noise_sigma: float = 0.5
    peak_hour: float = 14.0


@dataclass
class PowerConfig:
    """Parameters for power system models.

    Shared:
        power_type: "mains" or "solar".

    Mains-specific:
        nominal_voltage: Normal mains voltage (V), maps to SVA field.
        outage_probability_per_hour: Probability of an outage starting in any given hour.
        mean_outage_duration_hours: Mean duration of outages (exponential distribution).

    Solar-specific:
        peak_dcsv: Peak DC solar voltage at solar noon (V).
        sunrise_hour: Hour when solar generation begins.
        sunset_hour: Hour when solar generation ends.
        battery_capacity_wh: Battery capacity in watt-hours.
        battery_initial_soc: Initial state of charge (0.0 to 1.0).
        min_operating_voltage: Minimum voltage to run compressor (V).
        charge_efficiency: Fraction of solar power stored in battery (0.0 to 1.0).

    Battery voltage mapping:
        blog_voltage_empty: Battery voltage at 0% SOC (V).
        blog_voltage_range: Voltage swing from empty to full (V).
        Default maps to LiFePO4 (4S): 13.2V empty, 14.6V full.
    """
    power_type: str = "mains"

    # Mains
    nominal_voltage: int = 600
    outage_probability_per_hour: float = 0.005
    mean_outage_duration_hours: float = 2.0

    # Solar
    peak_dcsv: float = 20.0
    sunrise_hour: float = 5.5
    sunset_hour: float = 17.5
    battery_capacity_wh: float = 1200.0
    battery_initial_soc: float = 0.9
    min_operating_voltage: float = 12.0
    charge_efficiency: float = 0.85

    # Battery voltage mapping (BLOG/BEMD)
    blog_voltage_empty: float = 13.2   # Voltage at 0% SOC
    blog_voltage_range: float = 1.4    # Voltage swing (full - empty)


@dataclass
class EventConfig:
    """Parameters for door event generation.

    door_rate_per_hour: Average door openings per hour during working hours (Poisson lambda).
    door_mean_duration_s: Mean duration of a single door opening (s).
    door_std_duration_s: Std dev of door opening duration (s).
    working_hours: Tuple of (start_hour, end_hour) when door events are likely.
    off_hours_rate_fraction: Fraction of door_rate_per_hour applied outside working hours.
    """
    door_rate_per_hour: float = 2.0
    door_mean_duration_s: float = 30.0
    door_std_duration_s: float = 15.0
    working_hours: Tuple[int, int] = (8, 17)
    off_hours_rate_fraction: float = 0.05

    # --- Door behavior presets ---
    #
    # Calibrated from fleet-wide InfluxDB analysis of 1,225 fridges
    # (Jan 2021 – Dec 2022).  Fleet medians: 1.95 opens/day, 43 secs/day.
    #
    # Well-managed door use:
    #   - bestpractice:    Matches fleet median — ~2 opens/day, ~40-60 secs/day.
    #                      Represents facilities with good cold chain training.
    #   - normal:          Moderate use — 4-8 short opens/day (~25s each).
    #                      Represents a typical facility with adequate practices.
    #
    # Inattentive door use archetypes (from Door Abuse Score ranking):
    #   - few_but_long:    Low frequency, very long openings (avg >2 min).
    #                      Matches top-DAS fridges like 2939741665037910172
    #                      (DAS=6.8, 2.2 opens/day, 113s avg duration).
    #   - frequent_short:  High frequency, normal duration (~25s).
    #                      Matches fridges like 2919598603410341962
    #                      (DAS=4.2, 3.9 opens/day, 25s avg duration).
    #   - busy_facility:   Very high frequency, extended working hours.
    #                      Matches extreme cases like FRIDGEID 2911872004472701155
    #                      (DAS=17.1, 15.9 opens/day, 24s avg, 06:00–20:00 hours).
    #
    # All presets compose freely with any FaultConfig.

    @classmethod
    def bestpractice(cls) -> 'EventConfig':
        """Well-managed facility with minimal, brief door openings.

        Produces ~2 opens/day, ~40-60 secs/day total door-open time.
        Matches the fleet median from 1,225 deployed fridges.
        """
        return cls(
            door_rate_per_hour=0.25,
            door_mean_duration_s=25.0,
            door_std_duration_s=10.0,
            working_hours=(8, 17),
            off_hours_rate_fraction=0.05,
        )

    @classmethod
    def normal(cls) -> 'EventConfig':
        """Typical facility with adequate door practices.

        Produces 4-8 short opens/day (~25s each).  Represents the
        fleet p50–p75 range — not problematic, but not exemplary.
        """
        return cls(
            door_rate_per_hour=0.7,
            door_mean_duration_s=25.0,
            door_std_duration_s=10.0,
            working_hours=(8, 17),
            off_hours_rate_fraction=0.05,
        )

    @classmethod
    def few_but_long(cls) -> 'EventConfig':
        """Staff leave the door open for extended periods (2–5+ minutes).

        Produces ~3 opens/day with high average duration (~180s).
        Characteristic signature: large TVC spikes even with low open count.
        """
        return cls(
            door_rate_per_hour=0.3,
            door_mean_duration_s=180.0,
            door_std_duration_s=120.0,
            working_hours=(8, 17),
            off_hours_rate_fraction=0.1,
        )

    @classmethod
    def frequent_short(cls) -> 'EventConfig':
        """Staff open the door frequently but briefly (~25s each).

        Produces ~10 opens/day with normal-length openings.
        Characteristic signature: many small TVC perturbations that
        prevent the chamber from settling to its equilibrium temperature.
        """
        return cls(
            door_rate_per_hour=1.2,
            door_mean_duration_s=25.0,
            door_std_duration_s=10.0,
            working_hours=(8, 17),
            off_hours_rate_fraction=0.05,
        )

    @classmethod
    def busy_facility(cls) -> 'EventConfig':
        """High-traffic facility with extended operating hours (06:00–20:00).

        Produces ~16+ opens/day.  Models immunization campaign days,
        busy urban clinics, or facilities with poor door discipline.
        """
        return cls(
            door_rate_per_hour=1.2,
            door_mean_duration_s=25.0,
            door_std_duration_s=10.0,
            working_hours=(6, 20),
            off_hours_rate_fraction=0.15,
        )


@dataclass
class FaultConfig:
    """Parameters for fault injection.

    fault_type: Type of fault to inject (or NONE).
    fault_start_offset_s: Seconds from simulation start until fault begins.
    fault_duration_s: Duration of the fault in seconds (0 = permanent).
    refrigerant_leak_rate: For REFRIGERANT_LEAK, exponential decay constant
        (1/hours).  Cooling capacity = exp(-rate * elapsed_hours).
        Default 0.002 gives ~2-month onset-to-failure timeline matching
        real-world thermosyphon leaks (e.g., unit 2807-CB2A: 62-day
        degradation).  Higher values = faster leak (0.01 ≈ 2 weeks).
    """
    fault_type: FaultType = FaultType.NONE
    fault_start_offset_s: float = 0.0
    fault_duration_s: float = 0.0
    refrigerant_leak_rate: float = 0.002


@dataclass
class SimulationConfig:
    """Top-level configuration composing all sub-configs.

    sample_interval: Seconds between output records (typically 600 or 900).
    random_seed: Seed for reproducibility. None = non-deterministic.
    """
    thermal: ThermalConfig = field(default_factory=ThermalConfig)
    ambient: AmbientConfig = field(default_factory=AmbientConfig)
    power: PowerConfig = field(default_factory=PowerConfig)
    events: EventConfig = field(default_factory=EventConfig)
    fault: FaultConfig = field(default_factory=FaultConfig)
    sample_interval: int = 900
    random_seed: Optional[int] = None


def default_config(power_type: str = "mains", latitude: Optional[float] = None) -> SimulationConfig:
    """Create a SimulationConfig with sensible defaults.

    Solar defaults calibrated against Aucma MetaFridge CFD-50 data from
    Abia State, Nigeria (lat ~5°N, 600s sample interval, June-September 2023).
    See data/fridge_data.json for the reference dataset.

    Args:
        power_type: "mains" or "solar".
        latitude: Facility latitude. Used to estimate ambient temperature —
            equatorial locations are hotter, higher latitudes are cooler.
            Also affects daily temperature amplitude (smaller near equator).

    Returns:
        A SimulationConfig with defaults tuned for the given power type and location.
    """
    # Estimate ambient temperature from latitude
    # Equator (~0°) → ~30°C mean, tropics (~15°) → ~28°C, subtropics (~30°) → ~22°C
    if latitude is not None:
        abs_lat = abs(latitude)
        t_mean = max(15.0, 30.0 - abs_lat * 0.4)
        # Equatorial locations have smaller daily temperature swings
        t_amplitude = max(1.5, 5.0 - abs_lat * 0.08) if abs_lat < 25 else 5.0
    else:
        t_mean = 28.0
        t_amplitude = 5.0

    ambient = AmbientConfig(T_mean=t_mean, T_amplitude=t_amplitude)

    power = PowerConfig(power_type=power_type)

    # --- Icebank-equipped ILR / SDD defaults ---
    #
    # Both mains ILRs and solar SDDs share the same thermal architecture:
    # a well-insulated cabinet with an internal icebank (phase-change
    # thermal battery).  The compressor freezes the icebank; ambient heat
    # slowly melts it; TVC stays in the 2-8 °C band while ice remains.
    #
    # R and R_icebank are calibrated from the holdover equation in the
    # Cold Chain Equipment Holdover Calculator (New Horizons / GHL, 2025):
    #
    #   t_holdover = (C_ice · M_ice) / (C_leakage · (T_ext − T_int))
    #
    # Back-calculating from the MetaFridge CFD-50 (9-day holdover at
    # +43 °C PQS test, ~30 kg ice, TVC ≈ 4.5 °C at 24 °C ambient)
    # gives R_wall ≈ 1.63 K/W, R_icebank ≈ 0.375 K/W.
    #
    # Q_compressor is the *effective ice-building rate* (thermal watts
    # delivered to the icebank), NOT the compressor's electrical draw.
    # For SDD: calibrated so 10 h of solar refills daily melt (~34 W).
    # For mains: slightly higher since power is continuous (~50 W).
    #
    # See also: data/fridge_data.json (MetaFridge reference dataset),
    # output/csv/PLOT_2932988129579106421_unlabeled.csv (real holdover).

    if power_type == "solar":
        thermal = ThermalConfig(
            R=1.63,              # Well-insulated ILR/SDD cabinet (K/W)
            C=50000.0,           # Chamber air + vaccine contents (J/K)
            Q_compressor=34.0,   # Effective ice-building rate (W) — 10 h solar refills daily melt
            R_door=0.24,         # Chest-style SDD door conductance (K/W)
            C_air=5000.0,        # Air + near-surface (chest: less air exchange) (J/K)
            R_air_contents=0.6,  # Chest: slower air-contents coupling (cold air pooled)
            T_setpoint_low=2.0,
            T_setpoint_high=5.0,
            initial_tvc=4.0,
            # Icebank: 30 kg ice × 334 kJ/kg = 10,020,000 J.
            # Holdover: ~5.4 days at +43 °C, ~10 days at +24 °C.
            icebank_capacity_j=10_020_000.0 * 0.85, # Assume 85% usable capacity to account for inefficiencies and non-idealities.
            icebank_initial_soc=1.0,
            R_icebank=0.375,     # Chamber-to-icebank coupling (K/W)
            compressor_targets_icebank=True,
        )
        events = EventConfig(door_rate_per_hour=0.5)
    else:
        thermal = ThermalConfig(
            R=1.63,              # Same insulation quality (PQS requirement)
            C=50000.0,           # Chamber air + vaccine contents (J/K)
            Q_compressor=50.0,   # Effective ice-building rate (W) — continuous power
            R_door=0.15,         # Cabinet-style door conductance (K/W)
            C_air=3000.0,        # Air + near-surface (upright: rapid air exchange) (J/K)
            R_air_contents=0.4,  # Upright: faster air-contents coupling
            T_setpoint_low=2.0,
            T_setpoint_high=8.0,
            initial_tvc=5.0,
            # Icebank: 30 kg ice × 334 kJ/kg = 10,020,000 J.
            # Holdover: ~5.4 days at +43 °C, ~10 days at +24 °C.
            icebank_capacity_j=10_020_000.0 * 0.85, # Assume 85% usable capacity to account for inefficiencies and non-idealities.
            icebank_initial_soc=1.0,
            R_icebank=0.375,     # Chamber-to-icebank coupling (K/W)
            compressor_targets_icebank=True,
        )
        events = EventConfig()

    return SimulationConfig(
        thermal=thermal,
        ambient=ambient,
        power=power,
        events=events,
    )
