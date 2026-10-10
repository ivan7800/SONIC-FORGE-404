'use strict';
const TRACKS=[['KICK','#a786ff'],['CLAP','#ff7bab'],['HAT','#5edbd2'],['OPEN','#f7ba70'],['BASS','#779bff'],['CHORD','#b3ed86']];
const $=id=>document.getElementById(id);
const defaultPatterns={KICK:[0,4,8,12],CLAP:[4,12],HAT:[2,6,10,14],OPEN:[7,15],BASS:[0,3,6,8,11,14],CHORD:[0,8]};
let pattern=Object.fromEntries(TRACKS.map(([name])=>[name,Array.from({length:16},(_,i)=>defaultPatterns[name].includes(i))]));
let ctx=null,master=null,noiseBuffer=null,timer=null,stepIndex=0,barIndex=0,nextTime=0,runId=0,activeSources=[];
const PROGRESSIONS={dark:[0,8,3,10],uplifting:[0,5,10,7],driving:[0,10,8,7],minimal:[0,0,5,3]};
let composer={progression:'dark',energy:65,variation:35,structure:['intro','groove','build','drop','break','drop','outro','groove']};
const SECTION_LABELS={intro:'INTRO',groove:'GROOVE',build:'BUILD',drop:'DROP',break:'BREAK',outro:'OUTRO'};
const MIX_DEFAULT=()=>Object.fromEntries(TRACKS.map(([n])=>[n,{level:80,pan:0,send:0,mute:false,solo:false}]));
let mixer=MIX_DEFAULT(),mixEffects={delay:0,feedback:25,masterDrive:0,autoFilter:false};
// Phase 14: processing shared by sequencer, imported clips, and offline master.
const MASTER_PRESETS={neutral:{low:0,mid:0,high:0,threshold:-14,ratio:2,ceiling:-1},house:{low:1.5,mid:-1,high:1,threshold:-18,ratio:3,ceiling:-1},techno:{low:2,mid:-1.5,high:1.8,threshold:-20,ratio:4,ceiling:-1}};
let mastering={...MASTER_PRESETS.neutral,enabled:true},liveMaster=null;
function validateMaster(m){if(!m||typeof m.enabled!=='boolean')throw Error('Master inválido');for(const [key,min,max] of [['low',-12,12],['mid',-12,12],['high',-12,12],['threshold',-36,0],['ratio',1,12],['ceiling',-12,0]])if(!Number.isFinite(m[key])||m[key]<min||m[key]>max)throw Error('Master inválido: '+key)}
function masteringBus(ac,destination,values=mastering){
 const input=ac.createGain(),low=ac.createBiquadFilter(),mid=ac.createBiquadFilter(),high=ac.createBiquadFilter(),compressor=ac.createDynamicsCompressor(),ceiling=ac.createGain();
 low.type='lowshelf';low.frequency.value=110;mid.type='peaking';mid.frequency.value=950;mid.Q.value=.8;high.type='highshelf';high.frequency.value=8500;
 low.gain.value=values.low;mid.gain.value=values.mid;high.gain.value=values.high;
 compressor.threshold.value=values.threshold;compressor.ratio.value=values.ratio;compressor.knee.value=5;compressor.attack.value=.012;compressor.release.value=.18;
 ceiling.gain.value=Math.pow(10,values.ceiling/20);
 input.connect(low).connect(mid).connect(high).connect(compressor).connect(ceiling).connect(destination);
 const bypass=ac.createGain();input.connect(bypass).connect(destination);
 // Bypass path is mutually exclusive with the processed path.
 bypass.gain.value=values.enabled?0:1;ceiling.gain.value=values.enabled?Math.pow(10,values.ceiling/20):0;
 return {input,low,mid,high,compressor,ceiling,bypass};
}
function updateLiveMaster(){if(!liveMaster||!ctx)return;const t=ctx.currentTime,m=mastering;for(const key of ['low','mid','high'])liveMaster[key].gain.setTargetAtTime(m[key],t,.025);liveMaster.compressor.threshold.setTargetAtTime(m.threshold,t,.025);liveMaster.compressor.ratio.setTargetAtTime(m.ratio,t,.025);liveMaster.ceiling.gain.setTargetAtTime(m.enabled?Math.pow(10,m.ceiling/20):0,t,.025);liveMaster.bypass.gain.setTargetAtTime(m.enabled?0:1,t,.025)}
function drawMaster(){for(const key of ['low','mid','high','threshold','ratio','ceiling']){$('master_'+key).value=mastering[key];$('master_'+key+'_value').textContent=mastering[key]}$('master_enabled').checked=mastering.enabled}
function audioMetrics(buffer){let sum=0,peak=0,count=0;for(let c=0;c<buffer.numberOfChannels;c++){const data=buffer.getChannelData(c);for(let i=0;i<data.length;i++){const v=data[i];sum+=v*v;peak=Math.max(peak,Math.abs(v));count++}}const rms=Math.sqrt(sum/Math.max(1,count));const db=x=>x>0?(20*Math.log10(x)).toFixed(1)+' dBFS':'−∞ dBFS';return {peak:db(peak),rms:db(rms),peakValue:peak}}

