'use strict';

const CACHE='video-saver-v3';
const ASSETS=['./','styles.css','app.js','ffmpeg-worker.js','lib/jszip.min.js','lib/regenerator-runtime.min.js','lib/ffmpeg.min.js','lib/ffmpeg-core.js','lib/ffmpeg-core.worker.js','lib/ffmpeg-core.wasm','templates/VideoSaverTemplate.saver.zip'];

self.addEventListener('install',(event)=>{
  event.waitUntil(caches.open(CACHE).then(async(cache)=>{
    for(const url of ASSETS){
      try{await cache.add(url);}catch(error){console.warn('[sw] skip',url,error);}
    }
  }).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',(event)=>{
  event.waitUntil(caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key!==CACHE).map((key)=>caches.delete(key)))).then(()=>self.clients.claim()));
});

self.addEventListener('fetch',(event)=>{
  const { request }=event;
  if(request.method!=='GET') return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin) return;

  if(request.mode==='navigate'){
    event.respondWith(fetch(request).then((response)=>{
      const clone=response.clone();
      caches.open(CACHE).then((cache)=>cache.put(request,clone));
      return response;
    }).catch(()=>caches.match('index.html')));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached)=>cached||fetch(request).then((response)=>{
      if(!response||response.status!==200||response.type!=='basic') return response;
      const clone=response.clone();
      caches.open(CACHE).then((cache)=>cache.put(request,clone));
      return response;
    }))
  );
});
