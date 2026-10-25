import pytest

import pyJianYingDraft as draft
from pyJianYingDraft import TrackRef, TrackSpec

from tests.helpers import fake_audio_material, fake_video_material, parse_dump


def test_append_track_returns_track_ref_and_appends_to_end():
    script = draft.ScriptFile(1920, 1080, 30, True)

    first_ref = script.append_track(TrackSpec(draft.TrackType.video, "first"))
    second_ref = script.append_track(TrackSpec(draft.TrackType.video, "second"))

    assert isinstance(first_ref, TrackRef)
    assert isinstance(second_ref, TrackRef)
    assert [track.name for track in script.tracks.values()] == ["first", "second"]


def test_append_tracks_preserves_input_order():
    script = draft.ScriptFile(1920, 1080, 30, True)

    refs = script.append_tracks([
        TrackSpec(draft.TrackType.video, "first"),
        TrackSpec(draft.TrackType.audio, "second"),
        TrackSpec(draft.TrackType.text, "third"),
    ])

    assert [ref.name for ref in refs] == ["first", "second", "third"]
    dumped = parse_dump(script)
    assert [track["name"] for track in dumped["tracks"]] == ["first", "second", "third"]


def test_add_segment_accepts_track_ref():
    script = draft.ScriptFile(1920, 1080, 30, True)
    track_ref = script.append_track(TrackSpec(draft.TrackType.video, "video_track"))

    segment = draft.VideoSegment(fake_video_material(), draft.trange("0s", "2s"))
    script.add_segment(segment, track=track_ref)

    dumped = parse_dump(script)
    assert dumped["tracks"][0]["name"] == "video_track"
    assert dumped["tracks"][0]["segments"][0]["material_id"] == "video-material-id"


def test_add_segment_rejects_foreign_track_ref():
    script_a = draft.ScriptFile(1920, 1080, 30, True)
    script_b = draft.ScriptFile(1920, 1080, 30, True)
    foreign_ref = script_a.append_track(TrackSpec(draft.TrackType.audio, "audio_track"))

    segment = draft.AudioSegment(fake_audio_material(), draft.trange("0s", "1s"))

    with pytest.raises(ValueError):
        script_b.add_segment(segment, track=foreign_ref)