// Phase 7: imported AI audio lives only in memory; projects retain metadata, not audio bytes.
let audioClips=[], selectedClipId=null, clipSequence=0, pendingClips=[];
// Budget applies to distinct decoded buffers; duplicated clips share their source buffer.
const MAX_DECODED_AUDIO_BYTES=192*1024*1024;
function decodedAudioBytes(extraBuffer=null){
 const unique=new Set(audioClips.map(e=>e.clip.buffer));
 if(extraBuffer)unique.add(extraBuffer);
 let total=0;for(const b of unique)total+=b.length*b.numberOfChannels*4;
 return total;
}
let activeOfflineRenders=0;
const MAX_CONCURRENT_RENDERS=1;
let aiClip=null,aiTrack={level:75,pan:0,mute:false,startBar:0,trimStart:0,trimEnd:0,fadeIn:0,fadeOut:0,pitchSemitones:0,syncTempo:false,snap:true},aiSource=null,aiGain=null,aiPan=null;
// Phase 10: lightweight offline onset-envelope tempo estimator; heuristic, not a beat-grid guarantee.
function estimateClipBpm(buffer){
 const sr=buffer.sampleRate, hop=Math.max(128,Math.round(sr/100)), windows=Math.floor(buffer.length/hop);
 if(windows<300)return null;
 const data=buffer.getChannelData(0), env=new Float32Array(windows);
 for(let i=0;i<windows;i++){let sum=0;for(let j=i*hop;j<Math.min(data.length,(i+1)*hop);j+=4)sum+=data[j]*data[j];env[i]=Math.sqrt(sum/Math.max(1,Math.ceil(hop/4)))}
 const onset=new Float32Array(windows);let avg=0;for(let i=1;i<windows;i++){avg=avg*.96+env[i]*.04;onset[i]=Math.max(0,env[i]-Math.max(env[i-1],avg*.8))}
 const rate=sr/hop, scores=[];for(let bpm=80;bpm<=180;bpm++){const lag=Math.round(60*rate/bpm);let score=0,count=0;for(let i=lag;i<windows;i++){score+=onset[i]*onset[i-lag];count++}scores.push({bpm,score:score/Math.max(1,count)})}
 scores.sort((x,y)=>y.score-x.score);if(!scores[0]||scores[0].score<1e-9)return null;
 return {bpm:scores[0].bpm,confidence:Math.min(1,(scores[0].score/(scores[Math.min(15,scores.length-1)].score+1e-12)-1)/2)};
}
// Phase 11: WSOLA-inspired overlap/add with local correlation search.
// Offline processing is shared by live playback and WAV render. No network/codec required.
const stretchCache=new WeakMap();
function clipPlaybackRate(track){const source=Number(track.detectedBpm),target=Number($('bpm').value);return track.syncTempo&&source>=60&&source<=220&&target>=60&&target<=200?Math.max(.5,Math.min(2,target/source)):1}
function clipPitchFactor(track){return Math.pow(2,Math.max(-12,Math.min(12,Number(track.pitchSemitones)||0))/12)}
function processedClip(buffer,track,ac){
 const rate=clipPlaybackRate(track), pitch=clipPitchFactor(track);
 if(Math.abs(rate-1)<.00001&&Math.abs(pitch-1)<.00001)return {buffer,ratio:1};
 if(buffer.duration>180)throw Error('El motor de preservación de tono admite clips de hasta 180 segundos; recorta o divide el audio.');
 const key=rate.toFixed(6)+'/'+pitch.toFixed(6),prev=stretchCache.get(buffer);
 if(prev&&prev.key===key)return prev.result;
 const sr=buffer.sampleRate, channels=Math.min(2,buffer.numberOfChannels),originalLength=buffer.length;
 // Transposition by resampling: pitch affects sample frequency; WSOLA restores target duration.
 const resampledLength=Math.max(2048,Math.ceil(originalLength/pitch));
 const intermediate=[];
 for(let ch=0;ch<channels;ch++){
  const source=buffer.getChannelData(ch),target=new Float32Array(resampledLength);
  for(let i=0;i<resampledLength;i++){const at=i*pitch,lo=Math.min(source.length-1,Math.floor(at)),hi=Math.min(source.length-1,lo+1),fraction=at-lo;target[i]=source[lo]*(1-fraction)+source[hi]*fraction}
  intermediate.push(target);
 }
 const targetLength=Math.max(2048,Math.round(originalLength/rate));
 const win=2048,hop=512,search=192;
 const out=Array.from({length:channels},()=>new Float32Array(targetLength));
 const norms=new Float32Array(targetLength);
 const window=new Float32Array(win);
 for(let j=0;j<win;j++)window[j]=.5-.5*Math.cos(2*Math.PI*j/(win-1));
 const analysisStep=hop*(resampledLength/targetLength);
 let previousPosition=0;
 for(let write=0,index=0;write<targetLength;write+=hop,index++){
  const predicted=Math.max(0,Math.min(resampledLength-win,Math.round(index*analysisStep)));
  let position=predicted;
  if(index&&write+win<targetLength){
   let best=-Infinity;
   for(let shift=-search;shift<=search;shift+=8){
    const candidate=predicted+shift;
    if(candidate<0||candidate+win>=resampledLength)continue;
    let dot=0,a2=1e-8,b2=1e-8;
    const compare=intermediate[0];
    for(let t=0;t<win-hop;t+=16){const a=out[0][write+t],b=compare[candidate+t];dot+=a*b;a2+=a*a;b2+=b*b}
    const score=dot/Math.sqrt(a2*b2)-.0001*Math.abs(shift);
    if(score>best){best=score;position=candidate}
   }
  }
  previousPosition=position;
  for(let j=0;j<win&&write+j<targetLength;j++){
   const w=window[j];norms[write+j]+=w;
   for(let ch=0;ch<channels;ch++)out[ch][write+j]+=intermediate[ch][Math.min(resampledLength-1,position+j)]*w;
  }
 }
 const resultBuffer=ac.createBuffer(channels,targetLength,sr);
 for(let ch=0;ch<channels;ch++){
  const dest=resultBuffer.getChannelData(ch);for(let i=0;i<targetLength;i++)dest[i]=Math.max(-1,Math.min(1,out[ch][i]/Math.max(.0001,norms[i])))
 }
 const result={buffer:resultBuffer,ratio:targetLength/originalLength};
 stretchCache.set(buffer,{key,result});return result;
}
function refreshTempoUI(){const e=$('aiBpmResult');if(!e)return;const t=selectedEntry()?.track||aiTrack;e.textContent=t.detectedBpm?`BPM estimados: ${t.detectedBpm} · confianza orientativa ${Math.round((t.tempoConfidence||0)*100)}%`:'BPM no analizados';$('aiSyncTempo').checked=!!t.syncTempo;$('aiSnap').checked=t.snap!==false;}
function analyzeSelectedClip(){const e=selectedEntry();if(!e){msg('Importa y selecciona un clip primero.');return}const result=estimateClipBpm(e.clip.buffer);if(!result){msg('No se pudo estimar el BPM: audio demasiado corto o sin transitorios claros.');return}e.track.detectedBpm=result.bpm;e.track.tempoConfidence=result.confidence;aiTrack=e.track;refreshTempoUI();msg(`Tempo estimado: ${result.bpm} BPM. Compruébalo escuchando: la detección es aproximada.`)}
function selectedEntry(){return audioClips.find(c=>c.id===selectedClipId)||null}
function rememberSelection(){const e=selectedEntry();if(e){e.track={...aiTrack};e.clip=aiClip}}
function chooseClip(id){stop();rememberSelection();const e=audioClips.find(c=>c.id===id);if(!e)return;selectedClipId=id;aiClip=e.clip;aiTrack=e.track;syncAIControls();drawClipLane()}
function drawClipLane(){const root=$('multiClips');if(!root)return;root.replaceChildren();const bpm=Math.max(60,Number($('bpm').value)||132);for(const entry of audioClips){const row=document.createElement('div');row.className='clip-lane-item';if(entry.id===selectedClipId)row.classList.add('selected');const name=document.createElement('button');name.type='button';name.className='clip-choose';name.textContent=entry.clip.name+' · '+((entry.clip.buffer.duration-entry.track.trimStart-entry.track.trimEnd)/clipPlaybackRate(entry.track)).toFixed(1)+'s';name.addEventListener('click',()=>chooseClip(entry.id));const bar=document.createElement('div');bar.className='clip-track-bar';const tile=document.createElement('button');tile.className='clip-tile';tile.type='button';tile.style.left=(entry.track.startBar/32*100)+'%';tile.style.width=Math.max(2,Math.min(100-entry.track.startBar/32*100,(entry.clip.buffer.duration-entry.track.trimStart-entry.track.trimEnd)/clipPlaybackRate(entry.track)/(4*60/bpm)/32*100))+'%';tile.title='Seleccionar clip · compás '+(entry.track.startBar+1);tile.addEventListener('click',()=>chooseClip(entry.id));bar.append(tile);row.append(name,bar);root.append(row)}$('clipCount').textContent=audioClips.length+' / 12 clips'}
function clearAudioClips(){audioClips=[];selectedClipId=null;aiClip=null;aiTrack={level:75,pan:0,mute:false,startBar:0,trimStart:0,trimEnd:0,fadeIn:0,fadeOut:0,pitchSemitones:0,syncTempo:false,snap:true};syncAIControls();drawClipLane()}
function restoreClipMetadata(metadata){if(!Array.isArray(metadata))return;for(const m of metadata){if(!m||typeof m.name!=='string'||typeof m.track!=='object')throw Error('Metadatos de clips inválidos');const t=m.track;if(t.detectedBpm!==undefined&&(!Number.isFinite(t.detectedBpm)||t.detectedBpm<60||t.detectedBpm>220))throw Error('BPM de clip inválido');if(t.pitchSemitones!==undefined&&(!Number.isFinite(t.pitchSemitones)||Math.abs(t.pitchSemitones)>12))throw Error('Afinación fuera de rango');if(!Number.isInteger(t.startBar)||t.startBar<0||t.startBar>31||!Number.isFinite(t.level)||t.level<0||t.level>100||!Number.isFinite(t.pan)||Math.abs(t.pan)>100||typeof t.mute!=='boolean'||!['trimStart','trimEnd','fadeIn','fadeOut'].every(k=>Number.isFinite(t[k])&&t[k]>=0&&t[k]<=600))throw Error('Ajustes de clips inválidos')}}
function aiPosition(){return aiTrack.startBar*4*60/Math.max(60,Number($('bpm').value)||132)}
function clipRange(){if(!aiClip)return {start:0,end:0,duration:0};const duration=aiClip.buffer.duration,start=Math.min(duration,Math.max(0,aiTrack.trimStart||0)),end=Math.max(start,Math.min(duration, duration-(aiTrack.trimEnd||0)));return {start,end,duration:end-start}}
function aiLabel(){const e=$('aiClipInfo');if(!e)return;if(!aiClip){e.textContent='Sin audio importado. El clip no se incluye dentro del JSON.';return}const r=clipRange();e.textContent=`${aiClip.name} · ${r.duration.toFixed(2)} s útiles de ${aiClip.buffer.duration.toFixed(2)} s · compás ${aiTrack.startBar+1}`}
function syncAIControls(){for(const [id,key] of [['aiLevel','level'],['aiPan','pan'],['aiStartBar','startBar'],['aiTrimStart','trimStart'],['aiTrimEnd','trimEnd'],['aiFadeIn','fadeIn'],['aiFadeOut','fadeOut'],['aiPitch','pitchSemitones']])$(id).value=aiTrack[key]??0;$('aiMute').checked=aiTrack.mute;aiLabel();drawWaveform();drawClipLane();refreshTempoUI()}
function updateAITrack(){if(!ctx||!aiGain||!aiPan)return;aiGain.gain.setTargetAtTime(aiTrack.mute?0:aiTrack.level/100,ctx.currentTime,.012);aiPan.pan.setTargetAtTime(aiTrack.pan/100,ctx.currentTime,.012)}
function drawWaveform(){const canvas=$('aiWaveform');if(!canvas)return;const g=canvas.getContext('2d');if(!g)return;const w=canvas.width,h=canvas.height;g.fillStyle='#0b1120';g.fillRect(0,0,w,h);g.strokeStyle='#39445f';g.beginPath();g.moveTo(0,h/2);g.lineTo(w,h/2);g.stroke();if(!aiClip)return;const buf=aiClip.buffer,channels=Array.from({length:buf.numberOfChannels},(_,i)=>buf.getChannelData(i));g.strokeStyle='#69daca';g.beginPath();const bucket=Math.max(1,Math.floor(buf.length/w));for(let x=0;x<w;x++){let max=0;for(let k=x*bucket;k<Math.min(buf.length,(x+1)*bucket);k+=Math.max(1,Math.floor(bucket/32))){for(const data of channels)max=Math.max(max,Math.abs(data[k]||0))}g.moveTo(x,h/2-max*(h/2-4));g.lineTo(x,h/2+max*(h/2-4))}g.stroke();const r=clipRange();g.fillStyle='rgba(5,8,18,.72)';g.fillRect(0,0,r.start/buf.duration*w,h);g.fillRect(r.end/buf.duration*w,0,(buf.duration-r.end)/buf.duration*w,h);g.strokeStyle='#f6bc7d';g.lineWidth=2;for(const x of [r.start/buf.duration*w,r.end/buf.duration*w]){g.beginPath();g.moveTo(x,0);g.lineTo(x,h);g.stroke()}g.lineWidth=1}
function setClipEdit(){if(!aiClip){aiLabel();drawWaveform();return}const duration=aiClip.buffer.duration;aiTrack.trimStart=Math.min(Math.max(0,aiTrack.trimStart),Math.max(0,duration-.01));aiTrack.trimEnd=Math.min(Math.max(0,aiTrack.trimEnd),Math.max(0,duration-aiTrack.trimStart-.01));const len=clipRange().duration;aiTrack.fadeIn=Math.max(0,Math.min(aiTrack.fadeIn,len));aiTrack.fadeOut=Math.max(0,Math.min(aiTrack.fadeOut,len));for(const [id,key] of [['aiTrimStart','trimStart'],['aiTrimEnd','trimEnd'],['aiFadeIn','fadeIn'],['aiFadeOut','fadeOut'],['aiPitch','pitchSemitones']])$(id).value=Number((aiTrack[key]??0).toFixed(2));aiLabel();drawWaveform();rememberSelection();drawClipLane()}
async function importAIAudio(file){if(!file)throw Error('Selecciona un archivo de audio');if(audioClips.length>=12)throw Error('Máximo 12 clips de audio');if(file.size>80*1024*1024)throw Error('Máximo 80 MB por archivo');if(!/\.(wav|mp3|ogg|m4a|aac|flac)$/i.test(file.name)&&!file.type.startsWith('audio/'))throw Error('Formato no admitido');const decoder=new AudioContextClass();try{const array=await file.arrayBuffer(),buffer=await decoder.decodeAudioData(array);if(buffer.duration>600)throw Error('Máximo 10 minutos por clip');if(decodedAudioBytes(buffer)>MAX_DECODED_AUDIO_BYTES)throw Error('Memoria de audio excedida: máximo 192 MiB decodificados; elimina clips o utiliza audio más corto.');stop();rememberSelection();const matched=pendingClips.findIndex(e=>e.name===file.name),remembered=matched>=0?pendingClips.splice(matched,1)[0].track:null;const entry={id:++clipSequence,clip:{buffer,name:file.name},track:remembered?{...remembered}:{level:75,pan:0,mute:false,startBar:0,trimStart:0,trimEnd:0,fadeIn:0,fadeOut:0,pitchSemitones:0,syncTempo:false,snap:true}};audioClips.push(entry);selectedClipId=entry.id;aiClip=entry.clip;aiTrack=entry.track;setClipEdit();syncAIControls();msg('Clip añadido a la línea de tiempo. Pulsa su nombre para editarlo.')}finally{await decoder.close()}}
function scheduleClip(ac,destination,when,clip,track,renderDuration=Infinity){if(!clip||track.mute)return null;const original=clip.buffer,processed=processedClip(original,track,ac),buffer=processed.buffer,ratio=processed.ratio,start=Math.min(buffer.duration,Math.max(0,track.trimStart||0)*ratio),length=Math.max(0,buffer.duration-start-(track.trimEnd||0)*ratio);const offset=track.startBar*4*60/Math.max(60,Number($('bpm').value)||132),playLength=Math.min(length,renderDuration-offset);if(playLength<=0)return null;const src=ac.createBufferSource(),gain=ac.createGain(),pan=ac.createStereoPanner();src.buffer=buffer;src.playbackRate.value=1;const level=track.level/100;let fi=Math.min(playLength,Math.max(0,Number(track.fadeIn)||0)),fo=Math.min(playLength,Math.max(0,Number(track.fadeOut)||0));/* Ensure ramp events cannot overlap or reverse in time. */if(fi+fo>playLength){const scale=playLength/(fi+fo);fi*=scale;fo*=scale;}gain.gain.setValueAtTime(fi?0:level,when+offset);if(fi)gain.gain.linearRampToValueAtTime(level,when+offset+fi);const fadeOutAt=when+offset+Math.max(fi,playLength-fo);if(fo&&fadeOutAt<when+offset+playLength){gain.gain.setValueAtTime(level,fadeOutAt);gain.gain.linearRampToValueAtTime(0,when+offset+playLength)}pan.pan.value=track.pan/100;src.connect(gain).connect(pan).connect(destination);src.start(when+offset,start,playLength);return {src,gain,pan}}
function scheduleAI(ac,destination,when,renderDuration=Infinity){rememberSelection();return audioClips.map(e=>scheduleClip(ac,destination,when,e.clip,e.track,renderDuration)).filter(Boolean)}
window.sonicImportAudio=async function(url,name='ACE-Step generado.wav'){const response=await fetch(url);if(!response.ok)throw Error('No se puede descargar el audio de IA');const blob=await response.blob();await importAIAudio(new File([blob],name,{type:blob.type||'audio/wav'}))};
let liveBus=null,analyser=null,visualFrame=0;
function validateMix(candidate){if(!candidate||typeof candidate!=='object')throw Error('Mezclador inválido');for(const [n] of TRACKS){const c=candidate[n];if(!c||!['level','pan','send'].every(k=>typeof c[k]==='number'&&Number.isFinite(c[k]))||c.level<0||c.level>100||c.pan< -100||c.pan>100||c.send<0||c.send>100||typeof c.mute!=='boolean'||typeof c.solo!=='boolean')throw Error('Canal inválido '+n)}}
function validateFx(x){if(!x||![x.delay,x.feedback,x.masterDrive].every(Number.isFinite)||x.delay<0||x.delay>100||x.feedback<0||x.feedback>75||x.masterDrive<0||x.masterDrive>100||typeof x.autoFilter!=='boolean')throw Error('Efectos inválidos')}
function drawMixer(){const root=$('mixer');root.replaceChildren();for(const [name,color] of TRACKS){const c=mixer[name],card=document.createElement('div');card.className='mixchannel';const title=document.createElement('strong');title.textContent=name;title.style.color=color;card.append(title);for(const [field,label,min,max] of [['level','VOL',0,100],['pan','PAN',-100,100],['send','SEND',0,100]]){const wrap=document.createElement('label'),txt=document.createElement('span'),slider=document.createElement('input');txt.textContent=label+' '+c[field];slider.type='range';slider.min=min;slider.max=max;slider.value=c[field];slider.dataset.mix=name;slider.dataset.field=field;slider.addEventListener('input',()=>{c[field]=Number(slider.value);txt.textContent=label+' '+c[field];updateLiveMix()});wrap.append(txt,slider);card.append(wrap)}const controls=document.createElement('div');controls.className='mixswitches';for(const [field,label] of [['mute','M'],['solo','S']]){const btn=document.createElement('button');btn.type='button';btn.textContent=label;btn.title=field==='mute'?'Silenciar':'Solo';btn.className=c[field]?'mix-selected':'';btn.addEventListener('click',()=>{c[field]=!c[field];drawMixer();updateLiveMix()});controls.append(btn)}card.append(controls);root.append(card)}for(const [id,key] of [['delayMix','delay'],['delayFeedback','feedback'],['masterDrive','masterDrive']])$(id).value=mixEffects[key];$('autoFilter').checked=mixEffects.autoFilter}
function curve(drive){const points=2048,arr=new Float32Array(points),k=1+drive/10;for(let i=0;i<points;i++){const x=i*2/(points-1)-1;arr[i]=Math.tanh(k*x)/Math.tanh(k)}return arr}
function buildBus(ac,out,mixState=mixer,fxState=mixEffects){const channels={},sendReturn=ac.createGain(),delay=ac.createDelay(1),feedback=ac.createGain(),wet=ac.createGain(),filter=ac.createBiquadFilter(),drive=ac.createWaveShaper(),limiter=ac.createDynamicsCompressor();filter.type='lowpass';filter.frequency.value=19000;drive.curve=curve(fxState.masterDrive);drive.oversample='2x';limiter.threshold.value=-7;limiter.knee.value=4;limiter.ratio.value=14;limiter.attack.value=.005;limiter.release.value=.13;filter.connect(drive).connect(limiter).connect(out);delay.delayTime.value=.375;feedback.gain.value=fxState.feedback/100;wet.gain.value=fxState.delay/100*.55;sendReturn.connect(delay);delay.connect(feedback).connect(delay);delay.connect(wet).connect(filter);const solo=Object.values(mixState).some(c=>c.solo);for(const [name] of TRACKS){const c=mixState[name],input=ac.createGain(),pan=ac.createStereoPanner(),dry=ac.createGain(),send=ac.createGain();input.connect(pan);pan.connect(dry).connect(filter);pan.connect(send).connect(sendReturn);pan.pan.value=c.pan/100;dry.gain.value=(c.mute||(solo&&!c.solo)?0:c.level/100);send.gain.value=c.send/100*(c.mute||(solo&&!c.solo)?0:1);channels[name]={input,pan,dry,send}}return {channels,feedback,wet,drive,filter}}
function updateLiveMix(){if(!liveBus||!ctx)return;const solo=Object.values(mixer).some(c=>c.solo);for(const [n] of TRACKS){const c=mixer[n],b=liveBus.channels[n],audible=!(c.mute||(solo&&!c.solo));b.dry.gain.setTargetAtTime(audible?c.level/100:0,ctx.currentTime,.015);b.pan.pan.setTargetAtTime(c.pan/100,ctx.currentTime,.015);b.send.gain.setTargetAtTime(audible?c.send/100:0,ctx.currentTime,.015)}liveBus.feedback.gain.setTargetAtTime(mixEffects.feedback/100,ctx.currentTime,.025);liveBus.wet.gain.setTargetAtTime(mixEffects.delay/100*.55,ctx.currentTime,.025);liveBus.drive.curve=curve(mixEffects.masterDrive)}
const AudioContextClass=window.AudioContext||window.webkitAudioContext;
function msg(s){$('message').textContent=s}function settings(){return {genre:$('genre').value,bpm:+$('bpm').value,key:$('key').value,scale:$('scale').value,bassNote:+$('bassNote').value,cutoff:+$('cutoff').value,volume:+$('volume').value,projectName:$('projectName').value,composer:structuredClone(composer),mixer:structuredClone(mixer),mixEffects:structuredClone(mixEffects)}};
function draw(){const grid=$('sequencer');grid.replaceChildren();for(const [name,color] of TRACKS){const row=document.createElement('div');row.className='track';const title=document.createElement('div');title.className='trackname';title.textContent=name;title.style.color=color;row.append(title);for(let i=0;i<16;i++){const b=document.createElement('button');b.type='button';b.className='step'+(pattern[name][i]?' active':'')+(i%4===0?' beat':'');b.style.setProperty('--track-color',color);b.dataset.track=name;b.dataset.step=i;b.setAttribute('aria-label',`${name}, paso ${i+1}`);b.setAttribute('aria-pressed',String(pattern[name][i]));b.addEventListener('click',()=>{pattern[name][i]=!pattern[name][i];b.classList.toggle('active',pattern[name][i]);b.setAttribute('aria-pressed',String(pattern[name][i]))});row.append(b)}grid.append(row)}}
function makeNoise(ac){const b=ac.createBuffer(1,Math.floor(ac.sampleRate),ac.sampleRate);let data=b.getChannelData(0),s=123456789;for(let i=0;i<data.length;i++){s^=s<<13;s^=s>>>17;s^=s<<5;data[i]=(s>>>0)/2147483648-1}return b}
function envelope(ac,at,attack,decay,peak){const g=ac.createGain();g.gain.setValueAtTime(0,at);g.gain.linearRampToValueAtTime(peak,at+attack);g.gain.exponentialRampToValueAtTime(.0001,at+attack+decay);return g}
function osc(ac,type,f,at,duration,target,frequencyEnd){let o=ac.createOscillator();o.type=type;o.frequency.setValueAtTime(f,at);if(frequencyEnd)o.frequency.exponentialRampToValueAtTime(frequencyEnd,at+duration);o.connect(target);o.start(at);o.stop(at+duration+.02);return o}
function noise(ac,buffer,at,duration,target,filterType,frequency){const source=ac.createBufferSource();source.buffer=buffer;const filter=ac.createBiquadFilter();filter.type=filterType;filter.frequency.value=frequency;source.connect(filter).connect(target);source.start(at);source.stop(at+duration+.02);return source}
const NOTES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function noteHz(s,offset,octave=2){const base=NOTES.indexOf(s.key),semi=(base+offset+12)%12;return 440*2**(((octave+1)*12+semi-69)/12)}
function sectionAt(bar,s){return s.composer.structure[bar%s.composer.structure.length]||'groove'}
function hasHit(name,index,bar,s,p){if(!p[name][index])return false;const section=sectionAt(bar,s);if(section==='break'&&['KICK','CLAP','BASS'].includes(name))return false;if(section==='intro'&&['CLAP','OPEN','CHORD'].includes(name))return false;if(section==='outro'&&['OPEN','CHORD'].includes(name))return false;if(section==='build'&&name==='CHORD'&&index>4)return false;return true}
function harmonicRoot(s,bar){return PROGRESSIONS[s.composer.progression][bar%4]}
function hit(ac,buff,out,name,at,s,idx,bar=0){if(name==='KICK'){const e=envelope(ac,at,.002,.3,.92);e.connect(out);osc(ac,'sine',150,at,.33,e,43);return}if(name==='CLAP'){for(const delay of [0,.018,.036]){const e=envelope(ac,at+delay,.001,.09,.23);e.connect(out);noise(ac,buff,at+delay,.095,e,'highpass',1100)}return}if(name==='HAT'||name==='OPEN'){const d=name==='HAT'?.055:.33,e=envelope(ac,at,.001,d,name==='HAT'?.17:.14);e.connect(out);noise(ac,buff,at,d,e,'highpass',6000);return}if(name==='BASS'){const scale=s.scale==='minor'?[0,3,5,7,10]:[0,4,5,7,9];const degree=scale[Math.floor(idx/4)%scale.length];const frequency=noteHz(s,degree+s.bassNote+harmonicRoot(s,bar),2);const e=envelope(ac,at,.008,.18,.24);const low=ac.createBiquadFilter();low.type='lowpass';low.frequency.value=s.cutoff;e.connect(low).connect(out);osc(ac,'sawtooth',frequency,at,.2,e);return}if(name==='CHORD'){const intervals=s.scale==='minor'?[0,3,7]:[0,4,7];for(const degree of intervals){const e=envelope(ac,at,.035,.55,.065);e.connect(out);osc(ac,'triangle',noteHz(s,degree+harmonicRoot(s,bar),4),at,.6,e)}return}}
function fire(ac,buff,out,at,s,index,bar=0,p=pattern){for(const [name] of TRACKS){if(hasHit(name,index,bar,s,p))hit(ac,buff,out.channels?out.channels[name].input:out,name,at,s,index,bar)}}
function mark(index){document.querySelectorAll('.step.playhead').forEach(el=>el.classList.remove('playhead'));document.querySelectorAll(`[data-step="${index}"]`).forEach(el=>el.classList.add('playhead'))}
function tick(id){if(id!==runId||!ctx)return;const sec=60/Math.max(60,Math.min(200,Number($('bpm').value)||132))/4;while(nextTime<ctx.currentTime+.12){const i=stepIndex,when=nextTime;fire(ctx,noiseBuffer,liveBus,when,settings(),i,barIndex);if(liveBus&&mixEffects.autoFilter&&i===0){const sec=sectionAt(barIndex,settings());liveBus.filter.frequency.setTargetAtTime(({intro:900,groove:9000,build:4500,drop:19000,break:1350,outro:1800})[sec]||12000,when,.16)}const delay=Math.max(0,(when-ctx.currentTime)*1000);setTimeout(()=>{if(id===runId)mark(i)},delay);nextTime+=sec;stepIndex=(stepIndex+1)%16;if(stepIndex===0)barIndex++;}}
async function play(){if(!AudioContextClass){msg('Tu navegador no soporta Web Audio API.');return}if(timer)return;try{ctx=new AudioContextClass();await ctx.resume();noiseBuffer=makeNoise(ctx);master=ctx.createGain();master.gain.value=Number($('volume').value)/100;master.connect(ctx.destination);liveMaster=masteringBus(ctx,master);analyser=ctx.createAnalyser();analyser.fftSize=1024;master.connect(analyser);liveBus=buildBus(ctx,liveMaster.input);startVisual();stepIndex=0;barIndex=0;nextTime=ctx.currentTime+.06;scheduleAI(ctx,liveMaster.input,nextTime);aiSource=null;aiGain=null;aiPan=null;const id=++runId;tick(id);timer=setInterval(()=>tick(id),25);$('status').textContent='● REPRODUCIENDO';$('status').classList.add('live');$('play').textContent='♫ SONANDO';msg('Reproducción activa. Puedes editar los pasos en directo.')}catch(e){stop();msg('No se pudo iniciar audio: '+e.message)}}
function stop(){runId++;aiSource=null;aiGain=null;aiPan=null;if(timer){clearInterval(timer);timer=null}document.querySelectorAll('.step.playhead').forEach(el=>el.classList.remove('playhead'));if(ctx){const old=ctx;ctx=null;old.close().catch(()=>{})}master=null;liveBus=null;liveMaster=null;analyser=null;noiseBuffer=null;cancelAnimationFrame(visualFrame);visualFrame=0;drawVisualIdle();$('status').textContent='DETENIDO';$('status').classList.remove('live');$('play').textContent='▶ REPRODUCIR'}
function generate(){const genre=$('genre').value;const kick=genre==='hard'?[0,4,8,12]:[0,4,8,12];pattern.KICK=Array.from({length:16},(_,i)=>kick.includes(i));pattern.CLAP=Array.from({length:16},(_,i)=>[4,12].includes(i));pattern.HAT=Array.from({length:16},(_,i)=>genre==='hard'?i%2===0:Math.random()<.6&&i%2===0);pattern.OPEN=Array.from({length:16},(_,i)=>i%8===6||Math.random()<.08);pattern.BASS=Array.from({length:16},(_,i)=>Math.random()<(genre==='deep'?.38:.52));pattern.CHORD=Array.from({length:16},(_,i)=>i===0||i===8||(genre==='house'&&i===12));$('bpm').value={techno:132,house:125,deep:120,hard:150}[genre];draw();msg(`Nuevo patrón ${genre} generado. Puedes personalizarlo.`)}
function project(){rememberSelection();return {app:'SONIC-FORGE-404',version:11,clips:audioClips.map(e=>({name:e.clip.name,track:{...e.track}})),aiTrack:structuredClone(aiTrack),aiAudioName:aiClip?.name||null,settings:settings(),mixer:structuredClone(mixer),mixEffects:structuredClone(mixEffects),mastering:structuredClone(mastering),pattern:structuredClone(pattern),composer:structuredClone(composer)}}
function apply(data){if(!data||data.app!=='SONIC-FORGE-404'||!data.pattern||!data.settings)throw Error('Formato de proyecto no válido');for(const [name] of TRACKS){if(!Array.isArray(data.pattern[name])||data.pattern[name].length!==16||!data.pattern[name].every(x=>typeof x==='boolean'))throw Error('Patrón inválido: '+name)}const s=data.settings;for(const field of ['genre','key','scale']){if(typeof s[field]!=='string')throw Error('Ajuste inválido: '+field)}for(const [field,min,max] of [['bpm',60,200],['cutoff',120,1800],['volume',0,100],['bassNote',0,7]]){if(!Number.isFinite(+s[field])||+s[field]<min||+s[field]>max)throw Error('Valor fuera de rango: '+field)}if(!['techno','house','deep','hard'].includes(s.genre)||!NOTES.includes(s.key)||!['minor','major'].includes(s.scale)||![0,3,5,7].includes(+s.bassNote))throw Error('Configuración no admitida');const c=data.composer||s.composer;
if(c){if(!PROGRESSIONS[c.progression]||!Number.isFinite(c.energy)||c.energy<0||c.energy>100||!Number.isFinite(c.variation)||c.variation<0||c.variation>100||!Array.isArray(c.structure)||c.structure.length!==8||!c.structure.every(v=>SECTION_LABELS[v]))throw Error('Compositor inválido');}
if(data.aiTrack){const t=data.aiTrack;if(!Number.isFinite(t.level)||t.level<0||t.level>100||!Number.isFinite(t.pan)||t.pan< -100||t.pan>100||!Number.isInteger(t.startBar)||t.startBar<0||t.startBar>31||typeof t.mute!=='boolean')throw Error('Pista AI inválida')}if(data.aiTrack){for(const key of ['trimStart','trimEnd','fadeIn','fadeOut']){const v=data.aiTrack[key]??0;if(!Number.isFinite(v)||v<0||v>600)throw Error('Edición de clip inválida: '+key)}}restoreClipMetadata(data.clips);if(data.mixer)validateMix(data.mixer);if(data.mixEffects)validateFx(data.mixEffects);if(data.mastering)validateMaster(data.mastering);stop();mixer=data.mixer?structuredClone(data.mixer):MIX_DEFAULT();mixEffects=data.mixEffects?structuredClone(data.mixEffects):{delay:0,feedback:25,masterDrive:0,autoFilter:false};drawMixer();mastering=data.mastering?structuredClone(data.mastering):{...MASTER_PRESETS.neutral,enabled:true};drawMaster();clearAudioClips();pendingClips=(data.clips||[]).map(e=>({name:e.name,track:{...e.track}}));composer=c?structuredClone(c):{progression:'dark',energy:65,variation:35,structure:['intro','groove','build','drop','break','drop','outro','groove']};syncComposer();pattern=structuredClone(data.pattern);for(const key of ['genre','bpm','key','scale','bassNote','cutoff','volume','projectName'])if($(key))$(key).value=s[key]??'';draw()}
function download(blob,filename){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000)}
function fileName(ext){const name=$('projectName').value.trim().replace(/[^a-z0-9_-]+/gi,'-').replace(/^-|-$/g,'').slice(0,70)||'sonic-forge';return `${name}.${ext}`}
function encodeWav(buffer){const channels=buffer.numberOfChannels,rate=buffer.sampleRate,n=buffer.length,arr=new ArrayBuffer(44+n*channels*2),v=new DataView(arr);const str=(at,s)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i))};str(0,'RIFF');v.setUint32(4,36+n*channels*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels,true);v.setUint32(24,rate,true);v.setUint32(28,rate*channels*2,true);v.setUint16(32,channels*2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,n*channels*2,true);let samples=Array.from({length:channels},(_,i)=>buffer.getChannelData(i)),at=44;for(let i=0;i<n;i++)for(let c=0;c<channels;c++){let x=Math.max(-1,Math.min(1,samples[c][i]));v.setInt16(at,x<0?x*32768:x*32767,true);at+=2}return new Blob([arr],{type:'audio/wav'})}
async function renderOffline(selectedTrack=null,masterBypass=false){
 const OAC=window.OfflineAudioContext||window.webkitOfflineAudioContext;
 if(!OAC)throw Error('El navegador no admite OfflineAudioContext');
 const s=settings(),p=structuredClone(pattern),bars=+$('bars').value;
 if(!Number.isInteger(bars)||bars<4||bars>32)throw Error('Duración de exportación inválida (4 a 32 compases)');
 if(activeOfflineRenders>=MAX_CONCURRENT_RENDERS)throw Error('Ya hay una exportación o análisis de audio en curso');
 if(!Number.isFinite(s.bpm)||s.bpm<60||s.bpm>200)throw Error('BPM fuera del rango de 60 a 200');
 const duration=bars*4*60/s.bpm,rate=44100;
 const ac=new OAC(2,Math.ceil((duration+1)*rate),rate),out=ac.createGain();
 out.gain.value=s.volume/100;out.connect(ac.destination);
 const mix=structuredClone(mixer),fx=structuredClone(mixEffects);
 if(selectedTrack){for(const [name] of TRACKS){mix[name].mute=name!==selectedTrack;mix[name].solo=false;}mix[selectedTrack].mute=false;}
 const mBus=selectedTrack?null:masteringBus(ac,out,{...mastering,enabled:mastering.enabled&&!masterBypass});const destination=mBus?mBus.input:out;const buff=makeNoise(ac),bus=buildBus(ac,destination,mix,fx);
 // Independent stereo AI channel, included only in full-mix export.
 // Stem exports remain isolated synth instruments.
 if(!selectedTrack)scheduleAI(ac,destination,0,duration);

 for(let i=0;i<bars*16;i++){
   const at=i*60/s.bpm/4,bar=Math.floor(i/16);
   // The isolated export only schedules the chosen synth, not other tracks.
   if(selectedTrack){if(hasHit(selectedTrack,i%16,bar,s,p))hit(ac,buff,bus.channels[selectedTrack].input,selectedTrack,at,s,i%16,bar)}
   else fire(ac,buff,bus,at,s,i%16,bar,p);
   if(fx.autoFilter&&i%16===0){const sec=sectionAt(bar,s);bus.filter.frequency.setTargetAtTime(({intro:900,groove:9000,build:4500,drop:19000,break:1350,outro:1800})[sec]||12000,at,.16)}
 }
 activeOfflineRenders++;try{return {audio:await ac.startRendering(),bars,duration}}finally{activeOfflineRenders--}
}
async function exportWav(){const btn=$('wav');btn.disabled=true;btn.textContent='RENDERIZANDO…';try{
 const result=await renderOffline();download(encodeWav(result.audio),fileName('wav'));msg(`WAV exportado: ${result.bars} compases / ${Math.round(result.duration)} segundos.`);
}catch(e){msg('Error al exportar WAV: '+e.message)}finally{btn.disabled=false;btn.textContent='↓ EXPORTAR WAV'}}
async function exportStem(){const btn=$('stemExport'),name=$('stemTrack').value;
 if(!TRACKS.some(([n])=>n===name)){msg('Pista desconocida.');return}
 btn.disabled=true;btn.textContent='RENDERIZANDO STEM…';try{
 const result=await renderOffline(name);
 download(encodeWav(result.audio),fileName('wav').replace(/\.wav$/i,`-${name.toLowerCase()}.wav`));
 msg(`Stem ${name} exportado: ${result.bars} compases. Los archivos comparten inicio y duración.`);
 }catch(e){msg('Error al exportar stem: '+e.message)}finally{btn.disabled=false;btn.textContent='↓ EXPORTAR STEM'}}
