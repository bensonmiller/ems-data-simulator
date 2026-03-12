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

    cumulative_powered_s: Total seconds with power available (ACCD or DCCD).
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
            sva = 0
            acsv = 0.0
            powered_s = 0.0
        else:
            sva = self.config.nominal_voltage
            # Add small voltage variation
            acsv = round(sva + self.rng.gauss(0, sva * 0.02), 1)
            powered_s = interval_s

        state.cumulative_powered_s += powered_s

        readings = {
            'SVA': sva,
            'ACCD': round(powered_s, 1),
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

        # DCCD: cumulative seconds with DC power available to the compressor
        powered_s = interval_s if solar_power_available else 0.0
        state.cumulative_powered_s += powered_s

        # BLOG/BEMD: logger battery voltage mapped from SOC
        blog = round(self.config.blog_voltage_empty + state.battery_soc * self.config.blog_voltage_range, 1)

        readings = {
            'DCSV': dcsv,
            'DCCD': round(powered_s, 1),
            'BLOG': blog,
            'BEMD': blog,
        }
        return state, readings

    def is_power_available(self, state: PowerState, timestamp: dt.datetime) -> bool:
        """Compressor power is available only when solar voltage is sufficient."""
        dcsv = self._solar_voltage(timestamp)
        return dcsv >= self.config.min_operating_voltage
