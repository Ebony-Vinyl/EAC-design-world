"""Extract only pinned package content and create a machine-local voice profile."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import zipfile


def safe_entries(archive):
    entries = archive.infolist()
    if len(entries) > 15000 or sum(i.file_size for i in entries) > 768 * 1024 * 1024:
        raise ValueError('安装包解压大小超出限制')
    for item in entries:
        path = PurePosixPath(item.filename)
        if ('\\' in item.filename or path.is_absolute() or '..' in path.parts
                or ':' in item.filename or stat.S_ISLNK(item.external_attr >> 16)):
            raise ValueError('安装包包含不安全路径')
    return entries


def install(request):
    root = Path(request['root']).resolve()
    with zipfile.ZipFile(request['engineArchive']) as archive:
        entries = safe_entries(archive)
        folders = {PurePosixPath(i.filename).parts[0] for i in entries}
        if len(folders) != 1:
            raise ValueError('运行引擎目录结构无效')
        target = root / 'runtime/GPT-SoVITS'
        for item in entries:
            parts = PurePosixPath(item.filename).parts[1:]
            if not parts or item.is_dir():
                continue
            path = target.joinpath(*parts)
            path.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as source, path.open('wb') as output:
                shutil.copyfileobj(source, output)
    models = {'manbo-e10.ckpt', 'manbo_e8_s168.pth', 'refer.wav'}
    with zipfile.ZipFile(request['voiceArchive']) as archive:
        entries = safe_entries(archive)
        for name in models:
            matches = [i for i in entries if PurePosixPath(i.filename).name == name and not i.is_dir()]
            if len(matches) != 1:
                raise ValueError(f'音色包缺少唯一文件：{name}')
            path = root / 'gpt-model' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(matches[0]) as source, path.open('wb') as output:
                shutil.copyfileobj(source, output)
    for asset in request['assets']:
        if 'target' in asset:
            path = root / asset['target']
            if not path.resolve().is_relative_to(root):
                raise ValueError('模型目标超出安装目录')
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(asset['cached'], path)
    frontend = root / 'runtime/GPT-SoVITS/GPT_SoVITS/text/chinese2.py'
    source = frontend.read_text(encoding='utf-8')
    original = "is_g2pw = True  # True if is_g2pw_str.lower() == 'true' else False"
    if original not in source:
        raise ValueError('固定版本的中文前处理结构已改变')
    frontend.write_text(source.replace(original, "is_g2pw = os.environ.get('is_g2pw', 'True').lower() == 'true'"), encoding='utf-8', newline='\n')
    profile = request['profile']
    for entry in profile['models_and_frontend']:
        path = (root / entry['path']).resolve()
        if not path.is_relative_to(root):
            raise ValueError('音色文件超出安装目录')
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != entry['sha256']:
            raise ValueError(f"音色文件校验失败：{entry['path']}")
    destination = root / 'voice-anchor/voice-profile.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')


if __name__ == '__main__':
    try:
        install(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
    except Exception as error:
        print(f'曼波安装失败：{error}', file=sys.stderr)
        sys.exit(1)