$('stemExport').addEventListener('click',exportStem);
$('aiImportFile').addEventListener('change',async e=>{try{await importAIAudio(e.target.files[0])}catch(err){msg('Error al importar audio: '+err.message)}finally{e.target.value=''}});
$('bpm').addEventListener('change',drawClipLane);
$('aiImport').addEventListener('click',()=>$('aiImportFile').click());
$('aiRemove').addEventListener('click',()=>{stop();audioClips=audioClips.filter(e=>e.id!==selectedClipId);const next=audioClips[0];if(next){selectedClipId=next.id;aiClip=next.clip;aiTrack=next.track;syncAIControls()}else clearAudioClips();drawClipLane();msg('Clip seleccionado retirado.')});
for(const [id,key] of [['aiLevel','level'],['aiPan','pan'],['aiStartBar','startBar']])$(id).addEventListener('input',()=>{if(key==='startBar')stop();aiTrack[key]=Number($(id).value);updateAITrack();rememberSelection();aiLabel();drawClipLane()});
for(const [id,key] of [['aiTrimStart','trimStart'],['aiTrimEnd','trimEnd'],['aiFadeIn','fadeIn'],['aiFadeOut','fadeOut'],['aiPitch','pitchSemitones']])$(id).addEventListener('change',()=>{const value=Number($(id).value);if(!Number.isFinite(value)||(key==='pitchSemitones'?Math.abs(value)>12:value<0)){$(id).value=aiTrack[key];return}stop();aiTrack[key]=value;setClipEdit();msg('Edición del clip actualizada. Vuelve a reproducir para escucharla.')});
$('aiResetEdit').addEventListener('click',()=>{stop();for(const k of ['trimStart','trimEnd','fadeIn','fadeOut'])aiTrack[k]=0;syncAIControls();msg('Recortes y fundidos restaurados.')});
$('aiMute').addEventListener('change',()=>{aiTrack.mute=$('aiMute').checked;rememberSelection();if(ctx){stop();msg('Mute actualizado. Pulsa reproducir para escucharlo.')}drawClipLane()});syncAIControls();


