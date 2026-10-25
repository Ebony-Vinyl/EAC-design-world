import pyJianYingDraft as draft

from pyJianYingDraft.metadata import AudioSceneEffectType, ToneEffectType

from tests.helpers import fake_audio_material, parse_dump


def test_tone_effect_type_is_exported_from_top_level():
    assert draft.ToneEffectType is ToneEffectType


def test_tone_effect_exports_minimal_shape():
    script = draft.ScriptFile(1920, 1080, 30, True)
    script.append_track(draft.TrackSpec(draft.TrackType.audio))

    segment = draft.AudioSegment(fake_audio_material(), draft.trange("0s", "2s"))
    segment.add_effect(ToneEffectType.机器人, [100])
    script.add_segment(segment)

    dumped = parse_dump(script)
    effect_json = dumped["materials"]["audio_effects"][0]
    segment_json = dumped["tracks"][0]["segments"][0]

    assert set(effect_json.keys()) == {"audio_adjust_params", "id", "name", "resource_id", "type"}
    assert effect_json["audio_adjust_params"][0]["name"] == "强弱"
    assert effect_json["audio_adjust_params"][0]["value"] == 1.0
    assert dumped["materials"]["audio_effects"][0]["id"] in segment_json["extra_material_refs"]
    assert len(segment_json["extra_material_refs"]) == 2


def test_audio_scene_effect_keeps_legacy_export_shape():
    script = draft.ScriptFile(1920, 1080, 30, True)
    script.append_track(draft.TrackSpec(draft.TrackType.audio))

    segment = draft.AudioSegment(fake_audio_material(), draft.trange("0s", "2s"))
    segment.add_effect(next(iter(AudioSceneEffectType)))
    script.add_segment(segment)

    dumped = parse_dump(script)
    effect_json = dumped["materials"]["audio_effects"][0]

    assert effect_json["category_id"] == "sound_effect"
    assert effect_json["category_name"] == "场景音"
    assert effect_json["sub_type"] == 1
    assert effect_json["time_range"] == {"duration": 0, "start": 0}
