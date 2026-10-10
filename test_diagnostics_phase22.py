"""Pruebas stdlib para el detector de fase 22."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import diagnostico_windows as d

class DiagnosticsTests(unittest.TestCase):
    def test_real_scan_schema(self):
        r = d.scan()
        self.assertEqual(r['version'], '0.22.0')
        self.assertIn('ffmpeg', r['tools'])
        self.assertIn('demucs', r['python_packages'])
        self.assertIn('ace_step', r['services'])
        self.assertTrue(r['project']['index.html'])
        json.dumps(r)
    def test_offline(self):
        with patch('diagnostico_windows.urllib.request.urlopen', side_effect=OSError('offline')):
            self.assertFalse(d.probe_url('http://127.0.0.1:8001/health')['reachable'])
    def test_service_mock(self):
        class Resp:
            status = 200
            headers = {'Content-Type': 'application/json'}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, n): return b'{"status":"ok"}'
        with patch('diagnostico_windows.urllib.request.urlopen', return_value=Resp()):
            self.assertTrue(d.probe_url('http://127.0.0.1:8001/health')['json'])
    def test_report_text(self):
        self.assertIn('NO se ha generado', d.render_txt(d.scan()))
    def test_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch('sys.argv', ['diagnostico_windows.py', '--output', tmp]):
                self.assertEqual(d.main(), 0)
            self.assertIn('services', json.loads((Path(tmp)/'SONIC_DIAGNOSTICO.json').read_text(encoding='utf-8')))
            self.assertTrue((Path(tmp)/'SONIC_DIAGNOSTICO.txt').exists())

if __name__ == '__main__': unittest.main(verbosity=2)