$('play').addEventListener('click',play);$('stop').addEventListener('click',()=>{stop();msg('Reproducción detenida.')});$('random').addEventListener('click',generate);$('volume').addEventListener('input',()=>{if(master)master.gain.setTargetAtTime(+$('volume').value/100,ctx.currentTime,.02)});$('save').addEventListener('click',()=>{try{localStorage.setItem('sonic-forge-404-project',JSON.stringify(project()));msg('Proyecto guardado en este navegador.')}catch(e){msg('No se ha podido guardar: '+e.message)}});$('load').addEventListener('click',()=>{try{const raw=localStorage.getItem('sonic-forge-404-project');if(!raw){msg('No hay ningún proyecto guardado.');return}apply(JSON.parse(raw));msg('Proyecto cargado.')}catch(e){msg('No se ha podido cargar: '+e.message)}});$('exportJson').addEventListener('click',()=>{download(new Blob([JSON.stringify(project(),null,2)],{type:'application/json'}),fileName('json'));msg('Proyecto JSON exportado.')});$('importJson').addEventListener('click',()=>$('file').click());$('file').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>1024*1024)throw Error('Archivo demasiado grande');apply(JSON.parse(await f.text()));msg('Proyecto importado.')}catch(err){msg('Error al importar: '+err.message)}finally{e.target.value=''}});$('wav').addEventListener('click',exportWav);$('reset').addEventListener('click',()=>{stop();pattern=Object.fromEntries(TRACKS.map(([n])=>[n,Array.from({length:16},(_,i)=>defaultPatterns[n].includes(i))]));$('genre').value='techno';$('bpm').value=132;$('key').value='C';$('scale').value='minor';$('bassNote').value=0;$('cutoff').value=640;$('volume').value=65;composer={progression:'dark',energy:65,variation:35,structure:['intro','groove','build','drop','break','drop','outro','groove']};syncComposer();mixer=MIX_DEFAULT();mixEffects={delay:0,feedback:25,masterDrive:0,autoFilter:false};drawMixer();mastering={...MASTER_PRESETS.neutral,enabled:true};drawMaster();aiTrack={level:75,pan:0,mute:false,startBar:0,trimStart:0,trimEnd:0,fadeIn:0,fadeOut:0};clearAudioClips();pendingClips=[];draw();msg('Patrón, mezcla y ajustes reiniciados.')});draw();

