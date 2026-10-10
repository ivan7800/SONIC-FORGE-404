"""Phase 21: every browser asset must be served; private files must remain blocked."""
import unittest, urllib.request, urllib.error, threading, re
from http.server import ThreadingHTTPServer
from pathlib import Path
from ai_bridge import Handler, ROOT

class PublicationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown(); cls.httpd.server_close(); cls.thread.join(timeout=3)
    def fetch(self, path):
        url = 'http://127.0.0.1:%d%s' % (self.httpd.server_address[1],path)
        return urllib.request.urlopen(urllib.request.Request(url,headers={'Host':'127.0.0.1'}),timeout=5)
    def test_browser_scripts_styles(self):
        html = self.fetch('/').read().decode('utf-8')
        assets = re.findall(r'<script[^>]+src="([^"]+)"',html)+re.findall(r'<link[^>]+href="([^"]+)"',html)
        self.assertGreaterEqual(len(assets),5)
        for asset in assets:
            with self.subTest(asset=asset):
                with self.fetch('/'+asset) as resp:
                    self.assertEqual(resp.status,200)
                    self.assertEqual(resp.read(),(ROOT/asset).read_bytes())
    def test_private_files(self):
        for path in ('/ai_bridge.py','/README.md','/test_release.py','/.gitignore','/.sonic-stem-jobs/private.wav'):
            with self.subTest(path=path):
                with self.assertRaises(urllib.error.HTTPError) as err: self.fetch(path)
                self.assertEqual(err.exception.code,404)
if __name__ == '__main__': unittest.main(verbosity=2)
