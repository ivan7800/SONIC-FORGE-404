"""Local-only bridge from Sonic Forge web UI to ACE-Step 1.5 REST API.
Dependencies: Python standard library. Does not load neural model itself.
"""
import json
import threading
import uuid
import sys
import time
import re
import os
import pathlib
import platform
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent
HOST = '127.0.0.1'
PORT = int(os.getenv('SONIC_PORT', '8765'))
ACE_URL = os.getenv('SONIC_ACE_URL', 'http://127.0.0.1:8001').rstrip('/')
MAX_BODY = 20000
STEM_LIMIT = 80 * 1024 * 1024
STEM_ROOT = ROOT / ".sonic-stem-jobs"
STEM_JOBS = {}
STEM_LOCK = threading.Lock()
STEM_ORDER = ["vocals", "drums", "bass", "other"]

def run_stem_job(job_id):
    job = STEM_JOBS[job_id]
    try:
        command = [sys.executable, "-m", "demucs", "-n", "htdemucs", "--out", str(STEM_ROOT / job_id / "output"), str(STEM_ROOT / job_id / "input.wav")]
        with open(STEM_ROOT / job_id / "process.log", "wb") as log:
            proc = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=3600, check=False, cwd=str(ROOT))
        if proc.returncode != 0: raise RuntimeError("Demucs terminó con código " + str(proc.returncode) + ". Revisa process.log en la carpeta del trabajo.")
        result = STEM_ROOT / job_id / "output" / "htdemucs" / "input"
        if not all((result / (stem + ".wav")).is_file() for stem in STEM_ORDER): raise RuntimeError("No se encontraron los cuatro stems esperados")
        with STEM_LOCK: job["state"] = "done"
    except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
        with STEM_LOCK: job.update(state="error", error=str(exc)[:400])

def validate_job(job_id):
    if not re.fullmatch(r"[0-9a-f]{32}", job_id): raise ValueError("Identificador no válido")
    return STEM_JOBS.get(job_id)



def gpu_report():
    result = {'system': platform.platform(), 'python': platform.python_version(), 'gpus': [], 'nvidia_smi': False}
    tool = shutil.which('nvidia-smi')
    if tool:
        try:
            p = subprocess.run([tool, '--query-gpu=name,memory.total', '--format=csv,noheader'], capture_output=True, text=True, timeout=6, check=False)
            if p.returncode == 0:
                result['nvidia_smi'] = True
                result['gpus'] += [x.strip() for x in p.stdout.splitlines() if x.strip()]
        except (OSError, subprocess.TimeoutExpired):
            pass
    if platform.system() == 'Windows':
        ps = shutil.which('powershell') or shutil.which('powershell.exe')
        if ps and not result['gpus']:
            try:
                cmd = [ps, '-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join "; "']
                p = subprocess.run(cmd, capture_output=True, text=True, timeout=8, check=False)
                if p.returncode == 0 and p.stdout.strip(): result['gpus'] = [p.stdout.strip()]
            except (OSError, subprocess.TimeoutExpired):
                pass
    return result


