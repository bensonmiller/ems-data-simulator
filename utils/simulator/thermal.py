"""
RC-circuit thermal model with thermostat control for CCE simulation.

Models the vaccine chamber temperature (TVC) as a thermal mass exchanging
heat with the environment, cooled by a compressor, and heated by door openings.
"""

import math
import random
import datetime as dt
from dataclasses import dataclass
from typing import List, Optional, Tuple

from utils.simulator.config import ThermalConfig, AmbientConfig


@dataclass
class DoorEvent:
    """A single door opening event within a sample interval.

    start_offset_s: Seconds from interval start when door opens.
    duration_s: How long the door stays open (seconds).
    """
    start_offset_s: float
    duration_s: float


@dataclass
class ThermalState:
    """Mutable state carried between simulation intervals.

    tvc: Current vaccine chamber temperature (°C).
    compressor_on: Whether the compressor is currently running.
    icebank_soc: Icebank state of charge (0.0–1.0). 1.0 = fully frozen.
    """
    tvc: float
    compressor_on: bool
    icebank_soc: float = 1.0


class AmbientModel:
    """Generates ambient temperature following a daily sinusoidal cycle with noise."""

    def __init__(self, config: AmbientConfig, rng: random.Random):
        self.config = config
        self.rng = rng

    def get_tamb(self, timestamp: dt.datetime) -> float:
        """Compute ambient temperature for a given timestamp.

        Uses a sinusoidal daily cycle peaking at config.peak_hour,
        plus Gaussian noise.
        """
        hour = timestamp.hour + timestamp.minute / 60.0 + timestamp.second / 3600.0
        # Sinusoidal: peak at peak_hour, trough 12 hours later
        phase = 2.0 * math.pi * (hour - self.config.peak_hour) / 24.0
        base = self.config.T_mean + self.config.T_amplitude * math.cos(phase)
        noise = self.rng.gauss(0, self.config.noise_sigma)
        return round(base + noise, 1)


