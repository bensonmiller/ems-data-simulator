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

    tvc: Current vaccine chamber temperature (°C).  When the two-node
         air/contents model is active (C_air > 0), this is the *air*
         temperature — what the TVC probe reads.
    compressor_on: Whether the compressor is currently running.
    icebank_soc: Icebank state of charge (0.0–1.0). 1.0 = fully frozen.
    tvc_contents: Bulk contents temperature (°C).  Only used when
         C_air > 0 (two-node model).  None = initialise from tvc.
    """
    tvc: float
    compressor_on: bool
    icebank_soc: float = 1.0
    tvc_contents: Optional[float] = None


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

    When C_air > 0, uses a two-node air/contents model:

        Node "air" (TVC probe, C_air):
            C_air · dT_air/dt = (TAMB - T_air)/R
                              + (TAMB - T_air)/R_door · door_open
                              + (T_contents - T_air)/R_air_contents
                              - (T_air - T_ice)/R_icebank        [if icebank]

        Node "contents" (vaccines, C - C_air):
            C_contents · dT_contents/dt = (T_air - T_contents)/R_air_contents

    This captures the rapid TVC spike when an upright fridge door opens
    (cold air dumps out, C_air is small) followed by recovery as the warm
    air re-equilibrates with cold contents and icebank.  The steady-state
    TVC matches the single-node model because air and contents converge.

    When C_air = 0, falls back to the legacy single-node model:
        C · dTVC/dt = (TAMB - TVC)/R + door_term - icebank_term

    The thermostat uses hysteresis:
        - Compressor turns ON when TVC >= T_setpoint_high
        - Compressor turns OFF when TVC <= T_setpoint_low
    """

    def __init__(self, config: ThermalConfig):
        self.config = config
        self.rc = config.R * config.C
        # Two-node air/contents model: when C_air > 0 the chamber is
        # split into a fast "air" node (TVC probe) and a slow "contents"
        # node.  Door heat enters the air; contents couple to the icebank.
        self._two_node = config.C_air > 0
        if self._two_node:
            self._c_air = config.C_air
            self._c_contents = config.C - config.C_air

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

        When C_air > 0, uses the two-node air/contents model (see class
        docstring).  Otherwise falls back to the legacy single-node model.

        When an icebank is present (icebank_capacity_j > 0), the icebank
        acts as a 0 °C latent-heat reservoir coupled to the air node
        (two-node) or the chamber (single-node).  The compressor builds
        ice; ambient + door heat melts it indirectly via elevated TVC.

        When the icebank is depleted (SOC = 0) or absent, falls back to
        direct compressor cooling of the contents / chamber.

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
        tvc_contents = state.tvc_contents if state.tvc_contents is not None else tvc
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
            if self._two_node:
                # Two-node air/contents model.
                #
                # Node 1 — "air" (TVC probe, C_air): heated by ambient
                #   (through walls) and door infiltration; cooled by
                #   icebank (whose surface is exposed to the air space)
                #   and by coupling to cold contents.
                # Node 2 — "contents" (vaccines, C_contents): coupled
                #   to air via R_air_contents.  Large thermal mass, so
                #   contents barely change during brief door events.
                #
                # When the door opens on an upright fridge the cold air
                # dumps out and TVC spikes quickly (low C_air).  After
                # the door closes, TVC recovers via the icebank pull and
                # contact with cold contents.  The equilibrium TVC with
                # door closed matches the single-node model because air
                # and contents converge to the same temperature.
                q_ambient = (tamb - tvc) / cfg.R
                q_door = (tamb - tvc) / cfg.R_door if door_open else 0.0
                q_air_contents = (tvc_contents - tvc) / cfg.R_air_contents

                if has_icebank and icebank_soc > 0:
                    T_ice = 0.0
                    q_to_icebank = (tvc - T_ice) / cfg.R_icebank

                    dT_air = (q_ambient + q_door + q_air_contents - q_to_icebank) / self._c_air
                    tvc += dT_air * dt_step

                    dT_contents = (-q_air_contents) / self._c_contents
                    tvc_contents += dT_contents * dt_step

                    icebank_heat_w = q_to_icebank - (q_comp if compressor_on else 0.0)
                    icebank_soc -= (icebank_heat_w * dt_step) / cfg.icebank_capacity_j
                    icebank_soc = max(0.0, min(1.0, icebank_soc))
                else:
                    dT_air = (q_ambient + q_door + q_air_contents) / self._c_air
                    tvc += dT_air * dt_step

                    if compressor_on and has_icebank and cfg.compressor_targets_icebank:
                        icebank_soc += (q_comp * dt_step) / cfg.icebank_capacity_j
                        icebank_soc = min(1.0, icebank_soc)
                        dT_contents = (-q_air_contents) / self._c_contents
                    elif compressor_on:
                        dT_contents = (-q_air_contents - q_comp) / self._c_contents
                    else:
                        dT_contents = (-q_air_contents) / self._c_contents
                    tvc_contents += dT_contents * dt_step

            elif has_icebank and icebank_soc > 0:
                # Legacy single-node + icebank model.
                T_ice = 0.0
                q_ambient = (tamb - tvc) / cfg.R
                q_to_icebank = (tvc - T_ice) / cfg.R_icebank
                q_door = (tamb - tvc) / cfg.R_door if door_open else 0.0

                dT = (q_ambient - q_to_icebank + q_door) / cfg.C
                tvc += dT * dt_step

                icebank_heat_w = q_to_icebank - (q_comp if compressor_on else 0.0)
                icebank_soc -= (icebank_heat_w * dt_step) / cfg.icebank_capacity_j
                icebank_soc = max(0.0, min(1.0, icebank_soc))
            else:
                # Legacy single-node RC model (no icebank or depleted).
                dT = (tamb - tvc) / self.rc
                if door_open:
                    dT += (tamb - tvc) / (cfg.R_door * cfg.C)

                if compressor_on and has_icebank and cfg.compressor_targets_icebank:
                    icebank_soc += (q_comp * dt_step) / cfg.icebank_capacity_j
                    icebank_soc = min(1.0, icebank_soc)
                elif compressor_on:
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
            tvc_contents=tvc_contents if self._two_node else None,
        )
        return new_state, record
