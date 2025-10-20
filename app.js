'use strict';

(() => {
  const $=(id)=>document.getElementById(id);
  const $$=(sel)=>document.querySelectorAll(sel);
  const refs={
    fileInput:$('file-input'),
    browseBtn:$('browse-btn'),
    dropZone:$('drop-zone'),
    fileMeta:$('file-meta'),
    saverName:$('saver-name'),
    bundleId:$('bundle-id'),
    buildBtn:$('build-btn'),
    progress:$('progress'),
    status:$('status'),
    log:$('log'),
    downloads:$('downloads'),
    bundleLink:$('bundle-link'),
    installerLink:$('installer-link'),
    templateStatus:$('template-status'),
  };

  const TEMPLATE_URL='templates/VideoSaverTemplate.saver.zip';
  const WARN_SIZE=500*1024*1024;
  const sanitize=(value)=>(value||'').replace(/[^A-Za-z0-9 _.-]+/g,'').trim();
  const formatBytes=(bytes)=>{
    if(!bytes) return '0 B';
    const sizes=['B','KB','MB','GB','TB'];
    const pow=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),sizes.length-1);
    const val=bytes/1024**pow;
    return `${val.toFixed(val>=10||pow===0?0:1)} ${sizes[pow]}`;
  };
  const getMode=()=>document.querySelector('input[name="transcode"]:checked')?.value??'auto';
  const appendLog=(msg)=>{refs.log.textContent+=`[${new Date().toLocaleTimeString()}] ${msg}\n`;refs.log.scrollTop=refs.log.scrollHeight;};
  const clearLog=()=>{refs.log.textContent='';};
  const setProgress=(value)=>{refs.progress.value=Math.max(0,Math.min(1,value));};
  const setStatus=(message,error=false)=>{refs.status.textContent=message;refs.status.classList.toggle('error',error);};
  const setBusy=(state)=>{
    refs.buildBtn.disabled=state;
    refs.browseBtn.disabled=state;
    $$('input[name="transcode"]').forEach((node)=>{node.disabled=state;});
    refs.saverName.disabled=state;
    refs.bundleId.disabled=state;
  };
  const clearDownloads=()=>{
    refs.downloads.hidden=true;
    if(bundleURL) URL.revokeObjectURL(bundleURL);
    if(installerURL) URL.revokeObjectURL(installerURL);
    bundleURL=installerURL=null;
    refs.bundleLink.removeAttribute('href');
    refs.installerLink.removeAttribute('href');
  };

  let selectedFile=null;
  let bundleURL=null;
  let installerURL=null;

  const worker=new Worker('ffmpeg-worker.js');
  const pending=new Map();
  let requestId=0;

  worker.onmessage=({data})=>{
    const {id,type,payload}=data;
    if(type==='progress') return setProgress(payload.ratio??0);
    if(type==='log') return appendLog(payload.message);
    const job=pending.get(id);
    if(!job){if(type==='error') setStatus(payload.message||'FFmpeg worker error.',true);return;}
    type==='result'?job.resolve(payload):job.reject(new Error(payload.message));
    pending.delete(id);
  };
  worker.onerror=(error)=>{console.error(error);setStatus('FFmpeg worker crashed. See console.',true);};

  const callWorker=(action,payload,transfer=[])=>new Promise((resolve,reject)=>{
    const id=requestId++;
    pending.set(id,{resolve,reject});
    try{worker.postMessage({id,action,payload},transfer);}catch(error){pending.delete(id);reject(error);}
  });

  refs.browseBtn.addEventListener('click',()=>refs.fileInput.click());
  refs.fileInput.addEventListener('change',()=>{if(refs.fileInput.files.length) onFileSelected(refs.fileInput.files[0]);});
  refs.dropZone.addEventListener('dragover',(event)=>{event.preventDefault();refs.dropZone.classList.add('dragover');});
  refs.dropZone.addEventListener('dragleave',()=>refs.dropZone.classList.remove('dragover'));
  refs.dropZone.addEventListener('drop',(event)=>{
    event.preventDefault();
    refs.dropZone.classList.remove('dragover');
    const file=event.dataTransfer?.files?.[0];
    if(!file) return;
    refs.fileInput.files=event.dataTransfer.files;
    onFileSelected(file);
  });
  refs.buildBtn.addEventListener('click',()=>{
    if(!selectedFile) return setStatus('Select a video first.',true);
    void buildSaver().catch((error)=>{console.error(error);setStatus(error.message||'Build failed.',true);setBusy(false);});
  });

  (()=>{
    const stub=Math.random().toString(36).slice(2,7);
    refs.bundleId.value=`local.videosaver.${stub}`;
    fetch(TEMPLATE_URL,{method:'HEAD'})
      .then((res)=>{refs.templateStatus.textContent=res.ok?'Template detected. Ready to build.':'Template missing. Place VideoSaverTemplate.saver.zip under /templates/.';})
      .catch(()=>{refs.templateStatus.textContent='Template missing. Place VideoSaverTemplate.saver.zip under /templates/.';refs.templateStatus.classList.add('warning');});
    if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((err)=>console.warn('Service worker registration failed',err));
  })();

  function onFileSelected(file){
    selectedFile=file;
    refs.fileMeta.textContent=`${file.name} • ${formatBytes(file.size)}`;
    if(file.size>WARN_SIZE) appendLog('Large file detected. Passthrough may be faster if codecs already match.');
    clearDownloads();
  }

  async function buildSaver(){
    setBusy(true);
    clearLog();
    setProgress(0);
    setStatus('Fetching template…');

    const response=await fetch(TEMPLATE_URL);
    if(!response.ok) throw new Error('Template missing. Place VideoSaverTemplate.saver.zip under /templates/.');
    const templateZip=await JSZip.loadAsync(await response.arrayBuffer());
    const root=findBundleRoot(templateZip);
    if(!root) throw new Error('Template missing .saver root folder.');

    const saverName=sanitize(refs.saverName.value)||'MySaver';
    const bundleId=refs.bundleId.value.trim()||`local.videosaver.${Date.now()}`;
    const newRoot=`${saverName}.saver/`;
    const infoPath=`${root}Contents/Info.plist`;
    const mp4Path=`${root}Contents/Resources/payload.mp4`;
    const movPath=`${root}Contents/Resources/payload.mov`;
    const infoFile=templateZip.file(infoPath);
    if(!infoFile) throw new Error('Info.plist not found in template.');
    templateZip.remove(mp4Path);
    templateZip.remove(movPath);

    const buffer=await selectedFile.arrayBuffer();
    let videoBytes=new Uint8Array(buffer);
    let transcoded=false;
    const mode=getMode();

    if(mode==='force'){videoBytes=await transcode(buffer);transcoded=true;}
    else if(mode==='auto'){
      const probe=await analyse(buffer);
      appendLog(`Detected format=${probe.format||'unknown'} video=${probe.videoCodec||'unknown'} audio=${probe.audioCodec||'unknown'}`);
      if(!probe.isCompatible){appendLog('Transcoding required.');videoBytes=await transcode(buffer);transcoded=true;}
      else appendLog('Source already compatible; skipping transcode.');
    } else appendLog('Passthrough selected.');

    setStatus('Updating bundle…');
    templateZip.file(mp4Path,videoBytes,{binary:true});
    const plist=await infoFile.async('string');
    templateZip.file(infoPath,patchPlist(plist,{CFBundleName:saverName,CFBundleIdentifier:bundleId}));

    const saverZip=await rebase(templateZip,root,newRoot);
    const bundleBlob=await saverZip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});
    const installerZip=await createInstaller(saverZip,newRoot.slice(0,-1));
    const installerBlob=await installerZip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});

    setDownloads(bundleBlob,`${saverName}.saver.zip`,installerBlob,`${saverName}-install.zip`);
    appendLog(transcoded?'Transcoding complete.':'Video embedded without transcoding.');
    appendLog(`Saved bundle as ${saverName}.saver`);
    appendLog('Install path: ~/Library/Screen Savers/');
    setStatus('Done! Grab your downloads below.');
    setProgress(1);
    setBusy(false);
  }

  async function analyse(buffer){
    const copy=buffer.slice(0);
    return callWorker('probe',{buffer:copy,name:`probe-${Date.now()}`},[copy]);
  }

  async function transcode(buffer){
    setStatus('Transcoding with ffmpeg.wasm…');
    const copy=buffer.slice(0);
    const {buffer:out}=await callWorker('transcode',{buffer:copy,name:`input-${Date.now()}`},[copy]);
    setProgress(0.95);
    return new Uint8Array(out);
  }

  function setDownloads(bundleBlob,bundleName,installerBlob,installerName){
    clearDownloads();
    bundleURL=URL.createObjectURL(bundleBlob);
    installerURL=URL.createObjectURL(installerBlob);
    Object.assign(refs.bundleLink,{href:bundleURL,download:bundleName});
    Object.assign(refs.installerLink,{href:installerURL,download:installerName});
    refs.downloads.hidden=false;
  }

  async function createInstaller(bundleZip,rootName){
    const zip=new JSZip();
    for(const [path,entry] of Object.entries(bundleZip.files)){
      if(entry.dir) zip.folder(path);
      else zip.file(path,await entry.async('uint8array'),{binary:true});
    }
    zip.file('install.command',installerScript(rootName),{unixPermissions:0o755});
    return zip;
  }

  const installerScript=(name)=>`#!/usr/bin/env bash
set -euo pipefail
NAME="\${1:-${name}}"
SRC="$(cd "$(dirname "$0")" && pwd)/$NAME"
DST="$HOME/Library/Screen Savers"
mkdir -p "$DST"
cp -R "$SRC" "$DST/"
echo "Installed to: $DST/$NAME"
open "$DST"
`;

  function patchPlist(text,values){
    const doc=new DOMParser().parseFromString(text,'application/xml');
    if(doc.getElementsByTagName('parsererror').length) throw new Error('Invalid Info.plist XML.');
    const dict=doc.querySelector('plist > dict');
    if(!dict) throw new Error('Info.plist missing <dict>.');
    for(const [key,value] of Object.entries(values)) upsertKey(doc,dict,key,value);
    return new XMLSerializer().serializeToString(doc);
  }

  function upsertKey(doc,dict,key,value){
    for(const node of dict.children){
      if(node.tagName==='key'&&node.textContent===key){
        const sibling=node.nextElementSibling;
        if(sibling&&sibling.tagName==='string') sibling.textContent=value;
        else{const str=doc.createElement('string');str.textContent=value;dict.insertBefore(str,sibling);}
        return;
      }
    }
    const keyNode=doc.createElement('key');keyNode.textContent=key;
    const strNode=doc.createElement('string');strNode.textContent=value;
    dict.append(keyNode,strNode);
  }

  function findBundleRoot(zip){
    const roots=new Set();
    Object.keys(zip.files).forEach((path)=>{const head=path.split('/')[0];if(head&&head.endsWith('.saver')) roots.add(`${head}/`);});
    return roots.size===1?roots.values().next().value:null;
  }

  async function rebase(zip,oldRoot,newRoot){
    if(oldRoot===newRoot) return zip;
    const clone=new JSZip();
    for(const [path,entry] of Object.entries(zip.files)){
      const target=path.startsWith(oldRoot)?newRoot+path.slice(oldRoot.length):path;
      if(entry.dir) clone.folder(target);
      else clone.file(target,await entry.async('uint8array'),{binary:true});
    }
    return clone;
  }
})();
