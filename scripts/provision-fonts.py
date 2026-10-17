#!/usr/bin/env python3
"""Provision exact upstream fonts without changing vendored template sources."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "runtime/fonts"
sys.path.insert(0, str(CACHE / "python"))

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

GOOGLE_COMMIT = "47d54ca1ebb14fd864695f1d39dc734f39017c33"
GOOGLE = f"https://raw.githubusercontent.com/google/fonts/{GOOGLE_COMMIT}/ofl"
FONTSOURCE_VERSION = "5.2.5"
RHR = "https://raw.githubusercontent.com/CyanoHao/Resource-Han-Rounded/v0.990"
MANIFEST = ROOT / "vendor/fonts/manifest.json"
MAX_DOWNLOAD = 60 * 1024 * 1024
MAX_TOTAL_DOWNLOAD = 120 * 1024 * 1024
SCOPE = (
    "vendor/fonts/",
    "vendor/mg-styles-15/assets/fonts/",
    "vendor/motion-promo-film/templates/fonts/",
    "vendor/motion-promo-film-v2/references/fonts/",
)
INSTANCE_PATHS = (
    "vendor/mg-styles-15/demos/03-isometric/assets/fonts/Unbounded-800-static.ttf",
    "vendor/mg-styles-15/demos/07-liquid/assets/Fraunces-Liquid-72-900-Soft.ttf",
    "vendor/mg-styles-15/demos/08-morph/assets/fonts/Outfit-SemiBold.ttf",
    "vendor/mg-styles-15/demos/10-synthwave/assets/fonts/MrDafoe-Regular.ttf",
)
SOURCES = {}
ASSETS = {}
DOWNLOADED = 0
LOCK = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}
LOCKED_SOURCES = {item["url"]: item for item in LOCK.get("sources", [])}
HARMONY_URL = (
    "https://alliance-communityfile-drcn.dbankcdn.com/FileServer/getFile/cmtyManage/011/111/111/"
    "0000000000011111111.20260627152129.89276966309836366526585265125586:50001231000000:2800:"
    "A0161E048334FE0271F9F5ECBBD5070D17381C7846125F4D7109DBC7B532C715.zip?needInitFileName=true"
)
FUSION_URL = (
    "https://github.com/TakWolf/fusion-pixel-font/releases/download/2026.10.16/"
    "fusion-pixel-font-12px-proportional-ttf.woff2-v2026.10.16.zip"
)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def destination(relative):
    if relative not in INSTANCE_PATHS and not any(relative.startswith(prefix) for prefix in SCOPE):
        raise ValueError(f"Output outside font scope: {relative}")
    path = (ROOT / relative).resolve()
    if not path.is_relative_to(ROOT / "vendor"):
        raise ValueError(f"Unsafe font path: {relative}")
    return path


def download(url):
    global DOWNLOADED
    if url in SOURCES:
        return (CACHE / SOURCES[url]["cache"]).read_bytes()
    filename = Path(urllib.parse.urlsplit(url).path).name
    filename = re.sub(r'[<>:"/\\|?*]', "_", filename)[-100:]
    cache_name = f"downloads/{sha256(url.encode())[:20]}-{filename}"
    target = CACHE / cache_name
    expected = LOCKED_SOURCES.get(url, {}).get("sha256")
    if target.exists():
        data = target.read_bytes()
        if expected and sha256(data) != expected:
            raise ValueError(f"Cached source checksum mismatch: {url}")
    else:
        print(f"Download {url}", flush=True)
        headers = {"User-Agent": "EAC-font-provisioner/1"}
        if urllib.parse.urlsplit(url).hostname == "fonts.alibabadesign.com":
            headers.update({"Referer": "https://www.alibabafonts.com/", "User-Agent": "Mozilla/5.0"})
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=60) as response:
            limit = min(MAX_DOWNLOAD, MAX_TOTAL_DOWNLOAD - DOWNLOADED)
            if int(response.headers.get("Content-Length", 0)) > limit:
                raise ValueError(
                    f"Download would exceed the 60 MiB file / 120 MiB run budget: {url}. "
                    "Completed downloads are cached; run again to resume."
                )
            data = response.read(limit + 1)
        DOWNLOADED += len(data)
        if len(data) > MAX_DOWNLOAD or DOWNLOADED > MAX_TOTAL_DOWNLOAD:
            raise ValueError("Font download size limit exceeded")
        if expected and sha256(data) != expected:
            raise ValueError(f"Upstream source checksum mismatch: {url}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    SOURCES[url] = {
        "url": url, "sha256": sha256(data), "bytes": len(data), "cache": cache_name,
    }
    return data


def font_info(data, family):
    with TTFont(io.BytesIO(data)) as font:
        names = sorted({
            record.toUnicode() for record in font["name"].names
            if record.nameID in (1, 2, 4, 6, 16, 17)
        })
        families = {
            record.toUnicode() for record in font["name"].names
            if record.nameID in (1, 16)
        }
        if not any(name == family or name.startswith(family + " ") for name in families):
            raise ValueError(f"Expected {family}; font contains {sorted(families)}")
        result = {"family": family, "names": names, "codepoints": len(font.getBestCmap())}
        if "fvar" in font:
            result["axes"] = {
                axis.axisTag: [axis.minValue, axis.defaultValue, axis.maxValue]
                for axis in font["fvar"].axes
            }
        return result


def output(relative, data, urls, family=None, transformation=None, link_to=None):
    path = destination(relative)
    info = font_info(data, family) if family else {}
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_bytes() != data:
        if link_to:
            path.unlink(missing_ok=True)
            try:
                os.link(destination(link_to), path)
            except OSError:
                path.write_bytes(data)
        else:
            path.write_bytes(data)
    ASSETS[relative] = {
        "path": relative, "sha256": sha256(data), "bytes": len(data),
        "sources": urls, **info,
    }
    if transformation:
        ASSETS[relative]["transformation"] = transformation
    if link_to:
        ASSETS[relative]["identicalTo"] = link_to


def source_font(url, relative, family):
    output(relative, download(url), [url], family)


def provision_rhr():
    import py7zr

    url = "https://github.com/CyanoHao/Resource-Han-Rounded/releases/download/v0.990/RHR-CN-0.990.7z"
    archive_data = download(url)
    extraction = CACHE / "resource-han-rounded-v0.990"
    extraction.mkdir(parents=True, exist_ok=True)
    wanted = {f"ResourceHanRoundedCN-{weight}.ttf" for weight in ("Bold", "Heavy")}
    with py7zr.SevenZipFile(io.BytesIO(archive_data), "r") as archive:
        selected = {}
        for member in archive.list():
            name = member.filename.replace("\\", "/")
            parts = PurePosixPath(name)
            if parts.is_absolute() or ".." in parts.parts or ":" in name:
                raise ValueError(f"Unsafe archive member: {name}")
            if parts.name in wanted:
                if parts.name in selected:
                    raise ValueError(f"Duplicate archive font: {name}")
                if member.is_directory or member.uncompressed > MAX_DOWNLOAD:
                    raise ValueError(f"Invalid archive font: {name}")
                selected[parts.name] = member.filename
        if set(selected) != wanted:
            raise ValueError(f"Missing fonts in RHR archive: {wanted - set(selected)}")
        # Only these known regular font members are extracted, never extractall.
        for archive_member in archive.files:
            if archive_member.filename in selected.values() and (
                archive_member.is_symlink or archive_member.is_junction
            ):
                raise ValueError("Font archive member must be a regular file")
        if any(not (extraction / name).is_file() for name in selected.values()):
            archive.extract(path=extraction, targets=list(selected.values()))
    for filename, name in selected.items():
        output(
            f"vendor/mg-styles-15/assets/fonts/cjk/resourcehanrounded/{filename}",
            (extraction / name).read_bytes(), [url], "Resource Han Rounded",
            f"Unchanged original TTF extracted from {name}",
        )
    license_url = RHR + "/LICENSE.txt"
    output("vendor/fonts/licenses/resource-han-rounded-OFL.txt", download(license_url), [license_url])


def provision_mg():
    for directory, filename, dest, family in (
        ("fredoka", "Fredoka[wdth,wght].ttf", "fredoka/Fredoka-VF.ttf", "Fredoka"),
        ("cormorantgaramond", "CormorantGaramond[wght].ttf",
         "cormorantgaramond/CormorantGaramond-VF.ttf", "Cormorant Garamond"),
        ("notoserifsc", "NotoSerifSC[wght].ttf",
         "notoserifsc/NotoSerifSC-VF.ttf", "Noto Serif SC"),
    ):
        url = f"{GOOGLE}/{directory}/{urllib.parse.quote(filename)}"
        category = "cjk" if directory == "notoserifsc" else "latin"
        source_font(url, f"vendor/mg-styles-15/assets/fonts/{category}/{dest}", family)
        license_url = f"{GOOGLE}/{directory}/OFL.txt"
        output(f"vendor/fonts/licenses/{directory}-OFL.txt", download(license_url), [license_url])
    provision_rhr()


def google_font(directory, filename, relative, family, category="ofl"):
    base = GOOGLE if category == "ofl" else GOOGLE.replace("/ofl", f"/{category}")
    url = f"{base}/{directory}/{urllib.parse.quote(filename)}"
    data = download(url)
    output(relative, data, [url], family)
    license_file = "OFL.txt" if category == "ofl" else "LICENSE.txt"
    license_url = f"{base}/{directory}/{license_file}"
    output(f"vendor/fonts/licenses/{directory}-{license_file}", download(license_url), [license_url])
    return data, url


def static_instance(directory, filename, relative, family, axes):
    url = f"{GOOGLE}/{directory}/{urllib.parse.quote(filename)}"
    with TTFont(io.BytesIO(download(url)), recalcTimestamp=False) as font:
        instance = instantiateVariableFont(font, axes, inplace=True, updateFontNames=False)
        result = io.BytesIO()
        instance.save(result, reorderTables=True)
    output(relative, result.getvalue(), [url], family,
           f"fontTools static instance {axes}; original family/name records preserved")
    license_url = f"{GOOGLE}/{directory}/OFL.txt"
    output(f"vendor/fonts/licenses/{directory}-OFL.txt", download(license_url), [license_url])


def provision_remaining_google():
    latin = "vendor/mg-styles-15/assets/fonts/latin"
    cjk = "vendor/mg-styles-15/assets/fonts/cjk"
    for directory, filename, dest, family in (
        ("anton", "Anton-Regular.ttf", "anton/Anton-Regular.ttf", "Anton"),
        ("archivo", "Archivo-Italic[wdth,wght].ttf", "archivo/Archivo-Italic-VF.ttf", "Archivo"),
        ("bebasneue", "BebasNeue-Regular.ttf", "bebasneue/BebasNeue-Regular.ttf", "Bebas Neue"),
        ("caveat", "Caveat[wght].ttf", "caveat/Caveat-VF.ttf", "Caveat"),
        ("chakrapetch", "ChakraPetch-SemiBold.ttf", "chakrapetch/ChakraPetch-SemiBold.ttf", "Chakra Petch"),
        ("dmsans", "DMSans[opsz,wght].ttf", "dmsans/DMSans-VF.ttf", "DM Sans"),
        ("ibmplexmono", "IBMPlexMono-Medium.ttf", "ibmplexmono/IBMPlexMono-Medium.ttf", "IBM Plex Mono"),
        ("ibmplexmono", "IBMPlexMono-SemiBold.ttf", "ibmplexmono/IBMPlexMono-SemiBold.ttf", "IBM Plex Mono"),
        ("instrumentserif", "InstrumentSerif-Regular.ttf", "instrumentserif/InstrumentSerif-Regular.ttf", "Instrument Serif"),
        ("instrumentserif", "InstrumentSerif-Italic.ttf", "instrumentserif/InstrumentSerif-Italic.ttf", "Instrument Serif"),
        ("inter", "Inter[opsz,wght].ttf", "inter/Inter-VF.ttf", "Inter"),
        ("jetbrainsmono", "JetBrainsMono[wght].ttf", "jetbrainsmono/JetBrainsMono-VF.ttf", "JetBrains Mono"),
        ("michroma", "Michroma-Regular.ttf", "michroma/Michroma-Regular.ttf", "Michroma"),
        ("poppins", "Poppins-Black.ttf", "poppins/Poppins-Black.ttf", "Poppins"),
        ("poppins", "Poppins-SemiBold.ttf", "poppins/Poppins-SemiBold.ttf", "Poppins"),
        ("pressstart2p", "PressStart2P-Regular.ttf", "pressstart2p/PressStart2P-Regular.ttf", "Press Start 2P"),
        ("rajdhani", "Rajdhani-Bold.ttf", "rajdhani/Rajdhani-Bold.ttf", "Rajdhani"),
        ("rajdhani", "Rajdhani-SemiBold.ttf", "rajdhani/Rajdhani-SemiBold.ttf", "Rajdhani"),
        ("sora", "Sora[wght].ttf", "sora/Sora-VF.ttf", "Sora"),
        ("unbounded", "Unbounded[wght].ttf", "unbounded/Unbounded-VF.ttf", "Unbounded"),
        ("vt323", "VT323-Regular.ttf", "vt323/VT323-Regular.ttf", "VT323"),
    ):
        google_font(directory, filename, f"{latin}/{dest}", family)
    google_font("luckiestguy", "LuckiestGuy-Regular.ttf", f"{latin}/luckiestguy/LuckiestGuy-Regular.ttf",
                "Luckiest Guy", category="apache")
    for directory, filename, family in (
        ("longcang", "LongCang-Regular.ttf", "Long Cang"),
        ("lxgwmarkergothic", "LXGWMarkerGothic-Regular.ttf", "LXGW Marker Gothic"),
        ("notosanssc", "NotoSansSC[wght].ttf", "Noto Sans SC"),
        ("zcoolkuaile", "ZCOOLKuaiLe-Regular.ttf", "ZCOOL KuaiLe"),
    ):
        dest = "NotoSansSC-VF.ttf" if directory == "notosanssc" else filename
        google_font(directory, filename, f"{cjk}/{directory}/{dest}", family)
    static_instance("unbounded", "Unbounded[wght].ttf", INSTANCE_PATHS[0],
                    "Unbounded", {"wght": 800})
    static_instance("fraunces", "Fraunces[SOFT,WONK,opsz,wght].ttf", INSTANCE_PATHS[1],
                    "Fraunces", {"SOFT": 100, "WONK": 1, "opsz": 72, "wght": 900})
    static_instance("outfit", "Outfit[wght].ttf", INSTANCE_PATHS[2], "Outfit", {"wght": 600})
    google_font("mrdafoe", "MrDafoe-Regular.ttf", INSTANCE_PATHS[3], "Mr Dafoe")


def zip_member(archive, filename):
    entries = [entry for entry in archive.infolist() if entry.filename == filename]
    if len(entries) != 1:
        raise ValueError(f"Missing or duplicate archive member: {filename}")
    entry = entries[0]
    path = PurePosixPath(entry.filename.replace("\\", "/"))
    mode = entry.external_attr >> 16
    if (path.is_absolute() or ".." in path.parts or ":" in entry.filename
            or entry.is_dir() or (mode & 0o170000) == 0o120000
            or entry.file_size > MAX_DOWNLOAD):
        raise ValueError(f"Unsafe ZIP member: {filename}")
    # Read only the selected entry into memory; no archive paths reach the filesystem.
    return archive.read(entry)


def provision_remaining_chinese():
    base = "vendor/mg-styles-15/assets/fonts/cjk"
    with zipfile.ZipFile(io.BytesIO(download(HARMONY_URL))) as archive:
        data = zip_member(archive, "HarmonyOS Sans/HarmonyOS_Sans_SC.ttf")
        canonical = f"{base}/harmonyossanssc/HarmonyOS_Sans_SC_Regular.ttf"
        output(canonical, data, [HARMONY_URL], "HarmonyOS Sans SC",
               "Unmodified upstream variable TTF; existing CSS selects weight 400")
        for weight in ("Light", "Medium", "Bold", "Black"):
            output(f"{base}/harmonyossanssc/HarmonyOS_Sans_SC_{weight}.ttf",
                   data, [HARMONY_URL], "HarmonyOS Sans SC",
                   "Unmodified upstream variable TTF; existing CSS selects weight; hardlinked when supported",
                   link_to=canonical)
        output("vendor/fonts/licenses/harmonyos-sans-LICENSE-update.txt",
               zip_member(archive, "HarmonyOS Sans/LICENSE-update.txt"), [HARMONY_URL])

    with zipfile.ZipFile(io.BytesIO(download(FUSION_URL))) as archive:
        filename = "fusion-pixel-12px-proportional-zh_hans.ttf.woff2"
        with TTFont(io.BytesIO(zip_member(archive, filename)), recalcTimestamp=False) as font:
            font.flavor = None
            result = io.BytesIO()
            font.save(result)
        relative = f"{base}/fusionpixel/fusion-pixel-12px-proportional-zh_hans.ttf"
        output(relative, result.getvalue(), [FUSION_URL], "Fusion Pixel 12px Prop zh-Hans",
               "WOFF2 to TTF decompression only; family/name records preserved")
        ASSETS[relative]["cssFamily"] = "Fusion Pixel 12"
        for filename in ("OFL.txt", "LICENSES/ark-pixel/OFL.txt",
                         "LICENSES/cubic-11/OFL.txt", "LICENSES/galmuri/LICENSE.txt"):
            output("vendor/fonts/licenses/fusion-pixel/" + filename,
                   zip_member(archive, filename), [FUSION_URL])

    url = "https://fonts.alibabadesign.com/AlimamaShuHeiTi/AlimamaShuHeiTi-Bold.zip"
    with zipfile.ZipFile(io.BytesIO(download(url))) as archive:
        output(f"{base}/alimamashuheiti/AlimamaShuHeiTi-Bold.ttf",
               zip_member(archive, "AlimamaShuHeiTi-Bold.ttf"), [url], "Alimama ShuHeiTi")
        for filename in ("LICENSE.txt", "INSTRUCTION.txt"):
            output("vendor/fonts/licenses/alimamashuheiti-" + filename,
                   zip_member(archive, filename), [url])

    url = "https://fonts.alibabadesign.com/AlibabaPuHuiTi-3/AlibabaPuHuiTi-3-105-Heavy.zip"
    with zipfile.ZipFile(io.BytesIO(download(url))) as archive:
        filename = "AlibabaPuHuiTi-3-105-Heavy"
        output(f"{base}/alibabapuhuiti3/{filename}.ttf",
               zip_member(archive, f"{filename}/{filename}.ttf"), [url], "Alibaba PuHuiTi")
    for weight in ("55-Regular", "65-Medium", "85-Bold", "115-Black"):
        filename = f"AlibabaPuHuiTi-3-{weight}"
        url = f"https://fonts.alibabadesign.com/AlibabaPuHuiTi-3/{filename}/{filename}.ttf"
        source_font(url, f"{base}/alibabapuhuiti3/{filename}.ttf", "Alibaba PuHuiTi")
    url = "https://www.yuque.com/yiguang-wkqc2/puhuiti/nus9wiinq4aeiegy/markdown?plain=true"
    license_data = download(url)
    if b"<!DOCTYPE" in license_data[:200] or len(license_data) < 2000:
        raise ValueError("Alibaba legal statement did not return complete plain Markdown")
    output("vendor/fonts/licenses/alibabapuhuiti3-LICENSE.md", license_data, [url])


def intersects(ranges, codepoints):
    for token in ranges.split(","):
        token = token.strip().removeprefix("U+").removeprefix("u+")
        if "-" in token:
            low, high = (int(part, 16) for part in token.split("-"))
        elif "?" in token:
            low, high = int(token.replace("?", "0"), 16), int(token.replace("?", "F"), 16)
        else:
            low = high = int(token, 16)
        if any(low <= point <= high for point in codepoints):
            return True
    return False


def provision_promo():
    targets = (
        "vendor/motion-promo-film/templates/fonts",
        "vendor/motion-promo-film-v2/references/fonts",
    )
    for package, family in (("instrument-serif", "Instrument Serif"), ("jetbrains-mono", "JetBrains Mono")):
        base = f"https://cdn.jsdelivr.net/npm/@fontsource/{package}@{FONTSOURCE_VERSION}"
        styles = ((400, "normal"), (400, "italic")) if package == "instrument-serif" else ((400, "normal"), (700, "normal"))
        for weight, style in styles:
            filename = f"{package}-latin-{weight}-{style}.woff2"
            url = f"{base}/files/{filename}"
            data = download(url)
            for target in targets:
                output(f"{target}/{filename}", data, [url], family)
        license_url = f"{base}/LICENSE"
        output(f"vendor/fonts/licenses/{package}-OFL.txt", download(license_url), [license_url])

    base = f"https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@{FONTSOURCE_VERSION}"
    codepoints = set(range(32, 127))
    for html in (
        ROOT / "vendor/motion-promo-film/templates/film-template.html",
        ROOT / "vendor/motion-promo-film/templates/film-template-plus.html",
        ROOT / "vendor/motion-promo-film-v2/references/example-film.html",
    ):
        if html.is_file():
            codepoints.update(map(ord, html.read_text(encoding="utf-8")))
    css_blocks = []
    css_sources = []
    # Keep real weights; the original helper incorrectly relabels weight 700 as 400.
    for weight in (400, 700):
        css_url = f"{base}/{weight}.css"
        css_sources.append(css_url)
        css = download(css_url).decode("utf-8")
        for block in re.findall(r"@font-face\s*\{[^}]+\}", css):
            ranges = re.search(r"unicode-range:\s*([^;]+)", block).group(1)
            if not intersects(ranges, codepoints):
                continue
            filename = re.search(r"url\(\./files/([^()]+\.woff2)\)", block).group(1)
            url = f"{base}/files/{filename}"
            data = download(url)
            for target in targets:
                output(f"{target}/nscs/{filename}", data, [url], "Noto Serif SC")
            block = re.sub(r"src:[^;]+;", f"src: url(nscs/{filename}) format('woff2');", block)
            css_blocks.append(block.replace("font-display: swap;", "font-display: block;"))
    css = ("/* Exact Noto Serif SC 400/700; selected for bundled templates. */\n" +
           "\n\n".join(css_blocks) + "\n").encode("utf-8")
    for target in targets:
        output(f"{target}/notoserifsc.css", css, css_sources, transformation="Unicode-range subset selection; weights and font names unchanged")
    license_url = f"{base}/LICENSE"
    output("vendor/fonts/licenses/noto-serif-sc-fontsource-OFL.txt", download(license_url), [license_url])


def check():
    if not MANIFEST.exists():
        raise ValueError("Font manifest missing; run provisioning first")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for asset in manifest["assets"]:
        data = destination(asset["path"]).read_bytes()
        if sha256(data) != asset["sha256"]:
            raise ValueError(f"Font asset checksum mismatch: {asset['path']}")
        if "family" in asset:
            font_info(data, asset["family"])
    mg_css = ROOT / "vendor/mg-styles-15/assets/fonts/fonts.css"
    missing = [
        path for path in re.findall(r"url\(['\"]?([^)'\"\s]+)", mg_css.read_text(encoding="utf-8"))
        if not (ROOT / "vendor/mg-styles-15" / path.lstrip("/")).is_file()
    ]
    total = sum(asset["bytes"] for asset in manifest["assets"])
    unique = {asset["sha256"]: asset["bytes"] for asset in manifest["assets"]}
    print(f"PASS: {len(manifest['assets'])} licensed font assets, "
          f"{sum(unique.values()) / 1024 / 1024:.2f} MiB unique / "
          f"{total / 1024 / 1024:.2f} MiB across paths; hashes and internal names verified.")
    if missing:
        print("Unprovisioned shared stylesheet fonts: " + ", ".join(missing))


SMOKE_JS = r"""
import http from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, extname } from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { templates, ROOT } from './src/catalog.mjs';
import { renderTemplate } from './src/render-template.mjs';

