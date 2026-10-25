"""轨道类及其元数据"""

import uuid

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional, Type, Union

from .exceptions import SegmentOverlap
from .segment import BaseSegment
from .audio_segment import AudioSegment
from .effect_segment import EffectSegment, FilterSegment
from .text_segment import TextSegment
from .video_segment import StickerSegment, VideoSegment


@dataclass
class TrackTypeMeta:
    """与轨道类型关联的轨道元数据"""

    segment_type: Union[Type[VideoSegment], Type[AudioSegment],
                        Type[EffectSegment], Type[FilterSegment],
                        Type[TextSegment], Type[StickerSegment], None]
    """与轨道关联的片段类型"""
    allow_modify: bool
    """当被导入时, 是否允许修改"""


class TrackType(Enum):
    """轨道类型枚举

    变量名对应type属性, 值表示相应的轨道元数据
    """

    video = TrackTypeMeta(VideoSegment, True)
    audio = TrackTypeMeta(AudioSegment, True)
    effect = TrackTypeMeta(EffectSegment, False)
    filter = TrackTypeMeta(FilterSegment, False)
    sticker = TrackTypeMeta(StickerSegment, False)
    text = TrackTypeMeta(TextSegment, True)

    adjust = TrackTypeMeta(None, False)
    """仅供导入时使用, 不要尝试新建此类型的轨道"""

    @staticmethod
    def from_name(name: str) -> "TrackType":
        """根据名称获取轨道类型枚举"""
        for t in TrackType:
            if t.name == name:
                return t
        raise ValueError("Invalid track type: %s" % name)


class TrackRef:
    """已挂载轨道的公开引用对象"""

    track_id: str
    """轨道全局 ID"""
    track_type: TrackType
    """轨道类型"""
    name: str
    """轨道名称"""
    _owner_id: Optional[str]
    """所属 ScriptFile 的内部标识"""

    def __init__(self, track_id: str, track_type: TrackType, name: str, owner_id: Optional[str] = None):
        """**获取轨道引用推荐使用 `ScriptFile.append_track(...)`、
        `ScriptFile.append_tracks(...)` 等方法返回的结果，而非通过本方法手动构造**

        Args:
            track_id (`str`): 轨道全局 ID
            track_type (`TrackType`): 轨道类型
            name (`str`): 轨道名称
            owner_id (`str`, optional): 所属 `ScriptFile` 的内部标识

        Raises:
            无
        """
        self.track_id = track_id
        self.track_type = track_type
        self.name = name
        self._owner_id = owner_id


class TrackSpec:
    """待挂载轨道的描述对象"""

    track_type: TrackType
    """轨道类型"""
    name: Optional[str]
    """轨道名称；为 `None` 时沿用现有默认命名规则"""
    mute: bool
    """是否静音"""

    def __init__(self, track_type: TrackType, name: Optional[str] = None, mute: bool = False):
        """构造待挂载轨道描述

        Args:
            track_type (`TrackType`): 轨道类型
            name (`str`, optional): 轨道名称；为 `None` 时沿用 `ScriptFile` 现有默认命名规则
            mute (`bool`, optional): 轨道是否静音，默认不静音

        Raises:
            无
        """
        self.track_type = track_type
        self.name = name
        self.mute = mute


class BaseTrack(ABC):
    """轨道基类"""

    track_type: TrackType
    """轨道类型"""
    name: str
    """轨道名称"""
    track_id: str
    """轨道全局ID"""
    track_order: int
    """内部顺序, 值越大越靠后导出"""

    @abstractmethod
    def export_json(self) -> Dict[str, Any]: ...


class Track(BaseTrack):
    """非模板模式下的轨道"""

    mute: bool
    """是否静音"""

    segments: List[BaseSegment]
    """该轨道包含的片段列表"""

    def __init__(self, track_type: TrackType, name: str, track_order: int, mute: bool):
        self.track_type = track_type
        self.name = name
        self.track_id = uuid.uuid4().hex
        self.track_order = track_order

        self.mute = mute
        self.segments = []

    @property
    def end_time(self) -> int:
        """轨道结束时间, 微秒"""
        if len(self.segments) == 0:
            return 0
        return self.segments[-1].target_timerange.end

    @property
    def accept_segment_type(self) -> Type[BaseSegment]:
        """返回该轨道允许的片段类型"""
        return self.track_type.value.segment_type  # type: ignore

    def add_segment(self, segment: BaseSegment) -> "Track":
        """向轨道中添加一个片段, 添加的片段必须匹配轨道类型且不与现有片段重叠

        Args:
            segment (`BaseSegment`): 要添加的片段

        Raises:
            `TypeError`: 新片段类型与轨道类型不匹配
            `SegmentOverlap`: 新片段与现有片段重叠
        """
        if not isinstance(segment, self.accept_segment_type):
            raise TypeError("New segment (%s) is not of the same type as the track (%s)" % (type(segment), self.accept_segment_type))

        # 检查片段是否重叠
        for seg in self.segments:
            if seg.overlaps(segment):
                raise SegmentOverlap("New segment overlaps with existing segment [start: {}, end: {}]"
                                     .format(segment.target_timerange.start, segment.target_timerange.end))

        self.segments.append(segment)
        return self

    def export_json(self) -> Dict[str, Any]:
        return {
            "attribute": int(self.mute),
            "flag": 0,
            "id": self.track_id,
            "is_default_name": len(self.name) == 0,
            "name": self.name,
            "segments": [seg.export_json() for seg in self.segments],
            "type": self.track_type.name
        }
