#!/usr/bin/env python3
"""Generate the PyPI README and build source/wheel distributions."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = ROOT / "tools"
GENERATE_PYPI_README = TOOLS_DIR / "generate_pypi_readme.py"
DIST_DIR = ROOT / "dist"
BUILD_DIR = ROOT / "build"
ARCHIVE_BLOCKLIST = ("tests/", "tests\\")


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, cwd=ROOT, check=True)


def clean_build_artifacts() -> None:
    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    for egg_info in ROOT.glob("*.egg-info"):
        if egg_info.is_dir():
            shutil.rmtree(egg_info)
        else:
            egg_info.unlink()


def build_distributions() -> None:
    run([sys.executable, str(GENERATE_PYPI_README)])

    try:
        import build  # noqa: F401
    except ModuleNotFoundError:
        run([sys.executable, "setup.py", "sdist", "bdist_wheel"])
    else:
        run([sys.executable, "-m", "build"])


def assert_no_tests_in_tarball(path: Path) -> None:
    with tarfile.open(path, "r:gz") as tar:
        names = tar.getnames()
    bad_entries = [name for name in names if any(part in name for part in ARCHIVE_BLOCKLIST)]
    if bad_entries:
        raise RuntimeError(f"Unexpected test files in sdist {path.name}: {bad_entries[:5]}")


def assert_no_tests_in_wheel(path: Path) -> None:
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
    bad_entries = [name for name in names if any(part in name for part in ARCHIVE_BLOCKLIST)]
    if bad_entries:
        raise RuntimeError(f"Unexpected test files in wheel {path.name}: {bad_entries[:5]}")


def verify_dist_contents() -> tuple[list[Path], list[Path]]:
    wheels = sorted(DIST_DIR.glob("*.whl"))
    tarballs = sorted(DIST_DIR.glob("*.tar.gz"))
    if not wheels:
        raise RuntimeError("No wheel produced in dist/")
    if not tarballs:
        raise RuntimeError("No source distribution produced in dist/")

    for wheel in wheels:
        assert_no_tests_in_wheel(wheel)
    for tarball in tarballs:
        assert_no_tests_in_tarball(tarball)

    return wheels, tarballs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate pypi_readme.md, clean old artifacts, and build distributions."
    )
    parser.add_argument(
        "--skip-clean",
        action="store_true",
        help="Do not remove existing build/, dist/, or *.egg-info artifacts before building.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.skip_clean:
        clean_build_artifacts()
    build_distributions()
    wheels, tarballs = verify_dist_contents()

    print("Build completed.")
    print("Wheels:")
    for wheel in wheels:
        print(f"  - {wheel.relative_to(ROOT)}")
    print("Source distributions:")
    for tarball in tarballs:
        print(f"  - {tarball.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
