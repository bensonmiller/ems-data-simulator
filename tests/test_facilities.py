import pytest
from utils.facilities import random_facility

@pytest.fixture
def facility():
    return random_facility()


def test_facility_retrieval(facility):
    """Test if the facility is retrieved correctly."""
    facility = facility
    assert facility is not None
    assert facility.globalid is not None
    assert facility.facility_name is not None
    assert facility.latitude is not None
    assert facility.longitude is not None
    

def test_latlng_type(facility):
    """Test if the latitude and longitude are of the correct type."""
    facility = facility
    assert isinstance(facility.latitude, float)
    assert isinstance(facility.longitude, float)
