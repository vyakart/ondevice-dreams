'use strict';

try{importScripts('lib/ffmpeg.min.js');}catch(_){postMessage({id:-1,type:'error',payload:{message:'Missing ffmpeg.min.js in /lib/.'}});}

let ffmpeg,loading;

self.onmessage=({data})=>{
  const{ id,action,payload }=data;
  handle(id,action,payload).catch((error)=>postMessage({id,type:'error',payload:{message:error.message||String(error)}}));
};

const ensureFFmpeg=async()=>{
  if(ffmpeg) return ffmpeg;
  if(!self.FFmpeg||typeof self.FFmpeg.createFFmpeg!=='function') throw new Error('FFmpeg loader not available.');
  if(!loading){
    ffmpeg=self.FFmpeg.createFFmpeg({log:false,corePath:'lib/ffmpeg-core.js',workerPath:'lib/ffmpeg-core.worker.js'});
    loading=ffmpeg.load();
  }
  await loading;
  return ffmpeg;
};

async function handle(id,action,payload){
  await ensureFFmpeg();
  if(action==='probe') return probe(id,payload);
  if(action==='transcode') return transcode(id,payload);
  throw new Error(`Unknown action: ${action}`);
}

async function probe(id,payload){
  const name=`${payload?.name||'probe'}.bin`;
  const buffer=payload?.buffer;
  if(!buffer) throw new Error('Probe payload missing buffer.');
  ffmpeg.FS('writeFile',name,new Uint8Array(buffer));
  const lines=[];
  const prevLogger=ffmpeg.setLogger(({type,message})=>{if(type==='fferr'||type==='info') lines.push(message);});
  try{await ffmpeg.run('-hide_banner','-i',name);}catch(_){/* expected */}finally{ffmpeg.setLogger(prevLogger);safeUnlink(name);}
  postMessage({id,type:'result',payload:analyse(lines.join('\n'))});
}

async function transcode(id,payload){
  const input=`${payload?.name||'input'}.src`;
  const output='payload.mp4';
  const buffer=payload?.buffer;
  if(!buffer) throw new Error('Transcode payload missing buffer.');
  ffmpeg.FS('writeFile',input,new Uint8Array(buffer));
  const prevLogger=ffmpeg.setLogger(({message})=>postMessage({id,type:'log',payload:{message}}));
  const prevProgress=ffmpeg.setProgress(({ratio})=>postMessage({id,type:'progress',payload:{ratio:Math.min(0.95,ratio)}}));
  try{
    await ffmpeg.run('-i',input,'-c:v','libx264','-crf','20','-preset','medium','-pix_fmt','yuv420p','-movflags','+faststart','-c:a','aac','-b:a','128k',output);
    const out=ffmpeg.FS('readFile',output);
    postMessage({id,type:'result',payload:{buffer:out.buffer}},[out.buffer]);
  }catch(error){
    throw new Error(`FFmpeg transcode failed: ${error?.message||error}`);
  }finally{
    ffmpeg.setLogger(prevLogger);
    ffmpeg.setProgress(prevProgress);
    safeUnlink(input);
    safeUnlink(output);
  }
}

function analyse(text){
  const lines=text.split('\n').map((line)=>line.trim());
  const input=lines.find((line)=>line.startsWith('Input #0'));
  const video=lines.find((line)=>line.includes('Stream #0:0')&&line.includes('Video:'));
  const audio=lines.find((line)=>line.includes('Stream #0:')&&line.includes('Audio:'));
  const format=input&&/Input #0,\s*([^,]+)/.exec(input)?.[1];
  const videoCodec=video&&codec(video,'Video:');
  const audioCodec=audio&&codec(audio,'Audio:');
  const isMp4=format?/mp4|mov|m4v|isom/i.test(format):false;
  const videoOK=videoCodec?/h\.?264|avc1/i.test(videoCodec):false;
  const audioOK=!audioCodec||/aac|mp4a/i.test(audioCodec);
  return{format,videoCodec,audioCodec,isCompatible:Boolean(isMp4&&videoOK&&audioOK)};
}

const codec=(line,marker)=>{
  const idx=line.indexOf(marker);
  return idx===-1?null:line.slice(idx+marker.length).split(',')[0].trim();
};

const safeUnlink=(path)=>{
  try{ffmpeg.FS('unlink',path);}catch(_){/* ignore */ }
};
