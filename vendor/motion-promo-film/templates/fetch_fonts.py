# -*- coding: utf-8 -*-
# 字体获取（国内镜像友好）
#   python fetch_fonts.py [film.html]
# 行为：
#   1) 西文单文件字体（小，jsdelivr 直下）
#   2) CJK 字体（大）：npmmirror 拉 @fontsource tarball（单连接大文件，绕过分片限速），
#      解包后按 html 里实际用到的码点过滤 unicode-range 分片，生成 fonts/<family>.css
import re, os, sys, shutil, urllib.request, tarfile

HTML = sys.argv[1] if len(sys.argv) > 1 else 'film.html'

LATIN = [  # (fontsource 包名, 版本, 文件名, @font-face 附加)
    ('@fontsource/instrument-serif', '5.2.5', 'instrument-serif-latin-400-normal.woff2',
     "@font-face{font-family:'Instrument Serif';src:url(fonts/instrument-serif-latin-400-normal.woff2) format('woff2');font-weight:400;font-style:normal}"),
    ('@fontsource/instrument-serif', '5.2.5', 'instrument-serif-latin-400-italic.woff2',
     "@font-face{font-family:'Instrument Serif';src:url(fonts/instrument-serif-latin-400-italic.woff2) format('woff2');font-weight:400;font-style:italic}"),
    ('@fontsource/jetbrains-mono', '5.2.5', 'jetbrains-mono-latin-400-normal.woff2',
     "@font-face{font-family:'JetBrains Mono';src:url(fonts/jetbrains-mono-latin-400-normal.woff2) format('woff2');font-weight:400}"),
    ('@fontsource/jetbrains-mono', '5.2.5', 'jetbrains-mono-latin-700-normal.woff2',
     "@font-face{font-family:'JetBrains Mono';src:url(fonts/jetbrains-mono-latin-700-normal.woff2) format('woff2');font-weight:700}"),
]
CJK = dict(pkg='@fontsource/noto-serif-sc', ver='5.2.5', weight='700',
           family='Noto Serif SC', outcss='fonts/notoserifsc.css', outdir='fonts/nscs')

def dl(url, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst) and os.path.getsize(dst) > 500: return
    urllib.request.urlretrieve(url, dst)

# ---- 1) 西文 ----
os.makedirs('fonts', exist_ok=True)
css_extra = []
for pkg, ver, fn, face in LATIN:
    dl(f'https://cdn.jsdelivr.net/npm/{pkg}@{ver}/files/{fn}', f'fonts/{fn}')
    css_extra.append(face)
print('latin fonts ok')

# ---- 2) CJK：tarball + unicode-range 过滤 ----
pkg, ver = CJK['pkg'], CJK['ver']
name = pkg.split('/')[-1]
tgz = f'{name}-{ver}.tgz'
short = name.replace('@fontsource/', '')
url = f'https://registry.npmmirror.com/{pkg}/-/{short}-{ver}.tgz'
print('downloading', url)
urllib.request.urlretrieve(url, tgz)
with tarfile.open(tgz) as tf:
    tf.extractall('_fontpkg')
css = open(f'_fontpkg/package/{CJK["weight"]}.css', encoding='utf-8').read()

html = open(HTML, encoding='utf-8').read()
cps = set(ord(c) for c in html) | set(range(0x20, 0x7F))
cps |= {ord(c) for c in '·—…“”‘’←→↓↑⌂⌕⧉✕★⚡🌿👋💪🔧📄🔍📊💻📂📋⚙①ⓘ▸▾'}

blocks = re.findall(r'(/\*[^*]+\*/\s*@font-face\s*\{[^}]+\})', css)
keep = []
for b in blocks:
    rng_txt = re.search(r'unicode-range:\s*([^;]+);', b).group(1)
    need = False
    for part in rng_txt.split(','):
        part = part.strip()[2:]
        try:
            if '-' in part:
                a, z = part.split('-')
                if any(int(a,16) <= c <= int(z,16) for c in cps): need = True; break
            elif '?' in part:
                lo, hi = int(part.replace('?','0'),16), int(part.replace('?','F'),16)
                if any(lo <= c <= hi for c in cps): need = True; break
            else:
                if int(part,16) in cps: need = True; break
        except ValueError:
            pass
    if need: keep.append(b)

files = sorted(set(re.findall(r'\./files/([^)]+\.woff2)', '\n'.join(keep))))
os.makedirs(CJK['outdir'], exist_ok=True)
for fn in files:
    shutil.copyfile(f'_fontpkg/package/files/{fn}', f"{CJK['outdir']}/{fn}")
out = '\n'.join(keep).replace(f'./files/', f"{CJK['outdir'].split('/')[-1]}/")
out = out.replace(f'font-weight: {CJK["weight"]};', 'font-weight: 400;').replace('font-display: swap;', 'font-display: block;')
open(CJK['outcss'], 'w', encoding='utf-8').write(out)
shutil.rmtree('_fontpkg'); os.remove(tgz)
print(f'CJK: {len(keep)} subsets, {len(files)} files -> {CJK["outcss"]}')
print('done. html 里已有 <link rel=stylesheet href=fonts/notoserifsc.css> 即可生效')
