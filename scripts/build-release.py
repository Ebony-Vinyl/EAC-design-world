#!/usr/bin/env python3
"""Build source-backed plugin and optional media ZIPs without user data or credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
EXCLUDED = {
    'vendor/motion-promo-film/templates/lib/motion.js',
    'vendor/motion-promo-film/templates/film-template-plus.html',
    'vendor/open-design/templates/prompts/image/profile-avatar-seedream-high-fashion-dreamy-portrait.json',
    'vendor/open-design/templates/prompts/image-assets/profile-avatar-seedream-high-fashion-dreamy-portrait.jpg',
    'vendor/open-design/templates/prompts/image/social-media-post-seedream-squishcraft-kids-clay-ad.json',
    'vendor/open-design/templates/prompts/image-assets/social-media-post-seedream-squishcraft-kids-clay-ad.jpg',
}
MEDIA_EXTENSIONS = {'.ttf', '.flac', '.wav', '.ply', '.hdr'}
FONT_EXCLUDES = ('vendor/mg-styles-15/assets/fonts/cjk/alibabapuhuiti3/', 'vendor/mg-styles-15/assets/fonts/cjk/alimamashuheiti/')

def excluded_file(name):
    return name in EXCLUDED or name.startswith(FONT_EXCLUDES + ('vendor/motion-web/', 'vendor/onetake/'))

def media_file(relative):
    p = Path(relative)
    if relative.startswith(('public/media/', 'dist/media/', 'vendor/mg-styles-15/videos/')):
        return True
    if not relative.startswith('vendor/mg-styles-15/'):
        return False
    return p.suffix.lower() in MEDIA_EXTENSIONS or (
        p.suffix.lower() in {'.png', '.jpg'} and relative.startswith(('vendor/mg-styles-15/assets/', 'vendor/mg-styles-15/demos/')))

def source_files(working_tree=False):
    command = ['git', 'ls-files', '-z']
    if working_tree:
        command += ['--cached', '--others', '--exclude-standard']
    result = subprocess.run(command, cwd=ROOT, check=True, capture_output=True)
    return [name for name in result.stdout.decode('utf-8').split('\0') if name and not excluded_file(name)]

def make_zip(target, names):
    if target.exists():
        raise RuntimeError(f'Refusing to overwrite release asset: {target}')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for name in sorted(set(names)):
            path = ROOT / name
            if path.is_file():
                archive.write(path, f'eac-design-world/{name}')
    return {'file': target.name, 'bytes': target.stat().st_size, 'sha256': hashlib.file_digest(target.open('rb'), 'sha256').hexdigest()}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default=f'release/v{VERSION}')
    parser.add_argument('--working-tree', action='store_true', help='Include new non-ignored source files without staging or committing')
    parser.add_argument('--plugin-only', action='store_true', help='Skip rebuilding the unchanged optional large media archive')
    args = parser.parse_args()
    destination = (ROOT / args.output).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    tracked = source_files(args.working_tree)
    if not tracked:
        raise RuntimeError('Stage/commit the public source tree before packaging')
    required = {'src/motion-libraries.mjs', 'scripts/import-motion-libraries.mjs',
                'scripts/verify-motion-libraries.mjs', 'vendor/eac-motion/onetake-demo.html',
                'src/lossless-json.mjs', 'src/maintenance.mjs', 'src/maintenance-updater.mjs',
                'src/maintenance-feed.mjs', 'src/maintenance-reload.mjs', 'src/maintenance-key.mjs',
                'src/version.mjs', 'ui/MaintenancePanel.jsx', 'feed/announcements.json'}
    missing = sorted(required - set(tracked))
    if missing:
        raise RuntimeError('Stage/commit new runtime files before packaging: ' + ', '.join(missing))
    built = ['dist/' + p.relative_to(ROOT / 'dist').as_posix() for p in (ROOT / 'dist').rglob('*') if p.is_file()]
    if 'dist/index.html' not in built:
        raise RuntimeError('Run npm run build before packaging')
    plugin = [name for name in tracked if not media_file(name)] + [name for name in built if not media_file(name)]
    media = []
    for base in [ROOT / 'public/media', ROOT / 'vendor/mg-styles-15']:
        for path in base.rglob('*'):
            if path.is_file() and '.git' not in path.parts and 'node_modules' not in path.parts:
                relative = path.relative_to(ROOT).as_posix()
                if media_file(relative) and not excluded_file(relative):
                    media.append(relative)
    for name in list(media):
        if name.startswith('public/media/'):
            media.append('dist/' + name.removeprefix('public/'))
    media += [name for name in tracked if name in {'LICENSE', 'THIRD_PARTY_NOTICES.md'} or name.startswith('vendor/fonts/licenses/') or name == 'vendor/mg-styles-15/LICENSE']
    assets = [make_zip(destination / f'eac-design-world-v{VERSION}-plugin.zip', plugin)]
    if not args.plugin_only:
        assets.append(make_zip(destination / f'eac-design-world-v{VERSION}-media.zip', media))
    (destination / 'SHA256SUMS.txt').write_text(''.join(f'{item["sha256"]}  {item["file"]}\n' for item in assets), encoding='utf-8')
    (destination / 'manifest.json').write_text(json.dumps({'version': VERSION, 'assets': assets}, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(assets, indent=2))

if __name__ == '__main__':
    main()
