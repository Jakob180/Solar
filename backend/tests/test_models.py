from __future__ import annotations

from copy import deepcopy

import pytest
from pydantic import ValidationError

from backend.app.models import SimulationRequest


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("location", "latitude"), 91),
        (("location", "longitude"), -181),
        (("roofs", 0, "area_m2"), -1),
        (("roofs", 0, "area_m2"), 0),
        (("roofs", 0, "tilt_deg"), 91),
        (("roofs", 0, "azimuth_deg"), 360),
        (("panel", "efficiency"), 22),
        (("panel", "power_wp"), 0),
    ],
)
def test_invalid_physical_input_is_rejected(valid_payload, path, value):
    payload = deepcopy(valid_payload)
    target = payload
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_panel_count_cannot_exceed_usable_area(valid_payload):
    payload = deepcopy(valid_payload)
    payload["roofs"][0]["area_m2"] = 2
    payload["roofs"][0]["coverage_percent"] = 50
    payload["roofs"][0]["panel_count"] = 1
    with pytest.raises(ValidationError, match="fits at most 0 modules"):
        SimulationRequest.model_validate(payload)


def test_coverage_alias_and_automatic_panel_count_are_accepted(valid_payload):
    payload = deepcopy(valid_payload)
    payload["roofs"][0].pop("panel_count")
    request = SimulationRequest.model_validate(payload)
    assert request.roofs[0].panel_coverage_percent == 80
    assert request.roofs[0].panel_count is None


def test_invalid_window_and_unknown_timezone_are_rejected(valid_payload):
    payload = deepcopy(valid_payload)
    payload["simulation"] = {"start": "2025-06-22", "end": "2025-06-21"}
    with pytest.raises(ValidationError, match="on or after"):
        SimulationRequest.model_validate(payload)

    payload = deepcopy(valid_payload)
    payload["location"]["timezone"] = "Mars/Olympus_Mons"
    with pytest.raises(ValidationError, match="Unknown IANA timezone"):
        SimulationRequest.model_validate(payload)
