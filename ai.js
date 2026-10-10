'use strict';
(() => {
  const el = id => document.getElementById(id);
  const status = (s) => { el('aiStatus').textContent = s; };
  const isLocalBridge = location.hostname === '127.0.0.1' && location.port === '8765' || location.hostname === 'localhost' && location.port === '8765';
  async function api(path, data) {
    const response = await fetch(path, data ? { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) } : {});
    const json = await response.json();
    if (!response.ok || json.error || (json.code !== undefined && json.code !== 200)) throw Error(json.error || json.detail || `HTTP ${response.status}`);
    return json;
  }
  function audioFromResult(result) {
    const output = typeof result === 'string' ? JSON.parse(result) : result;
    const candidate = Array.isArray(output) ? output.find(x => x && typeof x.file === 'string') : output;
    const file = candidate?.file;
    if (!file || !file.startsWith('/v1/audio?')) throw Error('ACE-Step no ha devuelto una URL de audio válida');
    const parsed = new URL(file, 'http://127.0.0.1:8001');
    const path = parsed.searchParams.get('path');
    if (!path) throw Error('ACE-Step no ha devuelto la ruta del audio');
    return '/api/audio?path=' + encodeURIComponent(path);
  }
  async function check() {
    if (!isLocalBridge) { status('Modo web: inicia INICIAR-SONIC.bat para activar IA local.'); return; }
    try {
      const [hardware, server] = await Promise.all([api('/api/hardware'), api('/api/status')]);
      el('gpu').textContent = hardware.gpus.length ? hardware.gpus.join('; ') : 'Sin GPU identificada';
      status(server.ace ? 'ACE-Step conectado. Puedes generar canciones.' : 'Puente activo, pero ACE-Step no está iniciado en el puerto 8001.');
    } catch(e) { status('Conexión: ' + e.message); }
  }
  let running = false;
  const button = el('aiGenerate');
  button.addEventListener('click', async () => {
    if (running) return;
    if (!isLocalBridge) { status('Abre el estudio con INICIAR-SONIC.bat para generar audio con IA.'); return; }
    running = true; button.disabled = true;
    el('aiAudio').hidden = true; el('aiDownload').hidden = true;el('aiToMix').hidden=true;
    try {
      status('Enviando canción a ACE-Step…');
      const created = await api('/api/generate', {prompt:el('aiPrompt').value.trim(), bpm:Number(el('bpm').value),duration:Number(el('aiDuration').value),instrumental:el('aiInstrumental').checked});
      const taskId = created.data?.task_id || created.data?.taskId || created.task_id;
      if (!taskId) throw Error('El servidor no ha devuelto un identificador de tarea');
      let complete = false;
      for (let i=0; i<240; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const poll = await api('/api/task',{task_id:taskId});
        const task = Array.isArray(poll.data) ? poll.data[0] : poll.data;
        if (!task) throw Error('No hay información sobre la tarea');
        if (Number(task.status) === 2) throw Error('El motor de IA ha marcado la generación como fallida');
        if (Number(task.status) === 1) {
          const url = audioFromResult(task.result);
          el('aiAudio').src = url;
          el('aiAudio').hidden = false;
          el('aiDownload').href = url;
          el('aiDownload').hidden = false;
          status('¡Canción generada! Puedes escucharla, descargarla o enviarla a la mezcla.');
          el('aiToMix').hidden=false;el('aiToMix').dataset.url=url;
          complete = true;
          break;
        }
        status(`Generando audio… comprobación ${i + 1}. Puedes seguir editando el secuenciador.`);
      }
      if (!complete) throw Error('Tiempo de espera agotado; comprueba el proceso en ACE-Step.');
    } catch (e) { status('Error: '+e.message); }
    finally { running = false; button.disabled = false; }
  });
  el('aiToMix').addEventListener('click',async()=>{const btn=el('aiToMix');btn.disabled=true;try{await window.sonicImportAudio(btn.dataset.url,'ACE-Step-generado.wav');status('Audio generado importado en la pista IA del mezclador.')}catch(e){status('No se pudo importar: '+e.message)}finally{btn.disabled=false}});
  el('aiCheck').addEventListener('click',check);
  check();
})();
