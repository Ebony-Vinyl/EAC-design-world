import json

from typing import Any, Callable, Dict, Optional, Union

from .exceptions import DraftContentLoadFailed


FallbackLoader = Callable[[bytes], Union[str, Dict[str, Any]]]


def load_draft_content(
    json_path: str,
    fallback_loader: Optional[FallbackLoader] = None,
) -> Dict[str, Any]:
    with open(json_path, "rb") as f:
        raw_data = f.read()

    try:
        return json.loads(raw_data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as plain_exc:
        if fallback_loader is None:
            raise DraftContentLoadFailed(
                "草稿内容 '%s' 不是合法的明文 JSON；如需读取本机特殊格式草稿，请通过 DraftFolder(..., fallback_loader=...) 提供后备读取器"
                % json_path
            ) from plain_exc

    try:
        loaded = fallback_loader(raw_data)
    except Exception as exc:
        raise DraftContentLoadFailed(
            "fallback_loader 处理草稿内容 '%s' 时失败" % json_path
        ) from exc

    if isinstance(loaded, dict):
        return loaded
    if isinstance(loaded, str):
        try:
            return json.loads(loaded)
        except json.JSONDecodeError as exc:
            raise DraftContentLoadFailed(
                "fallback_loader 为草稿内容 '%s' 返回的字符串不是合法 JSON" % json_path
            ) from exc

    raise DraftContentLoadFailed(
        "fallback_loader 为草稿内容 '%s' 返回了错误类型 '%s'；仅支持 str 或 dict"
        % (json_path, type(loaded).__name__)
    )
