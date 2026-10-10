'use strict';
// Fase 20 — recuperación explícita, sin subir datos fuera del dispositivo.
(()=>{
 const KEY='sonic-forge-404-autorecovery-v1';
 const indicator=document.getElementById('recoveryStatus');
 const restore=document.getElementById('recoveryRestore');
 const discard=document.getElementById('recoveryDiscard');
 const $notice=t=>{indicator.textContent=t;};
 let debounce=null, lastSnapshot='';
 function getStored(){try{const raw=localStorage.getItem(KEY);if(!raw)return null;const obj=JSON.parse(raw);if(!obj||typeof obj.savedAt!=='number'||!obj.data)return null;return obj;}catch{return null;}}
 function refresh(){const s=getStored();restore.disabled=!s;discard.disabled=!s;if(s) $notice('Recuperación disponible: '+new Date(s.savedAt).toLocaleString()+'. El audio importado debe cargarse de nuevo.');else $notice('Sin copia de recuperación. Se guardan solo ajustes, patrones y metadatos, nunca archivos de audio.');}
 function snapshot(){try{if(typeof project!=='function')return;const data=project();const serialized=JSON.stringify(data);if(serialized===lastSnapshot)return;localStorage.setItem(KEY,JSON.stringify({savedAt:Date.now(),data}));lastSnapshot=serialized;refresh();}catch(err){$notice('No se pudo guardar recuperación: '+(err.name==='QuotaExceededError'?'espacio agotado':err.message));}}
 function schedule(){clearTimeout(debounce);debounce=setTimeout(snapshot,1800);}
 restore.addEventListener('click',()=>{const s=getStored();if(!s)return;try{apply(s.data);lastSnapshot=JSON.stringify(project());$notice('Sesión recuperada. Importa otra vez los archivos de audio para restaurar los clips.');document.getElementById('message').textContent='Copia recuperada. Los archivos de audio externos no se guardan.';}catch(err){$notice('Recuperación inválida: '+err.message);}});
 discard.addEventListener('click',()=>{try{localStorage.removeItem(KEY);lastSnapshot='';refresh();}catch(err){$notice('No se pudo descartar: '+err.message);}});
 document.addEventListener('click',e=>{if(e.target.closest('button.step, #random, #compose, #arrange, #remixBuild, #remixUndo, #remixDuplicate, #reset, #resetMix, .mixswitches button, #aiRemove, #aiResetEdit'))schedule();});
 document.addEventListener('change',e=>{if(e.target.matches('input,select'))schedule();});
 document.addEventListener('input',e=>{if(e.target.matches('input:not([type=file]),select'))schedule();});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){clearTimeout(debounce);snapshot();}});
 window.addEventListener('pagehide',snapshot);
 refresh();
})();
