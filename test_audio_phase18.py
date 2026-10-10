"""Phase 18: real Web Audio browser render regressions, without neural models."""
import math
import struct
import wave
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent


def main():
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / 'qa_stereo_tone.wav'
        with wave.open(str(source), 'wb') as wav:
            wav.setnchannels(2)
            wav.setsampwidth(2)
            wav.setframerate(22050)
            frames = bytearray()
            for i in range(22050 * 2):
                value = int(15000 * math.sin(2 * math.pi * 220 * i / 22050))
                frames.extend(struct.pack('<hh', value, value))
            wav.writeframes(frames)
        errors = []
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
            page = browser.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.set_content((ROOT / 'index.html').read_text(encoding='utf-8'))
            for name in ('app.js', 'ai.js', 'stems.js'):
                page.add_script_tag(content=(ROOT / name).read_text(encoding='utf-8'))
            page.locator('#bars').select_option('4')
            page.locator('#aiImportFile').set_input_files(str(source))
            page.wait_for_timeout(1400)
            print('IMPORT_DEBUG', page.locator('#message').inner_text(), page.locator('#clipCount').inner_text(), errors)
            page.wait_for_function('document.querySelector("#clipCount").textContent.includes("1 / 12")', timeout=3000)
            # The short clip plus large fades exercises event ordering.
            page.locator('#aiFadeIn').fill('1.8')
            page.locator('#aiFadeIn').dispatch_event('change')
            page.locator('#aiFadeOut').fill('1.8')
            page.locator('#aiFadeOut').dispatch_event('change')
            result = page.evaluate('''async () => {
              const full = (await renderOffline()).audio;
              const isolated = (await renderOffline('KICK')).audio;
              const peak=(b)=>Math.max(...Array.from({length:b.numberOfChannels},(_,c)=>{
                const d=b.getChannelData(c); let m=0; for(let i=0;i<d.length;i++)m=Math.max(m,Math.abs(d[i])); return m;
              }));
              return {masterLength:full.length,stemLength:isolated.length,
                masterRate:full.sampleRate,stemRate:isolated.sampleRate,
                masterPeak:peak(full),stemPeak:peak(isolated),
                clipCount:audioClips.length};
            }''')
            print('AUDIO QA:', result)
            assert result['clipCount'] == 1
            assert result['masterLength'] == result['stemLength']
            assert result['masterRate'] == result['stemRate'] == 44100
            assert 0 < result['masterPeak'] < 3
            assert 0 < result['stemPeak'] < 3
            assert not errors, errors
            browser.close()
    print('PASS: imported WAV, overlapping fades, offline master/stem alignment, finite output, JS console')

if __name__ == '__main__':
    main()
