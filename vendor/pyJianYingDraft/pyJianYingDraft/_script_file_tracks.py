from __future__ import annotations

from typing import List, Optional, Sequence, Tuple, Union

from .template_mode import ImportedTrack
from .track import BaseTrack, Track, TrackRef, TrackSpec, TrackType
from ._script_file_protocol import ScriptFileProtocol


class _ScriptFileTrackOps:
    def _next_track_order(self: ScriptFileProtocol) -> int:
        """获取新轨道默认应追加到的内部顺序。"""
        track_list: List[BaseTrack] = []
        track_list.extend(self.imported_tracks)
        track_list.extend(self.tracks.values())
        if len(track_list) == 0:
            return 0
        return max(track.track_order for track in track_list) + 1

    def _list_all_tracks_in_order(self: ScriptFileProtocol) -> List[BaseTrack]:
        """返回按当前内部顺序排列的全部轨道。"""
        track_list: List[BaseTrack] = []
        track_list.extend(self.imported_tracks)
        track_list.extend(self.tracks.values())
        track_list.sort(key=lambda track: track.track_order)
        return track_list

    def _reindex_track_orders(self: ScriptFileProtocol, track_list: Sequence[BaseTrack]) -> None:
        """将给定轨道序列重排为连续的内部顺序。"""
        for track_order, track in enumerate(track_list):
            track.track_order = track_order
        self.imported_tracks.sort(key=lambda track: track.track_order)
        ordered_tracks = sorted(self.tracks.values(), key=lambda track: track.track_order)
        self.tracks = {track.name: track for track in ordered_tracks}

    def _create_internal_track(
        self: ScriptFileProtocol,
        track_type: TrackType,
        track_name: Optional[str],
        mute: bool,
        track_order: int,
    ) -> Track:
        if track_name is None:
            if track_type in [track.track_type for track in self.tracks.values()]:
                raise NameError("'%s' 类型的轨道已存在, 请为新轨道指定名称以避免混淆" % track_type)
            track_name = track_type.name
        if track_name in [track.name for track in self.tracks.values()]:
            raise NameError("名为 '%s' 的轨道已存在" % track_name)

        track = Track(track_type, track_name, track_order, mute)
        self.tracks[track_name] = track
        return track

    def _track_to_ref(self: ScriptFileProtocol, track: Track) -> TrackRef:
        return TrackRef(track.track_id, track.track_type, track.name, self._track_ref_owner_id)

    def _resolve_track_ref(self: ScriptFileProtocol, track_ref: TrackRef) -> Track:
        if track_ref._owner_id != self._track_ref_owner_id:
            raise ValueError("轨道引用 '%s' 不属于当前 ScriptFile" % track_ref.track_id)

        for track in self.tracks.values():
            if track.track_id == track_ref.track_id:
                return track
        raise NameError("不存在 id 为 '%s' 的轨道引用" % track_ref.track_id)

    def _resolve_insert_index(
        self: ScriptFileProtocol,
        under_track: Optional[Union[TrackRef, ImportedTrack]],
        over_track: Optional[Union[TrackRef, ImportedTrack]],
        at_index: Optional[int],
    ) -> int:
        specified = sum(option is not None for option in [under_track, over_track, at_index])
        if specified != 1:
            raise ValueError("必须且只能指定 `under_track`、`over_track` 或 `at_index` 之一")

        track_list = self._list_all_tracks_in_order()
        if at_index is not None:
            if not 0 <= at_index <= len(track_list):
                raise IndexError("轨道插入位置 %d 超出 [0, %d] 的范围" % (at_index, len(track_list)))
            return at_index

        if under_track is not None:
            if isinstance(under_track, TrackRef):
                return track_list.index(self._resolve_track_ref(under_track))
            if under_track not in self.imported_tracks:
                raise ValueError("导入轨道引用 '%s' 不属于当前 ScriptFile" % under_track.track_id)
            return track_list.index(under_track)

        assert over_track is not None
        if isinstance(over_track, TrackRef):
            return track_list.index(self._resolve_track_ref(over_track)) + 1
        if over_track not in self.imported_tracks:
            raise ValueError("导入轨道引用 '%s' 不属于当前 ScriptFile" % over_track.track_id)
        return track_list.index(over_track) + 1

    def _insert_internal_track(self: ScriptFileProtocol, track_spec: TrackSpec, insert_at: int) -> Track:
        track = self._create_internal_track(
            track_spec.track_type,
            track_spec.name,
            track_spec.mute,
            track_order=insert_at,
        )
        track_list = self._list_all_tracks_in_order()
        track_list.remove(track)
        track_list.insert(insert_at, track)
        self._reindex_track_orders(track_list)
        return track

    def append_track(self: ScriptFileProtocol, track_spec: TrackSpec) -> TrackRef:
        """追加一个新轨道到当前最上层

        Args:
            track_spec (`TrackSpec`): 待追加轨道的描述对象

        Returns:
            `TrackRef`: 新挂载轨道的公开引用

        Raises:
            `NameError`: 已存在同类型轨道且未指定名称, 或已存在同名轨道
        """
        track = self._create_internal_track(
            track_spec.track_type,
            track_spec.name,
            track_spec.mute,
            track_order=self._next_track_order(),
        )
        return self._track_to_ref(track)

    def append_tracks(self: ScriptFileProtocol, track_specs: Sequence[TrackSpec]) -> Tuple[TrackRef, ...]:
        """按给定顺序将多个新轨道追加到当前最上层

        Args:
            track_specs (`Sequence[TrackSpec]`): 待追加轨道描述列表

        Returns:
            `Tuple[TrackRef, ...]`: 新挂载轨道的公开引用元组，顺序与输入保持一致

        Raises:
            `NameError`: 某个轨道描述与现有轨道命名规则冲突
        """
        return tuple(self.append_track(track_spec) for track_spec in track_specs)

    def insert_track(
        self: ScriptFileProtocol,
        track_spec: TrackSpec,
        *,
        under_track: Optional[Union[TrackRef, ImportedTrack]] = None,
        over_track: Optional[Union[TrackRef, ImportedTrack]] = None,
        at_index: Optional[int] = None,
    ) -> TrackRef:
        """将一个新轨道插入到指定位置

        Args:
            track_spec (`TrackSpec`): 待插入轨道的描述对象
            under_track (`TrackRef` or `ImportedTrack`, optional): 插入到指定轨道的背景侧；新轨道会被该轨道遮住
            over_track (`TrackRef` or `ImportedTrack`, optional): 插入到指定轨道的前景侧；新轨道会盖住该轨道
            at_index (`int`, optional): 插入到当前完整轨道顺序中的指定下标；`0` 表示最底层，`len(当前轨道数)` 表示最上层

        Returns:
            `TrackRef`: 新挂载轨道的公开引用

        Raises:
            `ValueError`: 没有恰好指定一个定位参数，或轨道引用不属于当前 `ScriptFile`
            `IndexError`: `at_index` 超出允许范围
            `NameError`: 已存在同类型轨道且未指定名称, 或已存在同名轨道
        """
        insert_at = self._resolve_insert_index(under_track, over_track, at_index)
        track = self._insert_internal_track(track_spec, insert_at)
        return self._track_to_ref(track)

    def insert_tracks(
        self: ScriptFileProtocol,
        track_specs: Sequence[TrackSpec],
        *,
        under_track: Optional[Union[TrackRef, ImportedTrack]] = None,
        over_track: Optional[Union[TrackRef, ImportedTrack]] = None,
        at_index: Optional[int] = None,
    ) -> Tuple[TrackRef, ...]:
        """将多个新轨道作为一个顺序块插入到指定位置

        Args:
            track_specs (`Sequence[TrackSpec]`): 待插入轨道描述列表
            under_track (`TrackRef` or `ImportedTrack`, optional): 插入到指定轨道的背景侧；新轨道会被该轨道遮住
            over_track (`TrackRef` or `ImportedTrack`, optional): 插入到指定轨道的前景侧；新轨道会盖住该轨道
            at_index (`int`, optional): 插入到当前完整轨道顺序中的指定下标；`0` 表示最底层，`len(当前轨道数)` 表示最上层

        Returns:
            `Tuple[TrackRef, ...]`: 新挂载轨道的公开引用元组，顺序与输入保持一致

        Raises:
            `ValueError`: 没有恰好指定一个定位参数，或轨道引用不属于当前 `ScriptFile`
            `IndexError`: `at_index` 超出允许范围
            `NameError`: 某个轨道描述与现有轨道命名规则冲突
        """
        insert_at = self._resolve_insert_index(under_track, over_track, at_index)
        refs: List[TrackRef] = []
        for offset, track_spec in enumerate(track_specs):
            refs.append(self._track_to_ref(self._insert_internal_track(track_spec, insert_at + offset)))
        return tuple(refs)
