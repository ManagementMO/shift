import json
import math

from cityshift.transport.runner import EntityTrack, sample


def test_sample_replaces_non_finite_angle_and_speed_with_previous_values():
    tr = EntityTrack(entity_id="bus_A", kind="bus", samples=[])
    sample(tr, 10, -79.38, 43.64, 90.0, 5.5)
    sample(tr, 11, -79.381, 43.641, math.inf, math.nan)
    assert tr.samples[1][3] == 90.0
    assert tr.samples[1][4] == 5.5
    # first sample with nothing to fall back on becomes 0.0, so the artifact is always valid JSON
    tr2 = EntityTrack(entity_id="bus_B", kind="bus", samples=[])
    sample(tr2, 0, -79.38, 43.64, -math.inf, math.inf)
    assert tr2.samples[0][3:] == [0.0, 0.0]
    json.loads(json.dumps([tr.samples, tr2.samples], allow_nan=False))


def test_sample_skips_invalid_positions_and_breaks_the_trail():
    # TraCI reports INVALID_DOUBLE_VALUE positions while a vehicle is teleporting; projected they become ±inf.
    tr = EntityTrack(entity_id="car_1", kind="car", samples=[])
    sample(tr, 10, -79.38, 43.64, 90.0, 5.5)
    sample(tr, 11, math.inf, math.inf, -1073741824.0, -1073741824.0)
    sample(tr, 12, math.inf, math.inf, -1073741824.0, -1073741824.0)
    sample(tr, 13, -79.39, 43.65, 90.0, 5.0)
    assert [s[0] for s in tr.samples] == [10, 13], "no measured position => no sample"
    assert tr.breaks == [1], "the trail must not be interpolated across the gap (break before the next sample)"
    json.loads(json.dumps(tr.model_dump(), allow_nan=False))