const mgRoot = resolve(ROOT, 'vendor/mg-styles-15');
const outputRoot = resolve(ROOT, 'artifacts/fonts-check/all15');
await mkdir(outputRoot, { recursive: true });
const dataContext = { window: {} };
vm.runInNewContext(readFileSync(resolve(mgRoot, 'site/data.js'), 'utf8'), dataContext);
const films = dataContext.window.FILMS;
const css = readFileSync(resolve(mgRoot, 'assets/fonts/fonts.css'), 'utf8');
const cssFaces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(([_, body]) => ({
  family: body.match(/font-family:\s*['"]([^'"]+)/)?.[1],
  weight: body.match(/font-weight:\s*([^;]+)/)?.[1].trim() || '400',
  style: body.match(/font-style:\s*([^;]+)/)?.[1].trim() || 'normal',
  path: body.match(/url\(['"]?([^)'"]+)/)?.[1]
}));
const cjk = new Set(['Alibaba PuHuiTi', 'Alimama ShuHeiTi', 'Douyin Sans',
  'Fusion Pixel 12', 'HarmonyOS Sans SC', 'Long Cang', 'LXGW Marker Gothic',
  'Noto Sans SC', 'Noto Serif SC', 'Resource Han Rounded', 'ZCOOL KuaiLe']);
const extraFamilies = {'08-morph':'Outfit Morph','10-synthwave':'Mr Dafoe','07-liquid':'Fraunces Liquid'};
const type = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript',
  '.json':'application/json','.css':'text/css','.ttf':'font/ttf','.woff2':'font/woff2',
  '.png':'image/png','.jpg':'image/jpeg','.hdr':'application/octet-stream'};
const server = http.createServer(async(req,res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    const root = pathname.startsWith('/node_modules/') ? ROOT : mgRoot;
    const file = await realpath(resolve(root, '.' + pathname));
    const rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) throw Error('outside root');
    res.writeHead(200, {'content-type':type[extname(file)] || 'application/octet-stream'});
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  ...(process.env.EAC_BROWSER ? {executablePath:process.env.EAC_BROWSER} : {channel:'msedge'}),
  headless:true
});
const results = [];
const category = path => /\.(ttf|otf|woff2?)$/i.test(path) ? 'font'
  : /04-3d-render\/(?:out|assets\/mesh)\//.test(path) ? 'blender'
  : path.startsWith('/node_modules/') ? 'javascript-dependency'
  : /\.(png|jpe?g|webp|hdr)$/i.test(path) ? 'image-texture'
  : /\.(wav|mp3|ogg)$/i.test(path) ? 'audio' : 'data-source';
try {
  for (const template of templates.filter(t => t.source === 'mg-styles-15')) {
    const film = films.find(f => f.slug === template.id);
    const dir = resolve(outputRoot, template.id);
    await mkdir(dir, {recursive:true});
    const result = {templateId:template.id, duration:.5, fps:6, scale:.25,
      render:null, inventoryMissing:[], fontChecks:[], browserMissing:[], pageErrors:[]};
    const expected = new Set([
      ...film.files.map(f => `/demos/${template.id}/${f.p}`),
      ...film.shared.map(p => '/' + p),
      ...film.localFonts.map(p => `/demos/${template.id}/${p}`)
    ]);
    for (const face of cssFaces.filter(f => film.fonts.includes(f.family))) expected.add(face.path);
    if (template.id === '04-3d-render') {
      for (let i=0; i<240; i++) expected.add(`/demos/04-3d-render/out/frames/${String(i).padStart(4,'0')}.png`);
    }
    for (const path of expected) {
      if (!existsSync(resolve(mgRoot, '.' + path))) result.inventoryMissing.push({path,category:category(path)});
    }
    // Every catalog entry gets an actual renderTemplate attempt, including the Blender guard.
    const started = Date.now();
    try {
      const r = await renderTemplate({templateId:template.id, duration:.5, fps:6, scale:.25,
        outputPath:resolve(dir,'preview.mp4'), signal:AbortSignal.timeout(60000)});
      result.render = {ok:r.qa.ok && r.productionReady, encoded:true,
        deterministic:r.deterministic, productionReady:r.productionReady, qa:r.qa,
        missingAssets:r.missingAssets.map(p=>new URL(p).pathname)};
    } catch(e) { result.render = {ok:false,encoded:false,error:e.message}; }
    result.render.elapsedMs = Date.now()-started;
    const page = await browser.newPage({
      viewport:{width:template.width,height:template.height},deviceScaleFactor:.25
    });
    page.setDefaultTimeout(10000);
    page.on('response', r => {
      if(r.status()>=400) result.browserMissing.push({path:new URL(r.url()).pathname,category:category(new URL(r.url()).pathname)});
    });
    page.on('pageerror', e => result.pageErrors.push(e.message));
    try {
      await page.goto(url + `/demos/${template.id}/index.html`, {waitUntil:'load',timeout:15000});
      try { await page.waitForFunction(()=>window.__ready === true, null, {timeout:3000}); } catch {}
      result.ready = await page.evaluate(()=>window.__ready === true);
      if(result.ready && template.id !== '04-3d-render') {
        try {
          await page.evaluate(async()=>{await(window.renderAt||window.__seek)(8.8);await document.fonts.ready;});
          await page.screenshot({path:resolve(dir,'visible.png'),timeout:10000});
        } catch(e) {result.visibleFrameError=e.message;}
      }
      const checks = cssFaces.filter(f => film.fonts.includes(f.family));
      if(extraFamilies[template.id]) checks.push({family:extraFamilies[template.id],weight:'400',style:'normal'});
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      for(const face of checks) {
        const weight = face.weight.includes(' ') ? '400' : face.weight;
        const spec = `${face.style} ${weight} 32px "${face.family}"`;
        const text = cjk.has(face.family) ? '\u50cf\u7d20\u4e16\u754c' : 'ABC0123';
        const probe = {family:face.family,declaredWeight:face.weight,spec,text};
        try {
          probe.loaded = await page.evaluate(async({spec,text})=>{
            const faces=await document.fonts.load(spec,text);
            let span=document.getElementById('eac-font-probe');
            if(!span){span=document.createElement('span');span.id='eac-font-probe';document.body.append(span);}
            span.style.cssText='position:fixed;left:0;top:0;z-index:999999;background:white;color:black';
            span.style.font=spec;span.textContent=text;await document.fonts.ready;
            return faces.map(f=>({family:f.family,weight:f.weight,status:f.status}));
          },{spec,text});
          const {root}=await cdp.send('DOM.getDocument');
          const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:'#eac-font-probe'});
          probe.platformFonts=(await cdp.send('CSS.getPlatformFontsForNode',{nodeId})).fonts;
          probe.ok=probe.loaded.length>0 && probe.platformFonts.length>0
            && probe.platformFonts.every(f=>f.isCustomFont);
        } catch(e) {probe.ok=false;probe.error=e.message;}
        result.fontChecks.push(probe);
      }
    } catch(e) {result.browserError=e.message;}
    await page.close();
    result.browserMissing=[...new Map(result.browserMissing.map(x=>[x.path,x])).values()];
    result.fontsVerified=result.fontChecks.length>0 && result.fontChecks.every(f=>f.ok);
    result.supportedBySmoke=result.render.ok && result.fontsVerified;
    results.push(result);
    await writeFile(resolve(dir,'font-inventory.json'),JSON.stringify(result,null,2)+'\n');
    await writeFile(resolve(outputRoot,'summary.json'),JSON.stringify(results,null,2)+'\n');
    console.log(JSON.stringify({templateId:result.templateId,render:result.render.ok,
      fonts:result.fontsVerified,missing:result.browserMissing,error:result.render.error,
      elapsedMs:result.render.elapsedMs}));
  }
} finally {
  await browser.close();
  await new Promise(r=>{server.close(r);server.closeAllConnections();});
}
"""


def smoke():
    subprocess.run(["node", "--input-type=module", "-e", SMOKE_JS],
                   cwd=ROOT, check=True, timeout=1200)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify installed assets offline without downloading")
    parser.add_argument("--smoke", action="store_true", help="Sequential bounded MG15 renders and browser font/asset inventory")
    args = parser.parse_args()
    if args.smoke:
        smoke()
        return
    if args.check:
        check()
        return
    provision_mg()
    provision_remaining_google()
    provision_remaining_chinese()
    provision_promo()
    manifest = {
        "schemaVersion": 1,
        "license": "See licenses/ for original upstream licenses and copyright notices (OFL, Apache, or vendor-specific)",
        "googleFontsCommit": GOOGLE_COMMIT,
        "fontsourceVersion": FONTSOURCE_VERSION,
        "resourceHanRoundedVersion": "v0.990",
        "scope": ["motion-promo-film", "motion-promo-film-v2", "mg-styles-15"],
        "unprovisioned": [{
            "family": "Douyin Sans",
            "path": "vendor/mg-styles-15/assets/fonts/cjk/douyinsans/DouyinSansBold.ttf",
            "reason": "No usable official original font plus license obtained; no substitute installed",
        }],
        "sourceBytes": sum(item["bytes"] for item in SOURCES.values()),
        "sources": sorted(SOURCES.values(), key=lambda item: item["url"]),
        "assets": sorted(ASSETS.values(), key=lambda item: item["path"]),
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    check()


if __name__ == "__main__":
    main()
