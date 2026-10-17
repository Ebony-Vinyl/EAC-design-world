import numpy as np, wave

SR = 48000
DUR = 60.0
N = int(SR * DUR)
rng = np.random.default_rng(7)

def env(n, a, r, hold=None):
    """attack/release envelope, n samples"""
    t = np.arange(n) / SR
    e = np.ones(n)
    an = max(1, int(a * SR)); rn = max(1, int(r * SR))
    e[:an] = np.linspace(0, 1, an) ** 1.6
    if hold is None:
        e[-rn:] *= np.linspace(1, 0, rn) ** 1.3
    return e

def add(buf, sig, t0, gain=1.0, pan=0.0):
    i0 = int(t0 * SR)
    if i0 >= N: return
    seg = sig[:N - i0]
    gl = gain * min(1, 1 - pan); gr = gain * min(1, 1 + pan)
    buf[i0:i0 + len(seg), 0] += seg * gl
    buf[i0:i0 + len(seg), 1] += seg * gr

mix = np.zeros((N, 2))

# ---------------- pad bed: Fmaj7 Am7 Dm7 Bbmaj7, 3.75s each, x4 ----------------
F = {'F2':87.31,'A2':110.0,'C3':130.81,'F3':174.61,'A3':220.0,'C4':261.63,'E4':329.63,
     'D3':146.83,'G3':196.0,'Bb3':233.08,'D4':293.66,'F4':349.23,'Bb2':116.54,'E3':164.81,'G4':392.0}
CHORDS = [
    ['F2','C3','F3','A3','C4','E4'],      # Fmaj7
    ['A2','E3','A3','C4','E4','G4'],      # Am7
    ['D3','F3','A3','D4','F4'],           # Dm7
    ['Bb2','F3','Bb3','D4','F4'],         # Bbmaj7
]
seg_t = 3.75
for rep in range(4):
    for ci, ch in enumerate(CHORDS):
        t0 = (rep * 4 + ci) * seg_t
        n = int(seg_t * SR * 1.25)
        t = np.arange(n) / SR
        v = np.zeros(n)
        for k, name in enumerate(ch):
            f = F[name]
            det = 1 + 0.0012 * np.sin(rep + ci + k)
            w = np.sin(2*np.pi*f*det*t) + 0.34*np.sin(2*np.pi*2*f*t + 0.5) + 0.10*np.sin(2*np.pi*3*f*t + 1.1)
            w += 0.22*np.sin(2*np.pi*(f*1.003)*t + 2.0)          # chorus detune
            v += w / (len(ch) * 1.6)
        # slow tremolo
        v *= 1 + 0.10 * np.sin(2*np.pi*0.13*t + ci)
        e = env(n, 1.6, 1.9)
        add(mix, v * e, t0, gain=0.050, pan=(-0.25 if ci % 2 else 0.25))

# vinyl crackle
crk = (rng.random(N) < 0.00035).astype(float)
crk = np.convolve(crk, np.exp(-np.arange(220)/SR*900), 'same') * rng.random(N)
mix[:, 0] += crk * 0.05; mix[:, 1] += np.roll(crk, 37) * 0.05

# ---------------- SFX ----------------
def tick(f=2600, d=0.028, g=0.10):
    n = int(d*SR); t = np.arange(n)/SR
    s = np.sin(2*np.pi*f*t) * np.exp(-t*140) + 0.4*rng.normal(0, 1, n)*np.exp(-t*260)
    return s * env(n, 0.001, d*0.8)

def thock(f=170, d=0.11, g=0.16):
    n = int(d*SR); t = np.arange(n)/SR
    s = np.sin(2*np.pi*f*(1-1.6*t)*t) * np.exp(-t*26)
    return s * env(n, 0.001, d*0.6)