class ThermalModel:
    """RC-circuit thermal simulation with thermostat control.

    The ODE governing TVC is:
        dTVC/dt = (TAMB - TVC) / (R * C)
                - (Q_compressor * compressor_on) / C
                + (TAMB - TVC) / (R_door * C) * door_open

    The thermostat uses hysteresis:
        - Compressor turns ON when TVC >= T_setpoint_high
        - Compressor turns OFF when TVC <= T_setpoint_low
    """

    def __init__(self, config: ThermalConfig):
        self.config = config
        self.rc = config.R * config.C

    def simulate_interval(
        self,
        state: ThermalState,
        tamb: float,
        interval_s: float,
        compressor_available: bool,
        door_events: Optional[List[DoorEvent]] = None,
        q_compressor_override: Optional[float] = None,
    ) -> Tuple[ThermalState, dict]:
        """Simulate one sample interval using Euler integration.

        When an icebank is present (icebank_capacity_j > 0), uses a two-node
        model where the icebank acts as a 0 °C latent-heat reservoir coupled
        to the chamber.  The compressor cools the icebank (builds ice) and
        ambient heat leaks through walls into the chamber; the chamber is
        also coupled to the icebank which pulls TVC toward 0 °C.

        Energy balance for the icebank (per the holdover calculator paper):
            E_new = E_old + E_compressor - E_leakage_to_icebank - E_door
        where E_leakage_to_icebank = (TVC - 0) / R_icebank * dt.

        When the icebank is depleted (SOC = 0) or absent, falls back to the
        standard single-node RC model.

        Args:
            state: Current thermal state (tvc, compressor_on, icebank_soc).
            tamb: Ambient temperature for this interval (°C).
            interval_s: Duration of the interval (seconds).
            compressor_available: Whether power/mechanics allow compressor to run.
            door_events: List of door openings during this interval.
            q_compressor_override: Override cooling power (for refrigerant leak).

        Returns:
            Tuple of (updated ThermalState, record dict with CMPR, DORV, TVC, TAMB).
        """
        cfg = self.config
        dt_step = cfg.sub_step_seconds
        q_comp = q_compressor_override if q_compressor_override is not None else cfg.Q_compressor

        tvc = state.tvc
        compressor_on = state.compressor_on
        icebank_soc = state.icebank_soc
        has_icebank = cfg.icebank_capacity_j > 0
        cmpr_seconds = 0.0
        dorv_seconds = 0.0

        # Pre-compute which sub-steps have door open
        n_steps = int(interval_s / dt_step)
        door_open_at_step = [False] * n_steps
        if door_events:
            for event in door_events:
                start_step = int(event.start_offset_s / dt_step)
                end_step = int((event.start_offset_s + event.duration_s) / dt_step)
                for s in range(max(0, start_step), min(n_steps, end_step)):
                    door_open_at_step[s] = True

        for step_i in range(n_steps):
            door_open = door_open_at_step[step_i]
            if door_open:
                dorv_seconds += dt_step

            # --- Thermostat logic ---
            if compressor_available:
                if has_icebank and cfg.compressor_targets_icebank and icebank_soc > 0:
                    # SDD/ILR with charged icebank: run whenever power is
                    # available to maximize ice building.  Real SDDs run
                    # continuously during solar hours — the SOC clamp
                    # handles the full case.
                    compressor_on = True
                else:
                    # Standard thermostat with hysteresis.
                    # Also used when icebank is depleted to prevent
                    # overcooling TVC while the icebank recharges.
                    if not compressor_on and tvc >= cfg.T_setpoint_high:
                        compressor_on = True
                    elif compressor_on and tvc <= cfg.T_setpoint_low:
                        compressor_on = False
            else:
                compressor_on = False

            if compressor_on:
                cmpr_seconds += dt_step

            # --- Thermal dynamics ---
            if has_icebank and icebank_soc > 0:
                # Two-node model: chamber coupled to ambient AND icebank.
                # Icebank temperature is clamped at 0 °C during phase change.
                T_ice = 0.0

                # Heat flows into/out of the chamber (W)
                q_ambient = (tamb - tvc) / cfg.R          # Walls → chamber
                q_to_icebank = (tvc - T_ice) / cfg.R_icebank  # Chamber → icebank
                q_door = (tamb - tvc) / cfg.R_door if door_open else 0.0

                # Chamber temperature change
                dT = (q_ambient - q_to_icebank + q_door) / cfg.C
                tvc += dT * dt_step

                # Icebank energy balance:
                #   Melting (positive) = heat from chamber to icebank
                #   Freezing (negative) = compressor cooling
                icebank_heat_w = q_to_icebank - (q_comp if compressor_on else 0.0)
                icebank_soc -= (icebank_heat_w * dt_step) / cfg.icebank_capacity_j
                icebank_soc = max(0.0, min(1.0, icebank_soc))
            else:
                # Single-node RC model (no icebank or icebank depleted).
                dT = (tamb - tvc) / self.rc
                if door_open:
                    dT += (tamb - tvc) / (cfg.R_door * cfg.C)

                if compressor_on and has_icebank and cfg.compressor_targets_icebank:
                    # Icebank exists but is depleted — compressor energy
                    # recharges the icebank rather than cooling the chamber.
                    icebank_soc += (q_comp * dt_step) / cfg.icebank_capacity_j
                    icebank_soc = min(1.0, icebank_soc)
                elif compressor_on:
                    # No icebank — compressor cools TVC directly.
                    dT -= q_comp / cfg.C

                tvc += dT * dt_step

        record = {
            'TVC': round(tvc, 1),
            'TAMB': round(tamb, 1),
            'CMPR': int(cmpr_seconds),
            'DORV': int(dorv_seconds),
            'ICESOC': round(icebank_soc, 4) if has_icebank else None,
        }

        new_state = ThermalState(
            tvc=tvc, compressor_on=compressor_on, icebank_soc=icebank_soc,
        )
        return new_state, record
