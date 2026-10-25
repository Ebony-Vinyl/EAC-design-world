"""Shared test helpers for future test modules."""

from __future__ import annotations

import json
from pathlib import Path

from pyJianYingDraft.local_materials import AudioMaterial, CropSettings, VideoMaterial


def fake_video_material(
    *,
    material_id: str = "video-material-id",
    material_name: str = "video.mp4",
    path: str = "/tmp/video.mp4",
    duration: int = 5_000_000,
    width: int = 1920,
    height: int = 1080,
    material_type: str = "video",
) -> VideoMaterial:
    """Create a VideoMaterial instance without touching real media files."""
    material = object.__new__(VideoMaterial)
    material.material_id = material_id
    material.local_material_id = ""
    material.material_name = material_name
    material.path = path
    material.duration = duration
    material.width = width
    material.height = height
    material.crop_settings = CropSettings()
    material.material_type = material_type
    return material


def fake_audio_material(
    *,
    material_id: str = "audio-material-id",
    material_name: str = "audio.mp3",
    path: str = "/tmp/audio.mp3",
    duration: int = 5_000_000,
) -> AudioMaterial:
    """Create an AudioMaterial instance without touching real media files."""
    material = object.__new__(AudioMaterial)
    material.material_id = material_id
    material.material_name = material_name
    material.path = path
    material.duration = duration
    return material


def parse_dump(script) -> dict:
    """Parse ScriptFile.dumps() into a Python dictionary."""
    return json.loads(script.dumps())


def write_srt(tmp_path: Path, content: str, name: str = "subtitles.srt") -> Path:
    """Write SRT content into a temporary file and return its path."""
    path = tmp_path / name
    path.write_text(content, encoding="utf-8")
    return path
