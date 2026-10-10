(() => {
'use strict';
const $ = id => document.getElementById(id);
const status = message => { $('stemStatus').textContent = message; };
const names = ['vocals','drums','bass','other'];
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost):8765$/.test(location.origin);
let activeId = null, running = false;
function url(name) { return '/api/stems/file?id=' + encodeURIComponent(activeId) + '&stem=' + encodeURIComponent(name); }
async function run() {
 if(running) return;
 if(!isLocal) { status('Ejecuta INICIAR-SONIC.bat y abre http://127.0.0.1:8765'); return; }
 const file = $('stemInput').files?.[0];
 if(!file || !/\.wav$/i.test(file.name) || file.size > 80*1024*1024) { status('Selecciona un WAV de hasta 80 MB'); return; }
 running = true; $('stemRun').disabled=true; $('stemLoad').disabled=true;
 $('stemResults').replaceChildren();
 try {
  status('Enviando WAV al servidor local…');
  const uploaded=await fetch('/api/stems/start',{method:'POST',headers:{'Content-Type':'audio/wav'},body:file});
  const body=await uploaded.json(); if(!uploaded.ok) throw Error(body.error || 'Carga fallida');
  activeId=body.id;
  for(let i=0;i<360;i++) {
   await new Promise(resolve=>setTimeout(resolve,5000));
   const response=await fetch('/api/stems/status?id='+encodeURIComponent(activeId));
   const state=await response.json(); if(!response.ok) throw Error(state.error || 'Estado no disponible');
   if(state.state==='error') throw Error(state.error);
   if(state.state==='done') {
    status('Separación terminada. Puedes descargar o importar los cuatro stems.');
    $('stemLoad').disabled=false;
    for(const name of names){const anchor=document.createElement('a');anchor.href=url(name);anchor.textContent='↓ '+name.toUpperCase()+'.wav';anchor.download=name+'.wav';$('stemResults').append(anchor)}
    return;
   }
   status('Separando audio en Python… '+(i+1)*5+' segundos. La duración depende del equipo.');
  }
  throw Error('Tiempo de espera agotado; comprueba el proceso local.');
 } catch(error) { status('Error: '+error.message); }
 finally {running=false;$('stemRun').disabled=false;}
}
async function load() {
 $('stemLoad').disabled=true;
 try {
  for(const name of names) {
   status('Importando '+name+' a la línea de tiempo…');
   await window.sonicImportAudio(url(name),'demucs-'+name+'.wav');
  }
  status('Cuatro stems importados como clips independientes; selecciona cada uno para mezclar.');
 } catch(error) { status('Importación incompleta: '+error.message); }
 finally {$('stemLoad').disabled=false;}
}
$('stemRun').addEventListener('click',run);
$('stemLoad').addEventListener('click',load);
})();
