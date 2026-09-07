const {ROOT, app, serverCode, context, section, listen, startService, socketFor, sleep} = require('./probes.cjs');
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),zlib=require('zlib');
const {EventEmitter,once}=require('events');const {PassThrough}=require('stream');const {spawn}=require('child_process');
const results=[];function record(id,evidence){results.push({id,evidence});console.log(JSON.stringify({id,evidence}));}
async function main(){
  const sshCode=fs.readFileSync(path.join(ROOT,'server/connections/ssh.js'),'utf8');
  class FakeClient extends EventEmitter {connect(){setImmediate(()=>this.emit('close',false));}}
  const c=context(sshCode,{process,module:{exports:{}},queueMicrotask,require:n=>n==='ssh2'?{Client:FakeClient}:n==='./base'?require(path.join(ROOT,'server/connections/base')):require(n)});
  const conn=new c.module.exports({host:'fake',password:'fake'});conn.on('error',()=>{});let settled=false;
  conn.connect().then(()=>settled=true,()=>settled=true);await sleep(30);record('SSH_PRE_READY_CLOSE',{state:conn.state,promiseSettled:settled});
  const SSH=require(path.join(ROOT,'server/connections/ssh'));const detached=new SSH({});let cleaned=0;
  detached._tunnels=new Map([[1,{server:{close:()=>cleaned++}}]]);detached._emitClose('remote disconnect');detached.close();record('SSH_REMOTE_CLOSE_CLEANUP',{tunnelListenersClosed:cleaned});
  const sf=new SSH({});sf.getSftp=async()=>({readdir:(p,cb)=>cb(new Error('permission denied'))});record('ZIP_SCAN_FAILURE',await sf.sftpCollectFiles('/unreadable'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sshterm-zip-audit-'));fs.mkdirSync(path.join(dir,'folder'));
  for(let i=0;i<3;i++)fs.writeFileSync(path.join(dir,'folder',`${i}.bin`),Buffer.alloc(2*1024*1024,65+i));
  const service=await startService(false,{SSHTERM_TEST_SFTP_ROOT:dir});
  try{
    const url=`http://127.0.0.1:${service.port}/api/sftp/download-dir?conn=9900&path=folder&token=${service.token}`;
    const res=await fetch(url,{headers:{'X-SSHTERM-Token':service.token},signal:AbortSignal.timeout(15000)});const zip=Buffer.from(await res.arrayBuffer());
    const entries=[];let pos=zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
    while(pos>=0&&pos+46<zip.length&&zip.readUInt32LE(pos)===0x02014b50){
      const method=zip.readUInt16LE(pos+10),compressed=zip.readUInt32LE(pos+20),nameLen=zip.readUInt16LE(pos+28),extra=zip.readUInt16LE(pos+30),comment=zip.readUInt16LE(pos+32),local=zip.readUInt32LE(pos+42);
      const name=zip.subarray(pos+46,pos+46+nameLen).toString();const start=local+30+zip.readUInt16LE(local+26)+zip.readUInt16LE(local+28);const raw=zip.subarray(start,start+compressed);const data=method===8?zlib.inflateRawSync(raw):raw;
      entries.push({name,actualBytes:data.length,expectedBytes:2*1024*1024});pos+=46+nameLen+extra+comment;
    }
    record('ZIP_MULTI_LARGE',entries);
    // Same profile and occupied port: second launch must not change a live service's token.
    const second=spawn(process.execPath,['server/index.js','--port',String(service.port),'--no-open'],{cwd:ROOT,env:{...process.env,USERPROFILE:service.profile,HOME:service.profile},windowsHide:true,stdio:'ignore'});
    await once(second,'exit');const token=fs.readFileSync(path.join(service.profile,'.sshterm/token'),'utf8');
    const denied=await fetch(`http://127.0.0.1:${service.port}/bootstrap.js`,{headers:{'X-SSHTERM-Token':token}});
    record('DUPLICATE_START_TOKEN',{secondExit:second.exitCode,tokenOverwritten:token!==service.token,newFileTokenStatus:denied.status});
  }finally{await service.stop();}
  const proxyServer=net.createServer(s=>{s.on('error',()=>{});s.once('data',()=>s.write('HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-audit\r\n'));});const pport=await listen(proxyServer);let proxySocket;
  try{proxySocket=await require(path.join(ROOT,'server/connections/proxy')).connectProxy({host:'fake',port:22},{type:'http',host:'127.0.0.1',port:pport});let received='';proxySocket.on('data',b=>received+=b);await sleep(50);record('HTTP_PROXY_BANNER',{received,expected:'SSH-2.0-audit\r\n'});}finally{proxySocket?.destroy();proxyServer.close();}
  const tunnel=new SSH({});tunnel.client={forwardOut:(a,b,c,d,cb)=>cb(null,new PassThrough())};
  const portHolder=net.createServer();const tport=await listen(portHolder);await new Promise(r=>portHolder.close(r));
  const item=await tunnel.addTunnel({type:'dynamic',localPort:tport});const sock=net.connect({host:'127.0.0.1',port:tport});sock.on('error',()=>{});await once(sock,'connect');sock.write(Buffer.from([5,1,0]));await once(sock,'data');sock.write(Buffer.from([5,1,0,1,127,0,0,1,0,22]));await once(sock,'data');
  const started=Date.now();await Promise.race([once(sock,'close'),sleep(16500)]);record('SOCKS_IDLE',{closed:sock.destroyed,idleMs:Date.now()-started});sock.destroy();tunnel.removeTunnel(item.id);
}
main().catch(e=>{record('PROBE_ERROR',e.stack);process.exitCode=1;}).finally(()=>fs.writeFileSync(path.join(__dirname,'lifecycle-results.json'),JSON.stringify(results,null,2)+'\n'));
