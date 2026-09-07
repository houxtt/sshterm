const { ROOT, app, section, context, startService } = require('./probes.cjs');
const fs=require('fs'),path=require('path');const results=[];
function record(id,evidence){results.push({id,evidence});console.log(JSON.stringify({id,evidence}));}
async function main(){
  let tick;const sent=[];const elements=Object.fromEntries(['btn-tm-cancel','dlg-timer-mask','btn-tm-start','tm-content','tm-interval','tm-hex','btn-tm-stop'].map(id=>[id,{value:'',classList:{add:()=>{}}}]));
  elements['tm-content'].value='DEVICE_COMMAND';elements['tm-interval'].value='1000';
  const timer=context(section(app,'let _timerHandle = null;','// ---------- 快捷命令'),{$:id=>elements[id],tabs:[{id:1,state:'connected'},{id:2,state:'connected'}],activeTabId:1,setStatus:()=>{},log:()=>{},setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{},sendInput:(id,s)=>sent.push({id,s})});
  elements['btn-tm-start'].onclick();timer.activeTabId=2;tick();record('TIMER_TARGET_CHANGED',sent);
  const inputSent=[];const display=context(section(app,'function handleUserInput(','\nfunction pickDisplayPaths'),{pickDisplayPaths:s=>[s],displaySequence:()=>{},safeSendInput:(id,s)=>inputSent.push(s)});
  const t={id:1,imageAddon:{},term:{write:()=>{}}};display.handleUserInput(t,'display /tmp/a.png');display.handleUserInput(t,'\r');record('DISPLAY_PENDING_REMOTE_LINE',inputSent);
  const service=await startService();let browser;
  try{
    const puppeteer=require(path.join(ROOT,'node_modules/puppeteer-core'));browser=await puppeteer.launch({executablePath:require(path.join(ROOT,'tests/browser_path'))(ROOT),headless:true,args:['--no-sandbox','--disable-gpu'],userDataDir:path.join(service.profile,'browser')});
    const a=await browser.newPage(),b=await browser.newPage();for(const p of[a,b]){await p.goto(`http://127.0.0.1:${service.port}/`);await p.waitForFunction(()=>typeof newTab==='function'&&ws.readyState===1);}
    await a.evaluate(()=>newTab({type:'audit-only',name:'WINDOW_A'},{connect:false}));await b.evaluate(()=>newTab({type:'audit-only',name:'WINDOW_B'},{connect:false}));
    record('MULTIWINDOW_STORAGE',await a.evaluate(()=>({visible:tabs.map(t=>t.cfg.name),saved:JSON.parse(localStorage.getItem(LS_TABS)).map(t=>t.cfg.name)})));
    record('REPLAY_AUTO_RECONNECT',await a.evaluate(()=>{
      const t=newTab({type:'ssh',name:'readonly replay',host:'audit.invalid'},{connect:false});setTabState(t.id,'closed','readonly');saveTabs();
      const saved=JSON.parse(localStorage.getItem(LS_TABS)).find(x=>x.id===t.id);return {savedConfig:saved.cfg,persistedConnectFlag:saved.connect??null};
    }));
  }finally{if(browser)await browser.close();await service.stop();}
}
main().catch(e=>{record('PROBE_ERROR',e.stack);process.exitCode=1;}).finally(()=>fs.writeFileSync(path.join(__dirname,'ui-results.json'),JSON.stringify(results,null,2)+'\n'));
