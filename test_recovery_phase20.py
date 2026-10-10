"""Prueba reproducible: origen HTTPS simulado sin red, almacenamiento y recuperación."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent
errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=browser.new_page()
 page.on('pageerror', lambda err: errors.append(str(err)))
 def handler(route):
  name=route.request.url.split('sonic.test/',1)[-1].split('?',1)[0] or 'index.html'
  if name in {'index.html','app.js','ai.js','stems.js','styles.css','recovery.js'}:
   mime='text/html' if name.endswith('.html') else 'text/css' if name.endswith('.css') else 'application/javascript'
   route.fulfill(status=200,body=(ROOT/name).read_bytes(),content_type=mime)
  else: route.fulfill(status=404,body='not found')
 # The environment blocks navigations. Simulate persistent storage on two fresh documents.
 store={}
 def boot(pg):
  pg.set_content((ROOT/'index.html').read_text(encoding='utf-8'))
  pg.evaluate("""() => {window.__saved = {}; Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>window.__saved[k]??null,setItem:(k,v)=>window.__saved[k]=v,removeItem:k=>delete window.__saved[k]}})}""")
  for name in ['app.js','ai.js','stems.js','recovery.js']:
   pg.add_script_tag(content=(ROOT/name).read_text(encoding='utf-8'))
 boot(page)
 page.locator('#bpm').fill('137');page.locator('#bpm').dispatch_event('change')
 page.wait_for_timeout(2200)
 assert page.locator('#recoveryRestore').is_enabled(),'Autosave no disponible'
 raw=page.evaluate("localStorage.getItem('sonic-forge-404-autorecovery-v1')")
 assert raw and '137' in raw
 second=browser.new_page();second.on('pageerror',lambda err:errors.append(str(err)))
 second.set_content((ROOT/'index.html').read_text(encoding='utf-8'))
 second.evaluate("""raw => {window.__saved = {'sonic-forge-404-autorecovery-v1':raw}; Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>window.__saved[k]??null,setItem:(k,v)=>window.__saved[k]=v,removeItem:k=>delete window.__saved[k]}})}""",raw)
 for name in ['app.js','ai.js','stems.js','recovery.js']:
  second.add_script_tag(content=(ROOT/name).read_text(encoding='utf-8'))
 assert second.locator('#recoveryRestore').is_enabled(),'No se detectó copia tras nuevo documento'
 second.locator('#recoveryRestore').click()
 assert second.locator('#bpm').input_value()=='137','No se recuperó BPM'
 second.locator('#recoveryDiscard').click()
 assert second.locator('#recoveryRestore').is_disabled(),'No se eliminó copia'
 assert not errors,errors
 print('RECOVERY PASS: autosave, new document, restore, discard; JS errors=0 (storage simulated)')
 browser.close()
