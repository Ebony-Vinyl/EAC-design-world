#!/usr/bin/env python3
"""Generate pypi_readme.md from the marked subset of README.md."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import quote


REPO_BLOB_BASE = "https://github.com/GuanYixuan/pyJianYingDraft/blob/main/"
REPO_RAW_BASE = "https://github.com/GuanYixuan/pyJianYingDraft/raw/main/"
ROOT = Path(__file__).resolve().parents[1]
README_PATH = ROOT / "README.md"
PYPI_README_PATH = ROOT / "pypi_readme.md"
MARKER_BEGIN = "<!-- PYPI:BEGIN -->"
MARKER_END = "<!-- PYPI:END -->"


def extract_pypi_section(readme_text: str) -> str:
    pattern = re.compile(
        rf"{re.escape(MARKER_BEGIN)}\n?(.*?)\n?{re.escape(MARKER_END)}",
        re.DOTALL,
    )
    match = pattern.search(readme_text)
    if match is None:
        raise RuntimeError("README.md does not contain the expected PYPI markers")
    return match.group(1).strip() + "\n"


def encode_repo_path(path: str) -> str:
    return quote(path, safe="/._-")


def rewrite_image_links(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        alt_text, target = match.groups()
        if re.match(r"https?://", target):
            return match.group(0)
        return f"![{alt_text}]({REPO_RAW_BASE}{encode_repo_path(target)})"

    return re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", repl, text)


def rewrite_markdown_links(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        label, target = match.groups()
        if re.match(r"https?://", target):
            return match.group(0)
        if target.startswith("#"):
            return label
        return f"[{label}]({REPO_BLOB_BASE}{encode_repo_path(target)})"

    return re.sub(r"(?<!!)\[([^\]]+)\]\(([^)]+)\)", repl, text)


def build_pypi_readme() -> str:
    source = README_PATH.read_text(encoding="utf-8")
    subset = extract_pypi_section(source)
    subset = rewrite_image_links(subset)
    subset = rewrite_markdown_links(subset)
    header = "<!-- Generated from README.md by tools/generate_pypi_readme.py. Do not edit directly. -->\n\n"
    return header + subset


def main() -> None:
    PYPI_README_PATH.write_text(build_pypi_readme(), encoding="utf-8")


if __name__ == "__main__":
    main()
