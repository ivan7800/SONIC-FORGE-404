"""Diagnóstico local de solo lectura para SONIC FORGE 404. Python stdlib."""
import argparse
import importlib.util
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent

def command(args, timeout=8):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False, encoding='utf-8', errors='replace')
        return {'ok': p.returncode == 0, 'code': p.returncode, 'output': (p.stdout or p.stderr).strip()[:1200]}
    except (OSError, subprocess.TimeoutExpired) as e:
        return {'ok': False, 'error': type(e).__name__}

def probe_url(url):
    try:
        req = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': 'SonicForge-Diagnostic/1'})
        with urllib.request.urlopen(req, timeout=3) as response:
            sample = response.read(4096)
            return {'reachable': True, 'http_status': response.status, 'content_type': response.headers.get('Content-Type', ''), 'json': sample.lstrip().startswith((b'{', b'['))}
    except urllib.error.HTTPError as exc:
        return {'reachable': True, 'http_status': exc.code, 'error': 'HTTP error'}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        return {'reachable': False, 'error': type(exc).__name__}

def scan():
    report = {'version': '0.22.0', 'timestamp_utc': datetime.now(timezone.utc).isoformat(),
              'platform': {'system': platform.system(), 'release': platform.release(), 'architecture': platform.machine(), 'python': sys.version.split()[0], 'python_executable': sys.executable},
              'tools': {}, 'python_packages': {}, 'gpu': {}, 'services': {}, 'project': {}, 'recommendations': []}
    for program in ('python', 'py', 'ffmpeg', 'ffprobe', 'nvidia-smi'):
        found = shutil.which(program)
        report['tools'][program] = {'found': bool(found), 'path': found}
    if report['tools']['ffmpeg']['found']:
        report['tools']['ffmpeg']['version'] = command([report['tools']['ffmpeg']['path'], '-version'])
    if report['tools']['ffprobe']['found']:
        report['tools']['ffprobe']['version'] = command([report['tools']['ffprobe']['path'], '-version'])
    for module in ('torch', 'demucs', 'torchaudio'):
        try:
            report['python_packages'][module] = {'available': importlib.util.find_spec(module) is not None}
        except (ModuleNotFoundError, ValueError):
            report['python_packages'][module] = {'available': False}
    if report['tools']['nvidia-smi']['found']:
        report['gpu']['nvidia'] = command([report['tools']['nvidia-smi']['path'], '--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'])
    else:
        report['gpu']['nvidia'] = {'ok': False, 'error': 'nvidia-smi no disponible'}
    if platform.system() == 'Windows':
        ps = shutil.which('powershell.exe') or shutil.which('powershell')
        if ps:
            report['gpu']['windows_adapters'] = command([ps, '-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'], timeout=10)
    report['services']['sonic_bridge'] = probe_url('http://127.0.0.1:8765/api/hardware')
    report['services']['ace_step'] = probe_url('http://127.0.0.1:8001/health')
    report['project'] = {f: (ROOT / f).is_file() for f in ('index.html', 'app.js', 'ai.js', 'stems.js', 'recovery.js', 'ai_bridge.py')}
    hints = report['recommendations']
    if platform.system() != 'Windows': hints.append('Diagnóstico ejecutado fuera de Windows: la verificación Windows queda pendiente.')
    if sys.version_info < (3, 10): hints.append('Actualizar Python a una versión compatible con las dependencias de IA elegidas.')
    if not report['tools']['ffmpeg']['found']: hints.append('FFmpeg no está disponible en PATH; instalarlo para conversiones de audio que lo requieran.')
    if not report['python_packages']['demucs']['available']: hints.append('Demucs no está instalado en ESTE intérprete de Python; verificar el entorno virtual usado por el servidor.')
    if not report['services']['sonic_bridge']['reachable']: hints.append('El puente Sonic no responde: ejecutar INICIAR-SONIC.bat.')
    if not report['services']['ace_step']['reachable']: hints.append('ACE-Step no responde en 127.0.0.1:8001; instalarlo y ejecutarlo por separado si se requiere generación.')
    if not report['gpu']['nvidia'].get('ok'): hints.append('No se ha verificado GPU NVIDIA mediante nvidia-smi; no implica ausencia de GPU ni incompatibilidad.')
    if not all(report['project'].values()): hints.append('Faltan archivos del estudio; volver a extraer el ZIP completo.')
    return report

def render_txt(data):
    lines = ['SONIC FORGE 404 — DIAGNÓSTICO v0.22.0', '=' * 52,
             'Fecha UTC: ' + data['timestamp_utc'],
             'Sistema: {system} {release} ({architecture})'.format(**data['platform']),
             'Python: ' + data['platform']['python'], '', 'HERRAMIENTAS']
    for name, obj in data['tools'].items(): lines.append('  {}: {}'.format(name, 'Detectada' if obj['found'] else 'No detectada'))
    lines.extend(['', 'PAQUETES PYTHON'])
    for name, obj in data['python_packages'].items(): lines.append('  {}: {}'.format(name, 'Disponible' if obj['available'] else 'No disponible'))
    lines.extend(['', 'GPU NVIDIA: ' + ('Detectada' if data['gpu']['nvidia'].get('ok') else 'No comprobada')])
    if data['gpu']['nvidia'].get('ok'): lines.append('  ' + data['gpu']['nvidia'].get('output', ''))
    for name, obj in data['services'].items(): lines.append('Servicio {}: {} (HTTP {})'.format(name, 'Conectado' if obj['reachable'] else 'Sin conexión', obj.get('http_status', '—')))
    lines.extend(['', 'RECOMENDACIONES'])
    lines.extend('  - ' + x for x in data['recommendations'])
    if not data['recommendations']: lines.append('  Sin observaciones automáticas.')
    lines.extend(['', 'IMPORTANTE: Solo se han comprobado herramientas y conectividad; NO se ha generado ni separado música.'])
    return '\n'.join(lines) + '\n'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='diagnostico', help='Carpeta para los informes')
    opts = parser.parse_args()
    folder = pathlib.Path(opts.output).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    report = scan()
    (folder / 'SONIC_DIAGNOSTICO.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    (folder / 'SONIC_DIAGNOSTICO.txt').write_text(render_txt(report), encoding='utf-8')
    print(render_txt(report))
    print('Informes:', folder)
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
