"""Local, pinned GPT-SoVITS v2 worker. Text and paths are JSON data."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import sys


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def local_file(root, value):
    path = (root / value).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError(f'曼波音色文件不存在或超出目录：{value}')
    return path


def split_text(text, limit=100):
    """Bound semantic generations so long narration is not silently truncated."""
    buffer = ''
    for sentence in re.findall(r'[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+', text):
        if buffer and len(buffer) + len(sentence) > limit:
            yield buffer
            buffer = ''
        while len(sentence) > limit:
            yield sentence[:limit]
            sentence = sentence[limit:]
        buffer += sentence
    if buffer.strip():
        yield buffer


def main(request_path):
    request = json.loads(Path(request_path).read_text(encoding='utf-8'))
    root = Path(request['voiceRoot']).resolve()
    profile_path = local_file(root, request['profilePath'])
    if sha256(profile_path) != request['profileSha256']:
        raise ValueError('曼波音色基准配置已改变，profileSha256 不匹配')
    profile = json.loads(profile_path.read_text(encoding='utf-8'))
    if (profile.get('schema_version') != 1 or profile.get('selection') != 'user_confirmed_sample'
            or profile.get('voice_id') != 'mambo-gpt-sovits-v1'
            or profile.get('engine', {}).get('version') != 'v2'):
        raise ValueError('曼波音色不是已确认的 v2 基准')
    pinned = {}
    for item in profile['models_and_frontend']:
        path = local_file(root, item['path'])
        if sha256(path) != item['sha256']:
            raise ValueError(f"曼波模型或前处理已改变，SHA-256 不匹配：{item['path']}")
        pinned[path] = item

    def find_file(suffix):
        matches = [path for path in pinned if path.as_posix().endswith(suffix)]
        if len(matches) != 1:
            raise ValueError(f'曼波基准缺少唯一文件：{suffix}')
        return matches[0]

    engine = Path(request['engineRoot']).resolve()
    if (engine / 'GPT_SoVITS/text/chinese2.py').resolve() not in pinned:
        raise ValueError('运行引擎的中文前处理不属于已锚定基准')
    reference = local_file(root, profile['reference']['audio'])
    if reference not in pinned:
        raise ValueError('参考音频不属于已锚定基准')
    bert = find_file('chinese-roberta-wwm-ext-large/pytorch_model.bin').parent
    hubert = find_file('chinese-hubert-base/pytorch_model.bin').parent
    for path in [bert / 'config.json', bert / 'tokenizer.json', hubert / 'config.json', hubert / 'preprocessor_config.json']:
        if path not in pinned:
            raise ValueError(f'基准缺少模型配置：{path.name}')
    text = request['text']
    if not isinstance(text, str) or not text.strip() or len(text) > 20000:
        raise ValueError('旁白文案必须为 1 至 20000 字')
    rate = request.get('rate', 0)
    if not isinstance(rate, int) or not -10 <= rate <= 10:
        raise ValueError('旁白语速必须为 -10 至 10 的整数')
    parameters = dict(profile['inference'])
    use_g2pw = parameters.pop('is_g2pw', False)
    os.environ.update({'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'HF_DATASETS_OFFLINE': '1',
                       'GRADIO_ANALYTICS_ENABLED': 'False', 'DO_NOT_TRACK': '1', 'OMP_NUM_THREADS': '1',
                       'is_g2pw': str(use_g2pw), 'version': 'v2', 'language': 'zh_CN'})
    os.chdir(engine)
    sys.path[:0] = [str(engine), str(engine / 'GPT_SoVITS')]
    import numpy as np
    import soundfile as sf
    import torch
    from TTS_infer_pack.TTS import TTS, TTS_Config

    torch.set_num_threads(profile['engine'].get('torch_num_threads', 4))
    config = TTS_Config({'version': 'v2', 'custom': {
        'version': 'v2', 'device': 'cpu', 'is_half': False,
        't2s_weights_path': str(find_file('manbo-e10.ckpt')),
        'vits_weights_path': str(find_file('manbo_e8_s168.pth')),
        'bert_base_path': str(bert), 'cnhuhbert_base_path': str(hubert)}})
    model = TTS(config)
    parameters.update({'ref_audio_path': str(reference), 'prompt_text': profile['reference']['text'],
                       'prompt_lang': profile['reference']['language']})
    parameters['speed_factor'] = parameters.get('speed_factor', 1.0) * 2 ** (rate / 10)
    chunks = []
    sample_rate = None
    with torch.inference_mode():
        for part in split_text(text, limit=min(100, max(25, int(100 * 2 ** (rate / 10))))):
            for sr, audio in model.run({**parameters, 'text': part}):
                if sample_rate is not None and sr != sample_rate:
                    raise ValueError('旁白分段采样率不一致')
                sample_rate = sr
                chunks.append(audio)
    if not chunks:
        raise ValueError('曼波推理未生成音频')
    audio = np.concatenate(chunks)
    if not np.isfinite(audio).all():
        raise ValueError('曼波推理返回无效音频')
    normalized = audio.astype(float) / (32768 if np.issubdtype(audio.dtype, np.integer) else 1)
    if not audio.size or np.sqrt(np.mean(normalized ** 2)) < 0.001:
        raise ValueError('曼波推理返回静音')
    sf.write(request['outputPath'], audio, sample_rate, subtype='PCM_16')
    metadata = {'id': 'mambo-zh', 'name': '曼波中文', 'engine': 'GPT-SoVITS',
                'profileId': profile['voice_id'], 'profileSha256': sha256(profile_path),
                'anchorSha256': profile['approved_sample']['sha256'], 'seed': parameters['seed'],
                'sampleRate': sample_rate, 'duration': len(audio) / sample_rate}
    Path(request['metadataPath']).write_text(json.dumps(metadata, ensure_ascii=False), encoding='utf-8')


if __name__ == '__main__':
    try:
        with contextlib.redirect_stdout(sys.stderr):
            main(sys.argv[1])
    except Exception as error:
        print(f'曼波本地推理失败：{error}', file=sys.stderr)
        sys.exit(1)
