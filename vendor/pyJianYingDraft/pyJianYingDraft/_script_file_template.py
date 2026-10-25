from __future__ import annotations

import json
import math
from copy import deepcopy
from typing import Any, Dict, List, Literal, Optional, Tuple, Union

from . import exceptions
from ._script_file_protocol import ScriptFileProtocol
from .local_materials import AudioMaterial, VideoMaterial
from .template_mode import EditableTrack, ExtendMode, ImportedMediaTrack, ImportedTextTrack, ImportedTrack, ShrinkMode
from .text_segment import TextSegment
from .time_util import Timerange, tim
from .track import TrackRef, TrackType


class _ScriptFileTemplateOps:
    def _get_imported_material_list(self: ScriptFileProtocol, material_type: str) -> List[Dict[str, Any]]:
        """读取导入素材列表；缺失的素材桶按空列表处理。"""
        return self.imported_materials.get(material_type, [])

    def get_imported_track(
        self: ScriptFileProtocol,
        track_type: Literal[TrackType.video, TrackType.audio, TrackType.text],
        name: Optional[str] = None,
        index: Optional[int] = None,
    ) -> EditableTrack:
        """获取唯一匹配的导入轨道, 以便在其上进行替换

        推荐使用轨道名称进行筛选（若已知轨道名称）

        Args:
            track_type (`TrackType.video`, `TrackType.audio` or `TrackType.text`): 轨道类型, 目前只支持音视频和文本轨道
            name (`str`, optional): 轨道名称, 不指定则不根据名称筛选.
            index (`int`, optional): 轨道在**同类型的导入轨道**中的下标, 以0为最下层轨道. 不指定则不根据下标筛选.

        Returns:
            `EditableTrack`: 脚本内部导入轨道对象的引用；对返回对象的修改会直接影响当前`ScriptFile`

        Raises:
            `TrackNotFound`: 未找到满足条件的轨道
            `AmbiguousTrack`: 找到多个满足条件的轨道
        """
        tracks_of_same_type = self.list_imported_tracks(track_type)

        ret: List[EditableTrack] = []
        for ind, track in enumerate(tracks_of_same_type):
            if name is not None and track.name != name:
                continue
            if index is not None and ind != index:
                continue
            assert isinstance(track, EditableTrack)
            ret.append(track)

        if len(ret) == 0:
            raise exceptions.TrackNotFound(
                "没有找到满足条件的轨道: track_type=%s, name=%s, index=%s" % (track_type, name, index),
            )
        if len(ret) > 1:
            raise exceptions.AmbiguousTrack(
                "找到多个满足条件的轨道: track_type=%s, name=%s, index=%s" % (track_type, name, index),
            )

        return ret[0]

    def list_imported_tracks(
        self: ScriptFileProtocol,
        track_type: Optional[TrackType] = None,
    ) -> Tuple[ImportedTrack, ...]:
        """列出导入轨道

        Args:
            track_type (`TrackType`, optional): 若提供，则仅返回该类型的导入轨道

        Returns:
            `Tuple[ImportedTrack, ...]`: 按当前脚本内部顺序返回导入轨道对象引用；
                对返回对象本身的修改会直接影响当前`ScriptFile`
        """
        if track_type is None:
            return tuple(self.imported_tracks)
        return tuple(track for track in self.imported_tracks if track.track_type == track_type)

    def import_track(
        self: ScriptFileProtocol,
        source_file: "ScriptFile",
        track: EditableTrack,
        *,
        offset: Union[str, int] = 0,
        new_name: Optional[str] = None,
        under_track: Optional[Union[TrackRef, ImportedTrack]] = None,
        over_track: Optional[Union[TrackRef, ImportedTrack]] = None,
        at_index: Optional[int] = None,
    ) -> "ScriptFile":
        """将一个`EditableTrack`导入到当前`ScriptFile`中, 如从模板草稿中导入特定的文本或视频轨道到当前正在编辑的草稿文件中

        注意: 本方法会保留各片段及其素材的id, 因而不支持向同一草稿多次导入同一轨道

        Args:
            source_file (`ScriptFile`): 源文件，包含要导入的轨道
            track (`EditableTrack`): 要导入的轨道, 可通过`get_imported_track`方法获取.
            offset (`str | int`, optional): 轨道的时间偏移量(微秒), 可以是整数微秒值或时间字符串(如"1s"). 默认不添加偏移.
            new_name (`str`, optional): 新轨道名称, 默认使用源轨道名称.
            under_track (`TrackRef` or `ImportedTrack`, optional): 导入到指定轨道的背景侧；若不提供任何定位参数，则默认追加到当前最上层
            over_track (`TrackRef` or `ImportedTrack`, optional): 导入到指定轨道的前景侧
            at_index (`int`, optional): 导入到当前完整轨道顺序中的指定下标；`0` 表示最底层，`len(当前轨道数)` 表示最上层

        Raises:
            `ValueError`: 指定了多个定位参数，或轨道引用不属于当前 `ScriptFile`
            `IndexError`: `at_index` 超出允许范围
        """
        imported_track = deepcopy(track)
        if new_name is not None:
            imported_track.name = new_name
        if all(option is None for option in [under_track, over_track, at_index]):
            insert_at = self._next_track_order()
        else:
            insert_at = self._resolve_insert_index(under_track, over_track, at_index)
        imported_track.track_order = insert_at

        offset_us = tim(offset)
        if offset_us != 0:
            for seg in imported_track.segments:
                seg.target_timerange.start = max(0, seg.target_timerange.start + offset_us)
        self.imported_tracks.append(imported_track)
        self._reindex_track_orders(self._list_all_tracks_in_order())

        material_ids = set()
        segments: List[Dict[str, Any]] = track.raw_data["segments"]
        for segment in segments:
            material_id = segment.get("material_id")
            if material_id:
                material_ids.add(material_id)

            extra_refs: List[str] = segment.get("extra_material_refs", [])
            material_ids.update(extra_refs)

        for material_type, material_list in source_file.imported_materials.items():
            for material in material_list:
                if material.get("id") in material_ids:
                    if material_type not in self.imported_materials:
                        self.imported_materials[material_type] = []
                    self.imported_materials[material_type].append(deepcopy(material))
                    material_ids.remove(material.get("id"))

        assert len(material_ids) == 0, "未找到以下素材: %s" % material_ids
        self.duration = max(self.duration, track.end_time)

        return self

    def replace_material_by_name(
        self: ScriptFileProtocol,
        material_name: str,
        material: Union[VideoMaterial, AudioMaterial],
        replace_crop: bool = False,
    ) -> "ScriptFile":
        """替换指定名称的素材, 并影响所有引用它的片段

        这种方法不会改变相应片段的时长和引用范围(`source_timerange`), 尤其适合于图片素材

        Args:
            material_name (`str`): 要替换的素材名称
            material (`VideoMaterial` or `AudioMaterial`): 新素材, 目前只支持视频和音频
            replace_crop (`bool`, optional): 是否替换原素材的裁剪设置, 默认为否. 仅对视频素材有效.

        Raises:
            `MaterialNotFound`: 根据指定名称未找到与新素材同类的素材
            `AmbiguousMaterial`: 根据指定名称找到多个与新素材同类的素材
        """
        video_mode = isinstance(material, VideoMaterial)
        target_json_obj: Optional[Dict[str, Any]] = None
        target_material_list = self._get_imported_material_list("videos" if video_mode else "audios")
        name_key = "material_name" if video_mode else "name"
        for mat in target_material_list:
            if mat[name_key] == material_name:
                if target_json_obj is not None:
                    raise exceptions.AmbiguousMaterial(
                        "找到多个名为 '%s', 类型为 '%s' 的素材" % (material_name, type(material)),
                    )
                target_json_obj = mat
        if target_json_obj is None:
            raise exceptions.MaterialNotFound(
                "没有找到名为 '%s', 类型为 '%s' 的素材" % (material_name, type(material)),
            )

        target_json_obj.update({name_key: material.material_name, "path": material.path, "duration": material.duration})
        if video_mode:
            target_json_obj.update(
                {"width": material.width, "height": material.height, "material_type": material.material_type},
            )
            if replace_crop:
                target_json_obj.update({"crop": material.crop_settings.export_json()})

        return self

    def replace_material_by_seg(
        self: ScriptFileProtocol,
        track: EditableTrack,
        segment_index: int,
        material: Union[VideoMaterial, AudioMaterial],
        source_timerange: Optional[Timerange] = None,
        *,
        handle_shrink: ShrinkMode = ShrinkMode.cut_tail,
        handle_extend: Union[ExtendMode, List[ExtendMode]] = ExtendMode.cut_material_tail,
    ) -> "ScriptFile":
        """替换指定音视频轨道上指定片段的素材, 暂不支持变速片段的素材替换

        Args:
            track (`EditableTrack`): 要替换素材的轨道, 由`get_imported_track`获取
            segment_index (`int`): 要替换素材的片段下标, 从0开始
            material (`VideoMaterial` or `AudioMaterial`): 新素材, 必须与原素材类型一致
            source_timerange (`Timerange`, optional): 从原素材中截取的时间范围, 默认为全时段, 若是图片素材则默认与原片段等长.
            handle_shrink (`Shrink_mode`, optional): 新素材比原素材短时的处理方式, 默认为裁剪尾部, 使片段长度与素材一致.
            handle_extend (`Extend_mode` or `List[Extend_mode]`, optional): 新素材比原素材长时的处理方式, 将按顺序逐个尝试直至成功或抛出异常.
                默认为截断素材尾部, 使片段维持原长不变

        Raises:
            `IndexError`: `segment_index`越界
            `TypeError`: 轨道或素材类型不正确
            `ExtensionFailed`: 新素材比原素材长时处理失败
        """
        if not isinstance(track, ImportedMediaTrack):
            raise TypeError("指定的轨道(类型为 %s)不支持素材替换" % track.track_type)
        if not 0 <= segment_index < len(track):
            raise IndexError("片段下标 %d 超出 [0, %d) 的范围" % (segment_index, len(track)))
        if not track.check_material_type(material):
            raise TypeError("指定的素材类型 %s 不匹配轨道类型 %s", (type(material), track.track_type))
        seg = track.segments[segment_index]

        if isinstance(handle_extend, ExtendMode):
            handle_extend = [handle_extend]
        if source_timerange is None:
            if isinstance(material, VideoMaterial) and material.material_type == "photo":
                source_timerange = Timerange(0, seg.duration)
            else:
                source_timerange = Timerange(0, material.duration)

        track.process_timerange(segment_index, source_timerange, handle_shrink, handle_extend)
        track.segments[segment_index].material_id = material.material_id
        self.add_material(material)

        return self

    def replace_text(
        self: ScriptFileProtocol,
        track: EditableTrack,
        segment_index: int,
        text: Union[str, List[str]],
        recalc_style: bool = True,
    ) -> "ScriptFile":
        """替换指定文本轨道上指定片段的文字内容, 支持普通文本片段或文本模板片段

        Args:
            track (`EditableTrack`): 要替换文字的文本轨道, 由`get_imported_track`获取
            segment_index (`int`): 要替换文字的片段下标, 从0开始
            text (`str` or `List[str]`): 新的文字内容, 对于文本模板而言应传入一个字符串列表.
            recalc_style (`bool`): 是否重新计算字体样式分布, 即调整各字体样式应用范围以尽量维持原有占比不变, 默认开启.

        Raises:
            `IndexError`: `segment_index`越界
            `TypeError`: 轨道类型不正确
            `ValueError`: 文本模板片段的文本数量不匹配
        """
        if not isinstance(track, ImportedTextTrack):
            raise TypeError("指定的轨道(类型为 %s)不支持文本内容替换" % track.track_type)
        if not 0 <= segment_index < len(track):
            raise IndexError("片段下标 %d 超出 [0, %d) 的范围" % (segment_index, len(track)))

        def __recalc_style_range(old_len: int, new_len: int, styles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
            new_styles: List[Dict[str, Any]] = []
            for style in styles:
                start = math.ceil(style["range"][0] / old_len * new_len)
                end = math.ceil(style["range"][1] / old_len * new_len)
                style["range"] = [start, end]
                if start != end:
                    new_styles.append(style)
            return new_styles

        replaced = False
        material_id = track.segments[segment_index].material_id
        for mat in self._get_imported_material_list("texts"):
            if mat["id"] != material_id:
                continue

            if isinstance(text, list):
                if len(text) != 1:
                    raise ValueError(f"正常文本片段只能有一个文字内容, 但替换内容是 {text}")
                text = text[0]

            content = json.loads(mat["content"])
            if recalc_style:
                content["styles"] = __recalc_style_range(len(content["text"]), len(text), content["styles"])
            content["text"] = text
            mat["content"] = json.dumps(content, ensure_ascii=False)
            replaced = True
            break
        if replaced:
            return self

        for template in self._get_imported_material_list("text_templates"):
            if template["id"] != material_id:
                continue

            resources = template["text_info_resources"]
            if isinstance(text, str):
                text = [text]
            if len(text) > len(resources):
                raise ValueError(f"文字模板'{template['name']}'只有{len(resources)}段文本, 但提供了{len(text)}段替换内容")

            for sub_material_id, new_text in zip(map(lambda x: x["text_material_id"], resources), text):
                for mat in self._get_imported_material_list("texts"):
                    if mat["id"] != sub_material_id:
                        continue

                    try:
                        content = json.loads(mat["content"])
                        if recalc_style:
                            content["styles"] = __recalc_style_range(len(content["text"]), len(new_text), content["styles"])
                        content["text"] = new_text
                        mat["content"] = json.dumps(content, ensure_ascii=False)
                    except json.JSONDecodeError:
                        mat["content"] = new_text
                    except TypeError:
                        mat["content"] = new_text

                    break
            replaced = True
            break

        if not replaced:
            raise exceptions.MaterialNotFound("未找到指定片段的文本素材 %s" % material_id)

        return self

    def inspect_material(self: ScriptFileProtocol) -> None:
        """输出草稿中导入的贴纸、文本气泡以及花字素材的元数据"""
        print("贴纸素材:")
        for sticker in self._get_imported_material_list("stickers"):
            print("\tResource id: %s '%s'" % (sticker["resource_id"], sticker.get("name", "")))

        print("文字气泡效果:")
        for effect in self._get_imported_material_list("effects"):
            if effect["type"] == "text_shape":
                print(
                    "\tEffect id: %s ,Resource id: %s '%s'" %
                    (effect["effect_id"], effect["resource_id"], effect.get("name", "")),
                )

        print("花字效果:")
        for effect in self._get_imported_material_list("effects"):
            if effect["type"] == "text_effect":
                print("\tResource id: %s '%s'" % (effect["resource_id"], effect.get("name", "")))
