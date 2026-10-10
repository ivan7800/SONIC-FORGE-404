"""Pruebas ligeras de interfaz con carga en memoria (sin conexión ACE-Step)."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent
errors=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(accept_downloads=True)
    page.on('pageerror',lambda err:errors.append(str(err)))
    page.set_content((ROOT/'index.html').read_text(encoding='utf-8'),wait_until='domcontentloaded')
    for script in ['app.js','ai.js','stems.js']:
        page.add_script_tag(content=(ROOT/script).read_text(encoding='utf-8'))
    checks={}
    for ident in ['random','compose','arrange','remixBuild','remixUndo','master_preset','resetMix','reset','play','stop']:
        try:
            if ident=='master_preset': page.locator('#master_preset').select_option('techno')
            else: page.locator('#'+ident).click(timeout=4000)
            checks[ident]='OK'
        except Exception as exc: checks[ident]='FAIL '+str(exc)[:140]
    print('CHECKS',checks)
    print('JS_ERRORS',errors[:8])
    browser.close()
    if errors or any(x!='OK' for x in checks.values()): raise SystemExit(1)
