import json, os, random, re, subprocess, tempfile, urllib.request

ADMIN = os.environ['ADMIN_URL'].rstrip('/')
JOB = os.environ['PREVIEW_JOB_KEY']
BUCKET = os.environ['B2_BUCKET']
EP = os.environ['B2_ENDPOINT'].rstrip('/')
MAX = int(os.environ.get('MAX') or 3)
m = re.search(r's3\.([a-z0-9-]+)\.backblazeb2\.com', EP)
ENV = dict(os.environ, AWS_DEFAULT_REGION=(m.group(1) if m else 'us-west-004'))
KINDS = [('movies', '/preview-todo', '/apply-previews'), ('episodes', '/preview-todo-eps', '/apply-ep-previews')]

def api(path, body=None):
    req = urllib.request.Request(ADMIN + path, data=(json.dumps(body).encode() if body is not None else None),
        headers={'X-Job-Key': JOB, 'Content-Type': 'application/json', 'User-Agent': 'picha-previews'})
    return json.load(urllib.request.urlopen(req, timeout=60))

def sh(args, timeout=300):
    return subprocess.run(args, env=ENV, capture_output=True, text=True, timeout=timeout)

def presign(key):
    r = sh(['aws', 's3', 'presign', f's3://{BUCKET}/{key}', '--endpoint-url', EP, '--expires-in', '3600'], 60)
    if r.returncode: raise RuntimeError('presign: ' + r.stderr[:200])
    return r.stdout.strip()

def flush(apply_path, done):
    if done:
        print('applied:', api(apply_path, {'previews': dict(done)}).get('applied'), flush=True)
        done.clear()

def _mc(fn, pk, frac):
    src = presign(fn)
    p = sh(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], 120)
    dur = float((p.stdout.strip() or '0').split()[0])
    if dur < 45: raise RuntimeError('bad duration %r | ffprobe: %s' % (p.stdout.strip(), p.stderr.strip()[-300:]))
    start = int(dur * frac)
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, 'c.mp4')
        r = sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(start), '-i', src, '-t', '30',
                '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=-2:480', '-c:v', 'libx264', '-preset', 'veryfast',
                '-crf', '28', '-maxrate', '1000k', '-bufsize', '2000k', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-movflags', '+faststart', out], 300)
        if r.returncode or not os.path.exists(out): raise RuntimeError('ffmpeg: ' + r.stderr[-200:])
        sz = os.path.getsize(out)
        if sz < 100 * 1024: raise RuntimeError('clip too small (%d bytes) | ffmpeg: %s' % (sz, r.stderr[-200:]))
        kb = sz // 1024
        u = sh(['aws', 's3', 'cp', out, f's3://{BUCKET}/{pk}', '--endpoint-url', EP,
                '--content-type', 'video/mp4', '--only-show-errors'], 120)
        if u.returncode: raise RuntimeError('upload: ' + u.stderr[:200])
    return kb

def make_clip(fn, pk):
    h = sh(['aws', 's3api', 'head-object', '--bucket', BUCKET, '--key', fn, '--endpoint-url', EP], 60)
    print('source head:', (h.stdout or h.stderr)[:300].replace('\n', ' '), flush=True)
    last = None
    for frac in (0.28, 0.15, 0.08, 0.02):
        try:
            kb = _mc(fn, pk, frac); print('ok at frac', frac, flush=True); return kb
        except RuntimeError as e:
            last = e; print('frac', frac, 'failed:', e, flush=True)
    raise last

ONLY = os.environ.get('ONLY', '').strip()
if ONLY:
    pk = re.sub(r'\.[^./]+$', '', ONLY) + '.preview.mp4'
    print('ONLY', ONLY, '->', pk, 'KB', make_clip(ONLY, pk), flush=True)
    raise SystemExit(0)

budget = MAX
for name, todo_path, apply_path in KINDS:
    if budget <= 0: break
    try:
        todo = api(todo_path)
    except Exception as e:
        print(name, 'todo failed:', e, flush=True); continue
    items = todo['items']; random.shuffle(items); items = items[:budget]
    budget -= len(items)
    print(todo['count'], name, 'need a clip; doing', len(items), flush=True)
    done = {}
    for i, it in enumerate(items, 1):
        fn = it['fileName']; pk = re.sub(r'\.[^./]+$', '', fn) + '.preview.mp4'
        try:
            kb = make_clip(fn, pk)
            done[it['key']] = pk
            print(f'{name} {i}/{len(items)} ok {fn} ({kb} KB)', flush=True)
        except Exception as e:
            print(f'{name} {i}/{len(items)} FAIL {fn}: {e}', flush=True)
        if len(done) >= 10: flush(apply_path, done)
    flush(apply_path, done)
