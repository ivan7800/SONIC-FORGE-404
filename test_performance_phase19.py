"""Browser regressions for phase 19 memory and concurrent render limits."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page()
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_content((ROOT/'index.html').read_text(encoding='utf-8'))
    for name in ('app.js','ai.js','stems.js'):
        page.add_script_tag(content=(ROOT/name).read_text(encoding='utf-8'))
    result=page.evaluate('''async()=>{
      const original=audioClips.slice(), oldSelection=selectedClipId;
      const fake={length:48000*60,numberOfChannels:2,duration:60,sampleRate:48000};
      audioClips=[...Array(12)].map((_,i)=>({id:i+1,clip:{buffer:fake,name:'duplicate-'+i},track:{}}));
      const sharedBytes=decodedAudioBytes();
      const newFake={length:48000*60,numberOfChannels:2,duration:60,sampleRate:48000};
      const distinctBytes=decodedAudioBytes(newFake);
      audioClips=original;selectedClipId=oldSelection;
      document.querySelector('#bars').value='16';
      let secondError='';
      const first=renderOffline();
      // Simultaneous attempts must not start two expensive offline contexts.
      try{await renderOffline()}catch(e){secondError=e.message}
      const wav=await first;
      let invalidRejected=false;
      document.querySelector('#bars').value='999';
      try{await renderOffline()}catch(e){invalidRejected=/inválida/.test(e.message)}
      return {sharedBytes,distinctBytes,secondError,invalidRejected,
        frameCount:wav.audio.length,sampleRate:wav.audio.sampleRate,
        renderSlots:activeOfflineRenders};
    }''')
    print('FASE 19:',result)
    assert result['sharedBytes']==48000*60*2*4
    assert result['distinctBytes']==2*result['sharedBytes']
    assert 'en curso' in result['secondError'], result
    assert result['invalidRejected']
    assert result['frameCount']>1_000_000
    assert result['renderSlots']==0
    assert not errors,errors
    browser.close()
print('PASS: 16-bar render, shared decoded memory, concurrent render rejection, invalid duration, zero page errors')
