import pyJianYingDraft as draft

from tests.helpers import parse_dump, write_srt


def test_import_srt_creates_text_track_when_missing(tmp_path):
    srt_path = write_srt(
        tmp_path,
        "1\n00:00:00,000 --> 00:00:01,000\n第一行\n\n"
        "2\n00:00:01,500 --> 00:00:02,000\n第二行\n",
    )
    script = draft.ScriptFile(1920, 1080, 30, True)

    script.import_srt(str(srt_path), "captions")

    assert "captions" in script.tracks
    assert len(script.tracks["captions"].segments) == 2
    assert [segment.text for segment in script.tracks["captions"].segments] == ["第一行", "第二行"]


def test_import_srt_applies_time_offset(tmp_path):
    srt_path = write_srt(
        tmp_path,
        "1\n00:00:00,000 --> 00:00:01,000\n偏移测试\n",
    )
    script = draft.ScriptFile(1920, 1080, 30, True)

    script.import_srt(str(srt_path), "captions", time_offset="1s")

    segment = script.tracks["captions"].segments[0]
    assert segment.start == draft.tim("1s")
    assert segment.duration == draft.tim("1s")


def test_import_srt_uses_style_reference_when_provided(tmp_path):
    srt_path = write_srt(
        tmp_path,
        "1\n00:00:00,000 --> 00:00:01,000\n样式继承\n",
    )
    script = draft.ScriptFile(1920, 1080, 30, True)
    reference = draft.TextSegment(
        "参考",
        draft.trange("0s", "1s"),
        style=draft.TextStyle(size=9.5, align=1, color=(1.0, 0.5, 0.0)),
        clip_settings=draft.ClipSettings(transform_y=-0.6),
    )

    script.import_srt(str(srt_path), "captions", style_reference=reference, clip_settings=None)

    segment = script.tracks["captions"].segments[0]
    assert segment.style.size == 9.5
    assert segment.style.align == 1
    assert segment.style.color == (1.0, 0.5, 0.0)
    assert segment.clip_settings.transform_y == -0.6


def test_import_srt_inserts_new_text_track_after_video_and_text_tracks(tmp_path):
    srt_path = write_srt(
        tmp_path,
        "1\n00:00:00,000 --> 00:00:01,000\n字幕\n",
    )
    script = draft.ScriptFile(1920, 1080, 30, True)
    video_ref = script.append_track(draft.TrackSpec(draft.TrackType.video, "video"))
    script.append_track(draft.TrackSpec(draft.TrackType.effect, "effect"))
    script.insert_track(
        draft.TrackSpec(draft.TrackType.text, "title"),
        over_track=video_ref,
    )

    script.import_srt(str(srt_path), "captions")

    dumped = parse_dump(script)
    assert [track["name"] for track in dumped["tracks"]] == ["video", "title", "captions", "effect"]
