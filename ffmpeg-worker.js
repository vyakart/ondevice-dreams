'use strict';

self.window=self;

if(typeof self.document==='undefined'){
  const dummyNode={
    setAttribute(){},
    addEventListener(){},
    removeEventListener(){},
    appendChild(){},
    removeChild(){},
  };
  self.document={
    createElement(){ return { ...dummyNode }; },
    getElementsByTagName(){ return [{ ...dummyNode }]; },
  };
}

let ffmpeg,loading;
let bootstrapError;

const formatBootstrapError=(error)=>{
  if(!error) return 'FFmpeg bootstrap failed.';
  const message=typeof error.message==='string'?error.message:String(error);
  return message.startsWith('FFmpeg bootstrap failed')?message:`FFmpeg bootstrap failed: ${message}`;
};

const signalBootstrapError=(error)=>{
  const message=formatBootstrapError(error);
  bootstrapError=message;
  try{postMessage({id:-1,type:'error',payload:{message}});}catch(_){/* ignore */ }
};

try{
  importScripts('lib/regenerator-runtime.min.js','lib/ffmpeg.min.js');
  if(!self.FFmpeg||typeof self.FFmpeg.createFFmpeg!=='function'){
    signalBootstrapError(new Error('FFmpeg loader not available.'));
  }
}catch(error){
  signalBootstrapError(error);
}

self.onmessage=({data})=>{
  const{ id,action,payload }=data;
  handle(id,action,payload).catch((error)=>postMessage({id,type:'error',payload:{message:error.message||String(error)}}));
};

const ensureFFmpeg=async()=>{
  if(bootstrapError) throw new Error(bootstrapError);
  if(ffmpeg) return ffmpeg;
  if(!self.FFmpeg||typeof self.FFmpeg.createFFmpeg!=='function'){
    const message=formatBootstrapError(new Error('FFmpeg loader not available.'));
    bootstrapError=message;
    throw new Error(message);
  }
  if(!loading){
    ffmpeg=self.FFmpeg.createFFmpeg({log:false,corePath:'lib/ffmpeg-core.js',workerPath:'lib/ffmpeg-core.worker.js'});
    loading=ffmpeg.load().catch((error)=>{
      const message=formatBootstrapError(error);
      bootstrapError=message;
      throw new Error(message);
    });
  }
  await loading;
  return ffmpeg;
};

async function handle(id,action,payload){
  await ensureFFmpeg();
  if(action==='probe') return probe(id,payload);
  if(action==='transcode') return transcode(id,payload);
  if(action==='remux') return remux(id,payload);
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
  const base=['-i',input,'-map','0:v:0','-c:v','libx264','-crf',payload?.crf?.toString()||'20','-preset',payload?.preset||'medium','-pix_fmt','yuv420p','-movflags','+faststart'];
  const audioArgs=payload?.hasAudio===false?['-an']:['-map','0:a:0?','-c:a','aac','-b:a',payload?.audioBitrate||'128k'];
  try{
    await ffmpeg.run(...base,...audioArgs,output);
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

async function remux(id,payload){
  const input=`${payload?.name||'input'}.src`;
  const output='payload.mp4';
  const buffer=payload?.buffer;
  if(!buffer) throw new Error('Remux payload missing buffer.');
  ffmpeg.FS('writeFile',input,new Uint8Array(buffer));
  const prevLogger=ffmpeg.setLogger(({message})=>postMessage({id,type:'log',payload:{message}}));
  const prevProgress=ffmpeg.setProgress(({ratio})=>postMessage({id,type:'progress',payload:{ratio:Math.min(0.6,ratio)}}));
  const args=['-i',input,'-map','0:v:0','-c:v','copy'];
  if(payload?.hasAudio===false) args.push('-an');
  else args.push('-map','0:a:0?','-c:a','copy');
  args.push('-movflags','+faststart','-f','mp4');
  try{
    await ffmpeg.run(...args,output);
    const out=ffmpeg.FS('readFile',output);
    postMessage({id,type:'result',payload:{buffer:out.buffer}},[out.buffer]);
  }catch(error){
    throw new Error(`FFmpeg remux failed: ${error?.message||error}`);
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
  const normalized=(format||'').toLowerCase();
  const container=normalized.split(',').map((part)=>part.trim())[0]||null;
  const hasMp4Like=/\bmp4\b|\bm4v\b|\bisom\b/.test(normalized);
  const videoOK=videoCodec?/h\.?264|avc1/i.test(videoCodec):false;
  const audioOK=!audioCodec||/aac|mp4a/i.test(audioCodec);
  const containerOK=hasMp4Like;
  const copySafe=containerOK&&videoOK&&audioOK;
  return{
    format,
    container,
    videoCodec,
    audioCodec,
    hasAudio:Boolean(audioCodec),
    containerOK,
    videoOK,
    audioOK,
    copySafe,
    isCompatible:Boolean(copySafe),
  };
}

const codec=(line,marker)=>{
  const idx=line.indexOf(marker);
  return idx===-1?null:line.slice(idx+marker.length).split(',')[0].trim();
};

const safeUnlink=(path)=>{
  try{ffmpeg.FS('unlink',path);}catch(_){/* ignore */ }
};