def ace_request(method, endpoint, payload=None):
    headers = {'Accept': 'application/json'}
    key = os.getenv('ACESTEP_API_KEY', '')
    if key: headers['Authorization'] = 'Bearer ' + key
    raw = None
    if payload is not None:
        raw = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(ACE_URL + endpoint, data=raw, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, obj, status=200):
        raw = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(raw)

    def safe_api(self, method):
        try:
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path == '/api/stems/status' and method == 'GET':
                job_id = urllib.parse.parse_qs(parsed.query).get('id', [''])[0]
                job = validate_job(job_id)
                if not job: self.send_json({'error':'Trabajo no encontrado'},404); return True
                self.send_json({k:job[k] for k in ('state','error')}); return True
            if parsed.path == '/api/stems/file' and method == 'GET':
                q = urllib.parse.parse_qs(parsed.query)
                job_id = q.get('id',[''])[0]; stem = q.get('stem',[''])[0]
                job = validate_job(job_id)
                if not job or job['state'] != 'done' or stem not in STEM_ORDER:
                    self.send_json({'error':'Stem no disponible'},404); return True
                path = STEM_ROOT / job_id / 'output' / 'htdemucs' / 'input' / (stem + '.wav')
                if not path.is_file():
                    self.send_json({'error':'El stem solicitado no está disponible'},404); return True
                self.send_response(200)
                self.send_header('Content-Type','audio/wav')
                self.send_header('Content-Length',str(path.stat().st_size))
                self.send_header('Content-Disposition','attachment; filename="'+stem+'.wav"')
                self.send_header('Cache-Control','no-store')
                self.send_header('X-Content-Type-Options','nosniff')
                self.end_headers()
                with path.open('rb') as reader:
                    shutil.copyfileobj(reader,self.wfile,64*1024)
                return True
            if parsed.path == '/api/hardware'  and method == 'GET':
                self.send_json(gpu_report()); return True
            if parsed.path == '/api/status' and method == 'GET':
                try:
                    data = ace_request('GET', '/health')
                    self.send_json({'bridge': True, 'ace': True, 'details': data})
                except (urllib.error.URLError, TimeoutError, OSError, ValueError):
                    self.send_json({'bridge': True, 'ace': False})
                return True
            if parsed.path == '/api/audio' and method == 'GET':
                params = urllib.parse.parse_qs(parsed.query)
                path = params.get('path', [''])[0]
                # ACE's own audio URLs are /v1/audio?path=...; do not allow arbitrary proxy destinations.
                if not path or len(path) > 1500: raise ValueError('Ruta de audio inválida')
                remote = ACE_URL + '/v1/audio?' + urllib.parse.urlencode({'path': path})
                headers = {}
                if os.getenv('ACESTEP_API_KEY'): headers['Authorization'] = 'Bearer ' + os.environ['ACESTEP_API_KEY']
                with urllib.request.urlopen(urllib.request.Request(remote, headers=headers), timeout=120) as response:
                    # Limit to 100 MiB and never buffer the whole song.
                    length = int(response.headers.get('Content-Length') or '0')
                    if length > 100 * 1024 * 1024: raise ValueError('Audio demasiado grande')
                    self.send_response(200)
                    self.send_header('Content-Type', 'audio/wav' if 'wav' in response.headers.get('Content-Type','') else 'application/octet-stream')
                    self.send_header('Content-Disposition', 'attachment; filename="sonic-forge-ai-audio.wav"')
                    self.send_header('X-Content-Type-Options', 'nosniff')
                    self.end_headers()
                    streamed = 0
                    while True:
                        chunk = response.read(65536)
                        if not chunk: break
                        streamed += len(chunk)
                        if streamed > 100 * 1024 * 1024: break
                        self.wfile.write(chunk)
                return True
            if method == 'POST' and parsed.path == '/api/stems/start':
                length = int(self.headers.get('Content-Length','-1'))
                if not 0 < length <= STEM_LIMIT: raise ValueError('Solo se admite WAV de hasta 80 MB')
                if self.headers.get('Content-Type','').split(';')[0] not in ('audio/wav','audio/x-wav','application/octet-stream'):
                    raise ValueError('Sube audio WAV sin multipart')
                with STEM_LOCK:
                    if sum(job['state']=='running' for job in STEM_JOBS.values()) >= 1:
                        self.send_json({'error':'Ya existe una separación en curso'},409); return True
                    job_id = uuid.uuid4().hex
                    STEM_JOBS[job_id] = {'state':'running','error':''}
                try:
                    dest = STEM_ROOT / job_id
                    dest.mkdir(parents=True,exist_ok=False)
                    with (dest/'input.wav').open('wb') as output:
                        remaining=length
                        while remaining:
                            chunk=self.rfile.read(min(65536,remaining))
                            if not chunk: raise ValueError('Carga incompleta')
                            output.write(chunk); remaining-=len(chunk)
                    with (dest/'input.wav').open('rb') as audio:
                        if audio.read(4)!=b'RIFF' or (audio.seek(8),audio.read(4))[1]!=b'WAVE': raise ValueError('El archivo no es WAV RIFF')
                    threading.Thread(target=run_stem_job,args=(job_id,),daemon=True).start()
                    self.send_json({'id':job_id,'state':'running'},202)
                except Exception:
                    with STEM_LOCK: STEM_JOBS.pop(job_id,None)
                    shutil.rmtree(STEM_ROOT/job_id,ignore_errors=True)
                    raise
                return True
            if method == 'POST' and parsed.path in ('/api/generate', '/api/task'):
                length = int(self.headers.get('Content-Length', '-1'))
                if length < 0 or length > MAX_BODY: raise ValueError('Tamaño de solicitud inválido')
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict): raise ValueError('Se esperaba un objeto JSON')
                if parsed.path == '/api/generate':
                    prompt = body.get('prompt', '')
                    if not isinstance(prompt, str) or not 5 <= len(prompt) <= 1500: raise ValueError('Describe la canción (5-1500 caracteres)')
                    bpm = int(body.get('bpm', 130)); duration = int(body.get('duration', 30))
                    if not 60 <= bpm <= 200 or not 10 <= duration <= 240: raise ValueError('BPM o duración fuera de rango')
                    request = {'prompt': prompt, 'bpm': bpm, 'audio_duration': duration, 'thinking': bool(body.get('thinking', False)), 'instrumental': bool(body.get('instrumental', True))}
                    result = ace_request('POST', '/release_task', request)
                else:
                    tid = body.get('task_id', '')
                    if not isinstance(tid, str) or not 1 <= len(tid) <= 128 or any(c not in '0123456789abcdefABCDEF-' for c in tid): raise ValueError('ID de tarea inválido')
                    result = ace_request('POST', '/query_result', {'task_id_list': [tid]})
                self.send_json(result); return True
            if parsed.path.startswith('/api/'):
                self.send_json({'error': 'Ruta inexistente'}, 404); return True
            return False
        except (ValueError, TypeError, json.JSONDecodeError) as e:
            self.send_json({'error': str(e)}, 400); return True
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            self.send_json({'error': 'No se puede contactar con ACE-Step en 127.0.0.1:8001', 'detail': str(e)}, 502); return True

    def translate_path(self, path):
        # Publish only the browser application assets, never local server files,
        # logs, audio jobs, saved configurations or installation scripts.
        parsed = urllib.parse.urlsplit(path).path
        if parsed == '/':
            parsed = '/index.html'
        if parsed not in ('/index.html', '/styles.css', '/app.js', '/ai.js', '/stems.js', '/recovery.js'):
            return str(ROOT / '__blocked__')
        return str(ROOT / parsed.lstrip('/'))

    def local_request(self):
        host = self.headers.get('Host', '').lower().split(':')[0]
        if host not in ('127.0.0.1', 'localhost'):
            return False
        origin = self.headers.get('Origin')
        if origin:
            parsed = urllib.parse.urlsplit(origin)
            return parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost') and parsed.port == PORT
        return True

    def do_GET(self):
        if not self.local_request():
            self.send_json({'error': 'Acceso local requerido'}, 403); return
        if self.safe_api('GET'): return
        super().do_GET()

    def do_POST(self):
        if not self.local_request():
            self.send_json({'error': 'Origen o host no permitido'}, 403); return
        if self.safe_api('POST'): return
        self.send_json({'error': 'Método no permitido'}, 405)

    def log_message(self, fmt, *args):
        print('[SONIC]', fmt % args)


if __name__ == '__main__':
    print(f'SONIC FORGE 404: http://{HOST}:{PORT} (solo equipo local)')
    print(f'ACE-Step API esperada en {ACE_URL}')
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
