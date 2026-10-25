import pyJianYingDraft as draft
import pytest

from tests.helpers import fake_audio_material, fake_video_material, parse_dump


def test_append_track_allows_first_unnamed_track_per_type():
    script = draft.ScriptFile(1920, 1080, 30, True)

    script.append_track(draft.TrackSpec(draft.TrackType.video))

    assert "video" in script.tracks
    assert script.tracks["video"].track_type is draft.TrackType.video


def test_append_track_requires_name_for_second_same_type_track():
    script = draft.ScriptFile(1920, 1080, 30, True)
    script.append_track(draft.TrackSpec(draft.TrackType.video))

    with pytest.raises(NameError):
        script.append_track(draft.TrackSpec(draft.TrackType.video))


def test_add_segment_updates_script_duration():
    script = draft.ScriptFile(1920, 1080, 30, True)
    script.append_track(draft.TrackSpec(draft.TrackType.audio))

    segment = draft.AudioSegment(fake_audio_material(), draft.trange("2s", "3s"))
    script.add_segment(segment)

    assert script.duration == draft.tim("5s")


def test_add_segment_auto_registers_materials_and_effect_refs():
    script = draft.ScriptFile(1920, 1080, 30, True)
    script.append_track(draft.TrackSpec(draft.TrackType.video))

    segment = draft.VideoSegment(fake_video_material(), draft.trange("0s", "2s"))
    segment.add_fade("0.2s", "0.3s")
    segment.add_animation(next(iter(draft.IntroType)))
    script.add_segment(segment)

    dumped = parse_dump(script)
    track_json = dumped["tracks"][0]
    segment_json = track_json["segments"][0]

    assert len(dumped["materials"]["videos"]) == 1
    assert len(dumped["materials"]["audio_fades"]) == 1
    assert len(dumped["materials"]["material_animations"]) == 1
    assert segment_json["material_id"] == dumped["materials"]["videos"][0]["id"]
    assert dumped["materials"]["audio_fades"][0]["id"] in segment_json["extra_material_refs"]
    assert dumped["materials"]["material_animations"][0]["id"] in segment_json["extra_material_refs"]


def test_dumps_orders_tracks_by_track_order():
    script = draft.ScriptFile(1920, 1080, 30, True)
    foreground_ref = script.append_track(draft.TrackSpec(draft.TrackType.video, "foreground"))
    script.insert_track(
        draft.TrackSpec(draft.TrackType.video, "background"),
        under_track=foreground_ref,
    )

    dumped = parse_dump(script)

    assert [track["name"] for track in dumped["tracks"]] == ["background", "foreground"]
    assert [track["segments"] for track in dumped["tracks"]] == [[], []]