def whoosh(d=0.55, g=0.14, up=True):
    n = int(d*SR); t = np.arange(n)/SR
    nz = rng.normal(0, 1, n)
    # sweeping bandpass via resonant filter-ish: modulate a sine-free noise through moving average window
    k = np.linspace(90, 7, n) if up else np.linspace(7, 90, n)
    k = k.astype(int)
    out = np.zeros(n); acc = 0.0
    # cheap time-varying lowpass: one-pole
    alpha = np.linspace(0.985 if up else 0.55, 0.55 if up else 0.985, n)
    for i in range(n):
        acc = (1-alpha[i])*nz[i] + alpha[i]*acc
        out[i] = acc
    out /= (np.abs(out).max()+1e-9)
    e = np.sin(np.pi * t/d)**1.4
    return out * e

def blip(f=1240, d=0.09, g=0.09):
    n = int(d*SR); t = np.arange(n)/SR
    s = np.sin(2*np.pi*f*t)*np.exp(-t*30) + 0.5*np.sin(2*np.pi*f*1.5*t)*np.exp(-t*44)
    return s * env(n, 0.002, d*0.5)

def ding(fs=(880, 1318), d=0.7, g=0.10):
    n = int(d*SR); t = np.arange(n)/SR
    s = sum(np.sin(2*np.pi*f*t)*np.exp(-t*4.2) for f in fs)
    return s * env(n, 0.002, d*0.35)

def buzz(d=0.16, g=0.10):
    n = int(d*SR); t = np.arange(n)/SR
    s = np.sign(np.sin(2*np.pi*112*t))*0.4 + 0.6*rng.normal(0,1,n)*np.exp(-t*22)
    s = np.convolve(s, np.ones(6)/6, 'same')
    return s * env(n, 0.002, d*0.5)

def riser(d=0.9, g=0.07):
    n = int(d*SR); t = np.arange(n)/SR
    nz = rng.normal(0, 1, n)
    alpha = np.linspace(0.995, 0.5, n)
    out = np.zeros(n); acc = 0.0
    for i in range(n):
        acc = (1-alpha[i])*nz[i] + alpha[i]*acc; out[i] = acc
    out /= (np.abs(out).max()+1e-9)
    return out * np.linspace(0.0, 1.0, n)**1.7

# typing helpers
def type_ticks(t0, t1, dt=0.062, g=0.05, pan=0.05):
    t = t0
    alt = 1
    while t < t1:
        add(mix, tick(2200+alt*420, g=g), t, g, pan*alt); t += dt; alt = -alt

# --- hook ---
type_ticks(0.45, 1.35)
add(mix, whoosh(0.4, 0.05), 1.5)
add(mix, buzz(), 2.45, 0.11)
for i, tt in enumerate([2.68, 2.81, 2.94, 3.35]):
    add(mix, thock(150+i*18), tt, 0.13)
# --- title ---
add(mix, whoosh(0.6, 0.13), 4.55)
add(mix, thock(90, 0.2, 0.2), 4.95)
for tt in [5.10, 5.35, 5.60]:
    add(mix, tick(1800, g=0.05), tt, 0.05)
# --- modal open / nav ---
add(mix, whoosh(0.5, 0.11), 7.1)
add(mix, tick(1400, g=0.09), 7.75); add(mix, thock(210, g=0.1), 7.95)
add(mix, tick(1400, g=0.09), 8.35); add(mix, thock(230, g=0.09), 8.5)
for i in range(8):
    add(mix, tick(2400+120*i, d=0.02, g=0.035), 7.88+i*0.11)
add(mix, tick(1400, g=0.09), 10.7); add(mix, blip(1560, g=0.06), 10.95)
for i in range(4):
    add(mix, tick(2300, d=0.02, g=0.035), 11.78+i*0.12)
# --- baimo ---
add(mix, tick(1400, g=0.09), 12.7); add(mix, thock(220, g=0.08), 12.85)
for i in range(4):
    add(mix, tick(2250, d=0.02, g=0.035), 13.72+i*0.13)
add(mix, blip(980, g=0.06), 13.4)
add(mix, tick(1400, g=0.09), 14.35)
add(mix, riser(0.8, 0.06), 14.5)
add(mix, blip(1320, g=0.09), 15.55)
add(mix, blip(1180, g=0.07), 15.85)
# --- aggregate ---
add(mix, tick(1400, g=0.09), 17.7)
add(mix, tick(1400, g=0.09), 18.5); add(mix, thock(220, g=0.09), 18.65)
for i in range(10):
    add(mix, tick(2300, d=0.018, g=0.028), 18.85+i*0.05)
