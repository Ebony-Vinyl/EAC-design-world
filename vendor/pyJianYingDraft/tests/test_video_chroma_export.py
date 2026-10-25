import pytest

import pyJianYingDraft as draft

from tests.helpers import fake_video_material, parse_dump


def test_video_chroma_exports_minimal_shape():
    script = draft.ScriptFile(1920, 1080, 30, True)
    script.append_track(draft.TrackSpec(draft.TrackType.video))

    segment = draft.VideoSegment(fake_video_material(), draft.trange("0s", "2s"))
    segment.add_chroma(color="#E2ECD0FF", intensity=20)
    script.add_segment(segment)

    dumped = parse_dump(script)
    chroma_json = dumped["materials"]["chromas"][0]
    segment_json = dumped["tracks"][0]["segments"][0]

    assert chroma_json == {
        "color": "#e2ecd0ff",
        "edge_smooth_value": 0.0,
        "id": chroma_json["id"],
        "intensity_value": 0.2,
        "shadow_value": 0.0,
        "should_transfer_color": True,
        "spill_value": 0.0,
        "type": "chroma",
        "version": "v2",
    }
    assert chroma_json["id"] in segment_json["extra_material_refs"]
    assert len(segment_json["extra_material_refs"]) == 2


def test_video_chroma_exports_adjusted_params():
    script = draft.ScriptFile(1920, 1080, 30, True)
    script.append_track(draft.TrackSpec(draft.TrackType.video))

    segment = draft.VideoSegment(fake_video_material(), draft.trange("0s", "2s"))
    segment.add_chroma(
        color="#EFF5DFFF",
        intensity=15,
        shadow=99,
        edge_smooth=61,
        spill=83,
    )
    script.add_segment(segment)

    dumped = parse_dump(script)
    chroma_json = dumped["materials"]["chromas"][0]

    assert chroma_json["color"] == "#eff5dfff"
    assert chroma_json["intensity_value"] == 0.15
    assert chroma_json["shadow_value"] == 0.99
    assert chroma_json["edge_smooth_value"] == 0.61
    assert chroma_json["spill_value"] == 0.83


def test_video_chroma_rejects_duplicate_or_invalid_values():
    segment = draft.VideoSegment(fake_video_material(), draft.trange("0s", "2s"))
    segment.add_chroma(color="#E2ECD0FF")

    with pytest.raises(ValueError):
        segment.add_chroma(color="#E2ECD0FF")

    with pytest.raises(ValueError):
        draft.VideoSegment(fake_video_material(), draft.trange("0s", "2s")).add_chroma(
            color="#E2ECD0FF",
            intensity=101,
        )

    with pytest.raises(ValueError):
        draft.VideoSegment(fake_video_material(), draft.trange("0s", "2s")).add_chroma(
            color="#E2ECD0",
        )
