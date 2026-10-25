from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, List, Optional, Protocol, Sequence, Tuple, Union

from .audio_segment import AudioSegment
from .local_materials import AudioMaterial, VideoMaterial
from .template_mode import EditableTrack, ImportedTrack
from .text_segment import TextSegment
from .track import BaseTrack, Track, TrackRef, TrackSpec
from .video_segment import StickerSegment, VideoSegment

if TYPE_CHECKING:
    from .script_material import ScriptMaterial
    from .segment import BaseSegment


AddableSegment = Union[VideoSegment, StickerSegment, AudioSegment, TextSegment]


class ScriptFileProtocol(Protocol):
    save_path: Optional[str]
    content: Dict[str, Any]

    width: int
    height: int
    fps: int
    duration: int

    maintrack_adsorb: bool

    materials: "ScriptMaterial"
    tracks: Dict[str, Track]

    imported_materials: Dict[str, List[Dict[str, Any]]]
    imported_tracks: List[ImportedTrack]
    _track_ref_owner_id: str

    def _get_imported_material_list(self, material_type: str) -> List[Dict[str, Any]]: ...

    def _next_track_order(self) -> int: ...

    def _list_all_tracks_in_order(self) -> List[BaseTrack]: ...

    def _reindex_track_orders(self, track_list: Sequence[BaseTrack]) -> None: ...

    def _create_internal_track(
        self,
        track_type,
        track_name: Optional[str],
        mute: bool,
        track_order: int,
    ) -> Track: ...

    def _resolve_track_ref(self, track_ref: TrackRef) -> Track: ...

    def _track_to_ref(self, track: Track) -> TrackRef: ...

    def _resolve_insert_index(
        self,
        under_track: Optional[Union[TrackRef, ImportedTrack]],
        over_track: Optional[Union[TrackRef, ImportedTrack]],
        at_index: Optional[int],
    ) -> int: ...

    def _insert_internal_track(self, track_spec: TrackSpec, insert_at: int) -> Track: ...

    def _get_track(self, segment_type: type["BaseSegment"], track: Optional[Union[str, TrackRef]]) -> Track: ...

    def append_track(self, track_spec: TrackSpec) -> TrackRef: ...

    def append_tracks(self, track_specs: Sequence[TrackSpec]) -> Tuple[TrackRef, ...]: ...

    def insert_track(
        self,
        track_spec: TrackSpec,
        *,
        under_track: Optional[Union[TrackRef, ImportedTrack]] = None,
        over_track: Optional[Union[TrackRef, ImportedTrack]] = None,
        at_index: Optional[int] = None,
    ) -> TrackRef: ...

    def insert_tracks(
        self,
        track_specs: Sequence[TrackSpec],
        *,
        under_track: Optional[Union[TrackRef, ImportedTrack]] = None,
        over_track: Optional[Union[TrackRef, ImportedTrack]] = None,
        at_index: Optional[int] = None,
    ) -> Tuple[TrackRef, ...]: ...

    def add_material(self, material: Union[VideoMaterial, AudioMaterial]) -> "ScriptFile": ...

    def add_segment(self, segment: AddableSegment, track: Optional[Union[str, TrackRef]] = None) -> "ScriptFile": ...

    def list_imported_tracks(self, track_type=None) -> Tuple[ImportedTrack, ...]: ...

    def get_imported_track(self, track_type, name: Optional[str] = None, index: Optional[int] = None) -> EditableTrack: ...