function drawArrangement(){const container=$('arrangement');container.replaceChildren();composer.structure.forEach((section,i)=>{const label=document.createElement('label');label.className='arrblock';const caption=document.createElement('span');caption.textContent=`COMPÁS ${i+1}`;const select=document.createElement('select');select.setAttribute('aria-label',`Sección compás ${i+1}`);for(const [value,title] of Object.entries(SECTION_LABELS)){const option=document.createElement('option');option.value=value;option.textContent=title;select.append(option)}select.value=section;select.addEventListener('change',()=>{composer.structure[i]=select.value;msg('Estructura actualizada.')});label.append(caption,select);container.append(label)})}
function syncComposer(){$('progression').value=composer.progression;$('energy').value=composer.energy;$('variation').value=composer.variation;$('energyValue').textContent=composer.energy+'%';$('variationValue').textContent=composer.variation+'%';drawArrangement()}
function compose(){const genre=$('genre').value;generate();const e=composer.energy/100,v=composer.variation/100;const density=.12+e*.5;pattern.BASS=Array.from({length:16},(_,i)=>i%4===0||Math.random()<density*(i%2===0?1:.7));pattern.CHORD=Array.from({length:16},(_,i)=>i===0||i===8||(Math.random()<v*.22&&i%4===0));pattern.HAT=Array.from({length:16},(_,i)=>i%2===0||(Math.random()<v*.22));pattern.OPEN=Array.from({length:16},(_,i)=>[6,14].includes(i)||(Math.random()<v*.08));if(genre==='hard')pattern.KICK=Array.from({length:16},(_,i)=>i%4===0||(Math.random()<e*v*.16));draw();msg('Composición creada: armonía, groove y variaciones listas. Escucha y edita el arreglo.')}
$('compose').addEventListener('click',compose);
$('progression').addEventListener('change',()=>{composer.progression=$('progression').value;msg('Progresión armónica actualizada.')});
for(const type of ['energy','variation'])$(type).addEventListener('input',()=>{composer[type]=Number($(type).value);$(type+'Value').textContent=composer[type]+'%'});
$('arrange').addEventListener('click',()=>{composer.structure=['intro','groove','build','drop','break','drop','drop','outro'];drawArrangement();msg('Arreglo de ocho compases creado.')});
syncComposer();

