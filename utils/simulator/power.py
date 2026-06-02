"""
Power system models for mains-powered and solar direct drive (SDD) refrigerators.

Each model determines when the compressor can run and produces
power-related telemetry fields for the output records.
"""

import math
import random
import datetime as dt
from dataclasses import dataclass
from typing import Optional, Tuple

from utils.simulator.config import PowerConfig


@dataclass
class PowerState:
    """Mutable power system state carried between intervals.

    cumulative_powered_s: Total seconds with power available (tracked for
        state continuity across intervals; not emitted directly).
    battery_soc: State of charge for the logger battery (0.0 to 1.0).
        For SDD fridges this is the small backup battery that powers the
        data logger, NOT a battery for the compressor.
    in_outage: Whether a mains outage is currently active.
    outage_end: Timestamp when current outage ends (mains only).
    """
    cumulative_powered_s: float = 0.0
    battery_soc: float = 0.8
    in_outage: bool = False
    outage_end: Optional[dt.datetime] = None


class MainsPowerModel:
    """Mains power with stochastic outage events."""

    def __init__(self, config: PowerConfig, rng: random.Random):
        self.config = config
        self.rng = rng

    def _check_outage(self, state: PowerState, timestamp: dt.datetime, interval_s: float) -> PowerState:
        """Update outage state for the current interval."""
        if state.in_outage:
            if state.outage_end is not None and timestamp >= state.outage_end:
                state.in_outage = False
                state.outage_end = None
        else:
            # Probability of starting an outage in this interval
            hours = interval_s / 3600.0
            p = 1.0 - (1.0 - self.config.outage_probability_per_hour) ** hours
            if self.rng.random() < p:
                duration_h = self.rng.expovariate(1.0 / self.config.mean_outage_duration_hours)
                state.in_outage = True
                state.outage_end = timestamp + dt.timedelta(hours=duration_h)
        return state

    def simulate_interval(
        self,
        state: PowerState,
        timestamp: dt.datetime,
        interval_s: float,
        compressor_runtime_s: float,
    ) -> Tuple[PowerState, dict]:
        """Compute power readings for one interval.

        Returns:
            Tuple of (updated PowerState, dict with SVA, ACCD, ACSV).
        """
        state = self._check_outage(state, timestamp, interval_s)

        if state.in_outage:
            acsv = 0.0
            powered_s = 0.0
        else:
            nominal = self.config.nominal_voltage
            # ACSV is the average AC supply voltage; add small variation.
            acsv = round(nominal + self.rng.gauss(0, nominal * 0.02), 1)
            powered_s = interval_s

        state.cumulative_powered_s += powered_s

        # SVA is the number of SECONDS within the (15-min) period that AC voltage
        # was in-bounds: the full interval when powered, 0 during an outage.
        # The interop schema bounds SVA to [0, 900].
        sva = int(round(min(900.0, powered_s)))

        # ACCD is the AC current (amps) drawn by the appliance, modeled from the
        # compressor duty cycle: a small always-on baseline plus the running
        # compressor draw scaled by the fraction of the interval it ran. The
        # interop schema requires ACCD in [0.01, 49.99], so the no-current case
        # (compressor idle or mains outage) is floored to the schema minimum.
        duty = compressor_runtime_s / interval_s if interval_s > 0 else 0.0
        accd = 0.0 if state.in_outage else (
            self.config.mains_baseline_current_a
            + self.config.mains_compressor_current_a * duty
        )
        accd = round(min(49.99, max(0.01, accd)), 2)

        readings = {
            'SVA': sva,
            'ACCD': accd,
            'ACSV': round(acsv, 1),
        }
        return state, readings

    def is_power_available(self, state: PowerState) -> bool:
        return not state.in_outage


class SolarPowerModel:
    """Solar direct drive (SDD) power model.

    In an SDD fridge the compressor runs directly from solar panels — there
    is no electrical battery for the compressor.  Energy is stored thermally
    in the ice lining.  The BLOG field reflects a small primary-cell or
    rechargeable battery that keeps the *data logger* running when solar
    power is unavailable.
    """

    def __init__(self, config: PowerConfig, rng: random.Random):
        self.config = config
        self.rng = rng

    def _solar_voltage(self, timestamp: dt.datetime) -> float:
        """Compute instantaneous DC solar voltage from a bell curve."""
        hour = timestamp.hour + timestamp.minute / 60.0 + timestamp.second / 3600.0
        solar_noon = (self.config.sunrise_hour + self.config.sunset_hour) / 2.0
        daylight_hours = self.config.sunset_hour - self.config.sunrise_hour

        if hour < self.config.sunrise_hour or hour > self.config.sunset_hour:
            return 0.0

        phase = math.pi * (hour - solar_noon) / daylight_hours
        voltage = self.config.peak_dcsv * max(0.0, math.cos(phase))
        # Add noise for cloud variation
        noise = self.rng.gauss(0, voltage * 0.05) if voltage > 0 else 0
        return max(0.0, voltage + noise)

    def simulate_interval(
        self,
        state: PowerState,
        timestamp: dt.datetime,
        interval_s: float,
        compressor_runtime_s: float,
    ) -> Tuple[PowerState, dict]:
        """Compute power readings and update logger battery SOC.

        Returns:
            Tuple of (updated PowerState, dict with DCSV, DCCD, BLOG, BEMD).
        """
        dcsv = round(self._solar_voltage(timestamp), 1)
        solar_power_available = dcsv >= self.config.min_operating_voltage

        # Logger battery dynamics (BLOG)
        # The logger battery is a small cell that charges from solar and
        # slowly drains overnight to keep the logger recording data.
        hours = interval_s / 3600.0
        if solar_power_available:
            # Charge logger battery from solar (fast — small battery)
            charge_rate = self.config.charge_efficiency * 0.3  # SOC/hour
            state.battery_soc += charge_rate * hours
        else:
            # Logger drains battery slowly (very low power draw)
            drain_rate = 0.015  # SOC/hour — small enough to last overnight
            state.battery_soc -= drain_rate * hours

        state.battery_soc = max(0.0, min(1.0, state.battery_soc))

        powered_s = interval_s if solar_power_available else 0.0
        state.cumulative_powered_s += powered_s

        # DCCD is the DC current (amps) drawn by the compressor, modeled from the
        # compressor duty cycle while solar power is available (an SDD compressor
        # runs directly off the panels, so it draws no DC current without solar).
        # The interop schema requires DCCD in [0, 99.9].
        duty = compressor_runtime_s / interval_s if interval_s > 0 else 0.0
        dccd = self.config.solar_compressor_current_a * duty if solar_power_available else 0.0
        dccd = round(min(99.9, max(0.0, dccd)), 2)

        # BLOG/BEMD: estimated DAYS of battery life remaining, scaled from the
        # logger battery state of charge (schema range [0, 9999.9]).
        blog = round(state.battery_soc * self.config.blog_full_days, 1)
        bemd = round(state.battery_soc * self.config.bemd_full_days, 1)

        readings = {
            'DCSV': dcsv,
            'DCCD': dccd,
            'BLOG': blog,
            'BEMD': bemd,
        }
        return state, readings

    def is_power_available(self, state: PowerState, timestamp: dt.datetime) -> bool:
        """Compressor power is available only when solar voltage is sufficient."""
        dcsv = self._solar_voltage(timestamp)
        return dcsv >= self.config.min_operating_voltage