type_ticks(19.9, 20.5, 0.075, 0.045)
add(mix, whoosh(0.35, 0.07), 20.55)
add(mix, tick(1400, g=0.09), 20.9); add(mix, thock(225, g=0.09), 21.05)
type_ticks(21.6, 22.0, 0.07, 0.04)
add(mix, tick(1400, g=0.09), 22.35)
add(mix, ding((784, 1175), 0.6, 0.09), 22.8)
add(mix, blip(1046, g=0.06), 23.0)
# --- saver ---
add(mix, tick(1400, g=0.09), 23.2)
add(mix, tick(1500, g=0.09), 23.95); add(mix, blip(880, g=0.06), 24.1)
add(mix, riser(1.1, 0.05), 23.7)
for i in range(8):
    add(mix, tick(2350, d=0.018, g=0.028), 23.9+i*0.09)
# --- route ---
add(mix, tick(1400, g=0.09), 28.0); add(mix, thock(200, g=0.1), 28.35)
for i in range(4):
    add(mix, tick(2200, d=0.02, g=0.04), 29.45+i*0.28)
add(mix, buzz(0.12, 0.09), 31.35)
add(mix, blip(660, d=0.12, g=0.08), 31.85)
add(mix, ding((880, 1320), 0.55, 0.09), 32.35)
# --- board/log ---
add(mix, tick(1400, g=0.09), 33.2)
for i in range(4):
    add(mix, tick(2300, d=0.02, g=0.03), 34.1+i*0.08)
for i in range(5):
    add(mix, tick(2250, d=0.02, g=0.03), 34.55+i*0.22)
add(mix, tick(1400, g=0.09), 36.4)
for i in range(5):
    add(mix, tick(2250, d=0.02, g=0.03), 36.65+i*0.26)
# --- gateway ---
add(mix, tick(1400, g=0.09), 39.4)
add(mix, tick(1500, g=0.09), 40.45)
add(mix, ding((659, 988), 0.7, 0.08), 40.75)
# --- live ---
add(mix, whoosh(0.5, 0.1), 43.35)
add(mix, tick(1400, g=0.09), 43.15)
add(mix, tick(1400, g=0.09), 44.3); add(mix, thock(210, g=0.09), 44.45)
type_ticks(45.4, 45.85)
add(mix, whoosh(0.3, 0.07, up=False), 45.9)
for i in range(5):
    add(mix, tick(2100+90*i, d=0.02, g=0.03), 46.45+i*0.27)
type_ticks(48.65, 49.1)
add(mix, whoosh(0.3, 0.07, up=False), 49.12)
for i in range(9):
    add(mix, tick(2050+80*i, d=0.02, g=0.028), 49.85+i*0.22)
add(mix, blip(1240, g=0.06), 52.05)
# --- end ---
add(mix, whoosh(0.7, 0.13), 52.75)
add(mix, thock(90, 0.22, 0.2), 53.1)
for tt, f in [(53.3, 1650), (53.85, 1500)]:
    add(mix, tick(f, g=0.05), tt, 0.05)
for i in range(5):
    add(mix, thock(150+i*14, 0.1, 0.1), 53.95+i*0.1)
add(mix, thock(180, 0.12, 0.12), 54.7)
add(mix, ding((880, 1175, 1568), 1.0, 0.08), 54.9)
add(mix, whoosh(1.2, 0.05, up=False), 58.9)

# ---------------- master ----------------
l, r = mix[:, 0], mix[:, 1]
# gentle master comp via tanh
l = np.tanh(l * 1.25) / np.tanh(1.25)
r = np.tanh(r * 1.25) / np.tanh(1.25)
peak = max(np.abs(l).max(), np.abs(r).max())
l *= 0.85 / peak; r *= 0.85 / peak
data = np.stack([l, r], axis=1)
pcm = (data * 32767).astype(np.int16)
with wave.open('audio_bed.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('audio_bed.wav written', pcm.shape)