for(const [id,key] of [['delayMix','delay'],['delayFeedback','feedback'],['masterDrive','masterDrive']])$(id).addEventListener('input',()=>{mixEffects[key]=Number($(id).value);updateLiveMix()});
$('autoFilter').addEventListener('change',()=>{mixEffects.autoFilter=$('autoFilter').checked;if(liveBus&&!mixEffects.autoFilter)liveBus.filter.frequency.setTargetAtTime(19000,ctx.currentTime,.05)});
$('resetMix').addEventListener('click',()=>{mixer=MIX_DEFAULT();mixEffects={delay:0,feedback:25,masterDrive:0,autoFilter:false};drawMixer();updateLiveMix();msg('Mezclador restaurado.')});drawMixer();

// Phase 5: accessible visualizer, skins and workflow shortcuts. No network calls.
const visualCanvas=$('spectrum'),visualCtx=visualCanvas.getContext('2d');
function visualColor(){return getComputedStyle(document.documentElement).getPropertyValue('--visual').trim()||'#a58cff'}
function drawVisualIdle(){if(!visualCtx)return;const w=visualCanvas.width,h=visualCanvas.height;visualCtx.clearRect(0,0,w,h);visualCtx.fillStyle='#0b1120';visualCtx.fillRect(0,0,w,h);visualCtx.strokeStyle='rgba(155,170,205,.11)';for(let i=1;i<5;i++){visualCtx.beginPath();visualCtx.moveTo(0,h*i/5);visualCtx.lineTo(w,h*i/5);visualCtx.stroke()}visualCtx.fillStyle=visualColor();for(let i=0;i<72;i++){const x=i*w/72+4,amp=5+Math.abs(Math.sin(i*.41)*Math.cos(i*.13))*18;visualCtx.globalAlpha=.16;visualCtx.fillRect(x,h/2-amp/2,w/90,amp)}visualCtx.globalAlpha=1;$('visLabel').textContent='STANDBY · PULSA PLAY'}
function startVisual(){if(!visualCtx||!analyser)return;const data=new Uint8Array(analyser.frequencyBinCount);$('visLabel').textContent='LIVE · ANALIZADOR ACTIVO';const render=()=>{if(!analyser)return;analyser.getByteFrequencyData(data);const w=visualCanvas.width,h=visualCanvas.height;visualCtx.fillStyle='#0b1120';visualCtx.fillRect(0,0,w,h);const bars=88,unit=w/bars;visualCtx.fillStyle=visualColor();for(let i=0;i<bars;i++){const index=Math.floor(Math.pow(i/bars,1.65)*(data.length-1));const height=Math.max(2,(data[index]/255)**1.25*(h-12));visualCtx.globalAlpha=.45+.55*i/bars;visualCtx.fillRect(i*unit+2,h-height-3,Math.max(2,unit-4),height)}visualCtx.globalAlpha=1;visualFrame=requestAnimationFrame(render)};render()}
const SKINS=['violet','cyan','amber'];
function setSkin(value){const skin=SKINS.includes(value)?value:'violet';document.documentElement.dataset.skin=skin;$('skin').value=skin;try{localStorage.setItem('sonic-forge-skin',skin)}catch(_e){}if(!analyser)drawVisualIdle()}
$('skin').addEventListener('change',()=>setSkin($('skin').value));
try{setSkin(localStorage.getItem('sonic-forge-skin')||'violet')}catch(_e){setSkin('violet')}
document.addEventListener('keydown',event=>{const target=event.target;if(target?.closest('input,textarea,select,[contenteditable="true"]'))return;if(event.code==='Space'&&!event.repeat){event.preventDefault();if(timer)stop();else play()}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();$('save').click()}});
$('bpm').addEventListener('change',()=>{const el=$('bpm');el.value=Math.max(60,Math.min(200,Number(el.value)||132))});
window.addEventListener('pagehide',()=>{if(timer)stop()});

