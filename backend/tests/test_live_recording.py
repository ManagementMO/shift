import struct

import pytest

HEADER = struct.Struct("<4sII8If")
ROW = struct.Struct("<IffffBBH")
COUNTS = {"total": 1, "not_departed": 0, "walking": 1, "waiting": 0, "riding": 0, "driving": 0, "arrived": 0, "unroutable": 0}


def decode(data):
    frames = []
    offset = 0
    while offset < len(data):
        header = HEADER.unpack_from(data, offset)
        assert header[0] == b"CSF1"
        offset += HEADER.size
        rows = [ROW.unpack_from(data, offset + i * ROW.size) for i in range(header[2])]
        offset += header[2] * ROW.size
        frames.append((header, rows))
    assert offset == len(data)
    return frames


def test_recording_is_compact_ordered_and_preserves_world_coordinates(tmp_path):
    from cityshift.live.recording import FrameStore

    store = FrameStore(tmp_path)
    store.append(0, [(7, 123.5, -44.25, 90, 1.3, 1, 1)], COUNTS, 20)
    frames = decode(store.read_chunk(0))
    assert len(frames) == 1
    assert frames[0][0][1:4] == (0, 1, 1)
    assert frames[0][1][0][:4] == (7, 123.5, -44.25, 90)
    assert len(store.read_chunk(0)) == 72
    assert store.latest_s == 0
    assert FrameStore(tmp_path).read_chunk(0) == store.read_chunk(0)


def test_recording_splits_chunks_and_refuses_uncomputed_time(tmp_path):
    from cityshift.live.recording import FrameStore

    store = FrameStore(tmp_path)
    for t in range(12):
        store.append(t, [(0, t, 0, 0, 1, 1, 1)], COUNTS, 20)
    assert [h[1] for h, _ in decode(store.read_chunk(0))] == list(range(10))
    assert [h[1] for h, _ in decode(store.read_chunk(10))] == [10, 11]
    with pytest.raises(KeyError):
        store.read_chunk(20)
    with pytest.raises(ValueError):
        store.append(11, [], COUNTS, 20)
    with pytest.raises(ValueError):
        store.append(15, [], COUNTS, 20)


def test_child_recording_inherits_only_the_unchanged_past(tmp_path):
    from cityshift.live.recording import FrameStore

    parent = FrameStore(tmp_path / "parent")
    for t in range(13):
        parent.append(t, [(0, t, 0, 0, 1, 1, 1)], COUNTS, 20)
    original = parent.read_chunk(0)
    child = FrameStore(tmp_path / "child", parent=parent, fork_s=6)
    child.append(7, [(0, 99, 0, 0, 1, 1, 1)], COUNTS, 0)
    frames = decode(child.read_chunk(0))
    assert [h[1] for h, _ in frames] == list(range(8))
    assert [rows[0][1] for _, rows in frames] == [0, 1, 2, 3, 4, 5, 6, 99]
    assert parent.read_chunk(0) == original
    assert child.latest_s == 7


def test_recording_carries_per_agent_alert_flags_in_the_spare_row_field(tmp_path):
    from cityshift.live.recording import FrameStore

    store = FrameStore(tmp_path)
    store.append(0, [(0, 1, 2, 3, 1, 1, 1), (1, 1, 2, 3, 1, 2, 4, 0b1011)], {**COUNTS, "total": 2, "walking": 1, "driving": 1}, 20)
    frames = decode(store.read_chunk(0))
    assert [row[7] for row in frames[0][1]] == [0, 0b1011]
    with pytest.raises(ValueError):
        store.append(1, [(0, 1, 2, 3, 1, 1, 1, 70000)], {**COUNTS, "total": 2, "walking": 1, "driving": 1}, 20)
    assert store.latest_s == 0


def test_recording_rejects_nonfinite_positions_and_inconsistent_cohort_counts(tmp_path):
    from cityshift.live.recording import FrameStore

    store = FrameStore(tmp_path)
    with pytest.raises(ValueError):
        store.append(0, [(0, float("nan"), 0, 0, 1, 1, 1)], COUNTS, 20)
    with pytest.raises(ValueError):
        store.append(0, [], {**COUNTS, "total": 5}, 20)
    assert store.latest_s == -1
