"""Pruebas de contrato sin pesos IA ni GPU. Mock de ACE-Step, servidor puente real."""
import http.client
import io
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

class MockACE(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def respond(self, data, code=200):
        buf=json.dumps(data).encode()
        self.send_response(code); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(buf))); self.end_headers(); self.wfile.write(buf)
    def do_GET(self):
        if self.path == '/health': return self.respond({'status':'ok'})
        if self.path.startswith('/v1/audio?'):
            data=io.BytesIO()
            with wave.open(data,'wb') as wav:
                wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(8000);wav.writeframes(b'\x00\x00'*400)
            raw=data.getvalue()
            self.send_response(200);self.send_header('Content-Type','audio/wav');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw);return
        self.respond({'error':'unknown'},404)
    def do_POST(self):
        n=int(self.headers.get('Content-Length',0));data=json.loads(self.rfile.read(n))
        if self.path=='/release_task':
            assert 'prompt' in data and 'audio_duration' in data
            return self.respond({'data':{'task_id':'a'*32}})
        if self.path=='/query_result':
            assert data.get('task_id_list')==['a'*32]
            return self.respond({'data':[{'status':1,'result':json.dumps([{'file':'/v1/audio?path=mock.wav'}])}]})
        self.respond({'error':'unknown'},404)

class Integration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mock=ThreadingHTTPServer(('127.0.0.1',port()),MockACE)
        cls.thread=threading.Thread(target=cls.mock.serve_forever,daemon=True);cls.thread.start()
        cls.port=port()
        cls.proc=subprocess.Popen([sys.executable,'-B',str(ROOT/'ai_bridge.py')],cwd=ROOT,env={**os.environ,'SONIC_PORT':str(cls.port),'SONIC_ACE_URL':f'http://127.0.0.1:{cls.mock.server_port}'},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                if cls.request('/api/status')[0]==200: return
            except OSError: time.sleep(.05)
        raise RuntimeError('El puente no arrancó')
    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate();cls.proc.wait(timeout=5);cls.mock.shutdown();cls.mock.server_close()
    @classmethod
    def request(cls,path,method='GET',data=None,headers=None):
        conn=http.client.HTTPConnection('127.0.0.1',cls.port,timeout=10)
        conn.request(method,path,body=data,headers={'Host':f'127.0.0.1:{cls.port}',**(headers or {})})
        response=conn.getresponse();out=(response.status,response.read());conn.close();return out
    def test_health(self):
        status,body=self.request('/api/status');self.assertEqual(status,200);self.assertTrue(json.loads(body)['ace'])
    def test_generate_task_audio(self):
        payload=json.dumps({'prompt':'A driving deep house track','bpm':124,'duration':30}).encode()
        status,body=self.request('/api/generate','POST',payload,{'Content-Type':'application/json'})
        self.assertEqual(status,200);task=json.loads(body)['data']['task_id']
        status,body=self.request('/api/task','POST',json.dumps({'task_id':task}).encode(),{'Content-Type':'application/json'})
        self.assertEqual(status,200);self.assertEqual(json.loads(body)['data'][0]['status'],1)
        status,body=self.request('/api/audio?path=mock.wav');self.assertEqual(status,200);self.assertTrue(body.startswith(b'RIFF'))
    def test_stems_bad_wav(self):
        status,body=self.request('/api/stems/start','POST',b'notawav',{'Content-Type':'audio/wav'})
        self.assertEqual(status,400)
    def test_denies_foreign_origin(self):
        status,_=self.request('/api/generate','POST',b'{}',{'Origin':'https://example.org'})
        self.assertEqual(status,403)

if __name__=='__main__':unittest.main(verbosity=2)