// Phase 10 controls: no hidden service or AI claim.
$('aiDetectBpm').addEventListener('click',analyzeSelectedClip);
$('aiSyncTempo').addEventListener('change',()=>{const e=selectedEntry();if(!e){$('aiSyncTempo').checked=false;msg('Selecciona un clip.');return}if($('aiSyncTempo').checked&&!e.track.detectedBpm){$('aiSyncTempo').checked=false;msg('Detecta primero el BPM del clip.');return}stop();e.track.syncTempo=$('aiSyncTempo').checked;aiTrack=e.track;drawClipLane();msg(e.track.syncTempo?'Sincronización temporal con conservación aproximada del tono activada.':'Tempo original restaurado.')});
$('aiSnap').addEventListener('change',()=>{const e=selectedEntry();if(e)e.track.snap=$('aiSnap').checked});
$('aiStartBar').addEventListener('change',()=>{const e=selectedEntry();if(!e)return;if(e.track.snap!==false){e.track.startBar=Math.max(0,Math.min(31,Math.round(e.track.startBar)));$('aiStartBar').value=e.track.startBar;drawClipLane()}});
refreshTempoUI();


// PHASE 13: reversible remix workbench. Snapshots retain decoded audio buffers in memory.
let remixSnapshot=null;
const REMIX_PRESETS={
 techhouse:{genre:'house',bpm:126,progression:'minimal',structure:['intro','groove','groove','build','drop','drop','break','outro'],seed:{KICK:[0,4,8,12],CLAP:[4,12],HAT:[2,6,10,14],OPEN:[6,14],BASS:[0,3,7,10,14],CHORD:[0,8]}},
 melodic:{genre:'techno',bpm:128,progression:'uplifting',structure:['intro','groove','build','drop','break','build','drop','outro'],seed:{KICK:[0,4,8,12],CLAP:[4,12],HAT:[2,6,10,14],OPEN:[7,15],BASS:[0,6,8,14],CHORD:[0,4,8,12]}},
 hard:{genre:'hard',bpm:150,progression:'driving',structure:['intro','build','drop','drop','break','build','drop','outro'],seed:{KICK:[0,4,8,12],CLAP:[4,12],HAT:[0,2,4,6,8,10,12,14],OPEN:[3,7,11,15],BASS:[0,2,4,7,8,10,12,15],CHORD:[0,8]}}
};
function snapshotRemix(){return {pattern:structuredClone(pattern),composer:structuredClone(composer),genre:$('genre').value,bpm:$('bpm').value,mixer:structuredClone(mixer),clips:audioClips.map(e=>({id:e.id,clip:e.clip,track:structuredClone(e.track)})),selection:selectedClipId,sequence:clipSequence};}
function restoreRemix(s){stop();pattern=structuredClone(s.pattern);composer=structuredClone(s.composer);mixer=structuredClone(s.mixer);audioClips=s.clips.map(e=>({id:e.id,clip:e.clip,track:structuredClone(e.track)}));selectedClipId=s.selection;clipSequence=s.sequence;const e=selectedEntry();aiClip=e?.clip||null;aiTrack=e?.track||{level:75,pan:0,mute:false,startBar:0,trimStart:0,trimEnd:0,fadeIn:0,fadeOut:0,pitchSemitones:0,syncTempo:false,snap:true};$('genre').value=s.genre;$('bpm').value=s.bpm;syncComposer();draw();drawMixer();syncAIControls();drawClipLane();}
function buildRemix(){const preset=REMIX_PRESETS[$('remixStyle').value];if(!preset)throw Error('Estilo no válido');const intensity=$('remixIntensity').value;if(!['balanced','energetic','minimal'].includes(intensity))throw Error('Intensidad no válida');const backup=snapshotRemix();try{stop();$('genre').value=preset.genre;$('bpm').value=preset.bpm;composer.progression=preset.progression;composer.structure=[...preset.structure];composer.energy=intensity==='energetic'?88:intensity==='minimal'?35:65;composer.variation=intensity==='energetic'?65:intensity==='minimal'?15:38;for(const [name] of TRACKS){const steps=preset.seed[name];pattern[name]=Array.from({length:16},(_,i)=>steps.includes(i));}if(intensity==='minimal'){for(const n of ['HAT','BASS','CHORD'])pattern[n]=pattern[n].map((on,i)=>on&&i%4===0);}else if(intensity==='energetic'){for(const i of [2,6,10,14])pattern.HAT[i]=true;pattern.OPEN[15]=true;}syncComposer();draw();drawClipLane();remixSnapshot=backup;$('remixUndo').disabled=false;$('remixStatus').textContent='REMIX · '+$('remixStyle').selectedOptions[0].textContent;msg('Remix creado. Los clips importados se conservan; puedes editar cada pista o deshacer los cambios.');}catch(err){restoreRemix(backup);throw err;}}
$('remixBuild').addEventListener('click',()=>{try{buildRemix()}catch(e){msg('Error de remix: '+e.message)}});
$('remixUndo').addEventListener('click',()=>{if(!remixSnapshot)return;const previous=remixSnapshot;remixSnapshot=null;restoreRemix(previous);$('remixUndo').disabled=true;$('remixStatus').textContent='RESTAURADO';msg('Se ha restaurado el estado anterior al último remix.')});
$('remixDuplicate').addEventListener('click',()=>{const e=selectedEntry();if(!e){msg('Importa y selecciona primero un clip de audio.');return}if(audioClips.length>=12){msg('Límite de 12 clips alcanzado.');return}stop();rememberSelection();const track=structuredClone(e.track);track.startBar=Math.min(31,track.startBar+4);const added={id:++clipSequence,clip:e.clip,track};audioClips.push(added);selectedClipId=added.id;aiClip=added.clip;aiTrack=added.track;syncAIControls();drawClipLane();msg('Clip duplicado en el compás '+(track.startBar+1)+'. Ajusta su posición y mezcla de forma independiente.')});

