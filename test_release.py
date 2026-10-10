"""Pruebas HTTP reproducibles sin instalar ACE-Step ni Demucs."""
import contextlib
import http.client
import os
import socket
import subprocess
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.process = subprocess.Popen([sys.executable, '-B', str(ROOT / 'ai_bridge.py')], cwd=ROOT,
                                       env={**os.environ, 'SONIC_PORT':str(cls.port)},
                                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(80):
            try:
                conn = http.client.HTTPConnection('127.0.0.1', cls.port, timeout=1)
                conn.request('GET', '/', headers={'Host':f'localhost:{cls.port}'})
                conn.getresponse().read(); conn.close()
                return
            except OSError:
                time.sleep(.05)
        raise RuntimeError('No arrancó el servidor local')

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        try: cls.process.wait(timeout=3)
        except subprocess.TimeoutExpired: cls.process.kill()
        if cls.process.stderr: cls.process.stderr.close()

    def request(self, path, method='GET', payload=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1',self.port,timeout=3)
        h = {'Host':f'127.0.0.1:{self.port}', **(headers or {})}
        if payload is not None:
            h.setdefault('Content-Type','application/json')
        conn.request(method,path,body=payload,headers=h)
        resp=conn.getresponse(); result=(resp.status,resp.read(),dict(resp.getheaders()))
        conn.close(); return result

    def test_assets_public(self):
        for path in ('/','/index.html','/app.js','/styles.css','/ai.js','/stems.js'):
            with self.subTest(path=path):
                code, body, _ = self.request(path)
                self.assertEqual(code,200)
                self.assertTrue(body)

    def test_private_files_denied(self):
        for path in ('/ai_bridge.py','/README.md','/INICIAR-SONIC.bat',
                     '/.sonic-stem-jobs/','/test_release.py','/../ai_bridge.py','/%2e%2e/ai_bridge.py'):
            with self.subTest(path=path):
                code, _, _ = self.request(path)
                self.assertEqual(code,404)

    def test_foreign_host_denied(self):
        code,_,_ = self.request('/api/hardware',headers={'Host':'example.com'})
        self.assertEqual(code,403)

    def test_foreign_origin_denied(self):
        code,_,_ = self.request('/api/generate','POST',b'{}',{'Origin':'https://attacker.example'})
        self.assertEqual(code,403)

    def test_bad_generate_request(self):
        for content in (b'bad-json',b'{}',b'{"prompt":"abc"}',b'{"prompt":"a nice house track","bpm":201}'):
            with self.subTest(content=content):
                code,_,_=self.request('/api/generate','POST',content)
                self.assertEqual(code,400)

    def test_stems_validation(self):
        code,_,_=self.request('/api/stems/start','POST',b'abc',{'Content-Type':'audio/wav'})
        self.assertEqual(code,400)
        code,_,_=self.request('/api/stems/status?id=../../foo')
        self.assertEqual(code,400)
        code,_,_=self.request('/api/stems/file?id=' + '0'*32 + '&stem=bass')
        self.assertEqual(code,404)

    def test_unknown_endpoint(self):
        code,_,_=self.request('/api/not-found')
        self.assertEqual(code,404)

    def test_local_hardware(self):
        code,body,headers=self.request('/api/hardware')
        self.assertEqual(code,200)
        self.assertIn(b'"python"',body)
        self.assertEqual(headers.get('X-Content-Type-Options'),'nosniff')

if __name__ == '__main__':
    unittest.main(verbosity=2)