// Mastering control panel: local processing, not calibrated commercial loudness metering.
for(const key of ['low','mid','high','threshold','ratio','ceiling'])$('master_'+key).addEventListener('input',()=>{mastering[key]=Number($('master_'+key).value);$('master_'+key+'_value').textContent=mastering[key];updateLiveMaster()});
$('master_enabled').addEventListener('change',()=>{mastering.enabled=$('master_enabled').checked;updateLiveMaster()});
$('master_preset').addEventListener('change',()=>{const choice=$('master_preset').value;mastering={...MASTER_PRESETS[choice],enabled:true};drawMaster();updateLiveMaster();msg('Preset de masterización aplicado: '+choice)});
$('master_analyze').addEventListener('click',async()=>{const b=$('master_analyze');b.disabled=true;try{const result=await renderOffline(),m=audioMetrics(result.audio);$('master_metrics').textContent='Pico: '+m.peak+' · RMS: '+m.rms+' · Análisis del render final';if(m.peakValue>=.999)$('master_metrics').textContent+=' · AVISO: picos al límite digital';}catch(e){$('master_metrics').textContent='Análisis fallido: '+e.message}finally{b.disabled=false}});
$('master_compare').addEventListener('click',async()=>{const b=$('master_compare');b.disabled=true;try{const before=audioMetrics((await renderOffline(null,true)).audio),after=audioMetrics((await renderOffline()).audio);$('master_metrics').textContent='Sin master: pico '+before.peak+', RMS '+before.rms+' | Con master: pico '+after.peak+', RMS '+after.rms} catch(e){$('master_metrics').textContent='Comparación fallida: '+e.message}finally{b.disabled=false}});
drawMaster();
