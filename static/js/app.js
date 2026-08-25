(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const LANG = {py:'python',js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',java:'java',c:'c',cc:'cpp',cpp:'cpp',cxx:'cpp',cs:'csharp',go:'go',rs:'rust',php:'php',rb:'ruby',swift:'swift',kt:'kotlin',kts:'kotlin',html:'html',css:'css',json:'json',sql:'sql',md:'markdown',yaml:'yaml',yml:'yaml',txt:'plaintext'};
  const PROFILE = {
    python:['🐍','Python','Tracebacks, tests and AI debugging.','Run'], javascript:['JS','JavaScript','Browser/web editing or Node execution.','Run'], typescript:['TS','TypeScript','Typed editing and web-aware diagnostics.','Run'],
    html:['<>','HTML','Live web workspace with browser output.','Web'], css:['#','CSS','Stylesheet editing and diagnostics.','Analyze'], json:['{}','JSON','Validation-focused structured data.','Validate'], sql:['SQL','SQL','Query review and optimization workspace.','Analyze'],
    java:['☕','Java','Compile and runtime diagnostics.','Run'], c:['C','C','Compiler diagnostics and build/run feedback.','Run'], cpp:['C++','C++','Compiler diagnostics and build/run feedback.','Run'], go:['Go','Go','Build, run and test feedback.','Run'], rust:['🦀','Rust','Compiler and ownership diagnostics.','Run'], php:['PHP','PHP','Runtime diagnostics.','Run'], ruby:['Rb','Ruby','Runtime diagnostics.','Run'], csharp:['C#','C#','.NET diagnostics.','Run'], swift:['Swift','Swift','Compiler/runtime diagnostics.','Run'], kotlin:['Kt','Kotlin','JVM diagnostics.','Run'], markdown:['M↓','Markdown','Documentation workspace.','Analyze'], yaml:['Y','YAML','Configuration validation workspace.','Validate'], plaintext:['TXT','Text','Plain text workspace.','Analyze']
  };
  const EXECUTABLE = new Set(['python','javascript','typescript','php','ruby','go','rust','c','cpp','java','swift']);
  const state = {files:new Map(),active:null,editor:null,monaco:null,detected:null,output:null,analysis:null,history:[],events:[],timer:null,debounce:800,running:false,theme:'dark',viewport:'desktop',codeAiMode:'improve',pendingAi:null};
  const sample = `def calculate_total(items):\n    total = 0\n    for item in items:\n        if item is None:\n            continue\n        total += item.price\n    return tot\n\nprint(calculate_total([]))\n`;
  const current = () => state.active ? state.files.get(state.active) : null;
  const lang = name => LANG[(name.split('.').pop() || '').toLowerCase()] || 'plaintext';
  const isHtmlWorkspace = () => current()?.language === 'html';
  const setStatus = (text,kind='ready') => { $('statusText').textContent=text; $('statusDot').className='status-dot '+kind; };
  const event = (type,detail,kind='') => { state.events.unshift({time:new Date().toLocaleTimeString(),type,detail,kind}); state.events=state.events.slice(0,100); if(document.querySelector('.panel-tab.active')?.dataset.panel==='output') renderPanel('output'); };
  const addHistory = (label,detail) => { state.history.unshift({time:new Date().toLocaleTimeString(),label,detail}); state.history=state.history.slice(0,50); };

  function updateContext(){
    const f=current(), p=PROFILE[f?.language]||PROFILE.plaintext, d=state.detected||{};
    $('workspaceName').textContent=f?f.name:'Untitled workspace'; $('fileStatus').textContent=f?f.name:'No file'; $('languageIcon').textContent=p[0]; $('languageTitle').textContent=p[1]; $('frameworkText').textContent=d.framework?` · ${d.framework}`:'';
    $('languageState').textContent=d.runtime_available===false?'Runtime unavailable':(isHtmlWorkspace()?'Web':'Ready');
    $('runtimePill').textContent=f?(d.framework?`${d.framework} · ${p[1]}`:p[1]):'No file';
    const run=$('runBtn'); run.textContent=f?p[3]:'Run'; run.classList.toggle('hidden',!f||isHtmlWorkspace()); run.disabled=!f;
    $('app').classList.toggle('has-file',!!f); $('app').classList.toggle('has-web',!!f&&isHtmlWorkspace());
  }
  async function detect(){
    const f=current(); if(!f)return;
    try { const files={}; state.files.forEach((v,k)=>files[k]=v.content.slice(0,100000)); const r=await fetch('/runtime/detect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:f.name,files})}); state.detected=await r.json(); }
    catch { state.detected=null; }
    updateContext();
  }
  function setEditorLanguage(){ if(!state.editor)return; const f=current(); state.monaco.editor.setModelLanguage(state.editor.getModel(),f?.language||'plaintext'); }
  function resetFileState(){ state.output=null; state.analysis=null; state.events=[]; renderPanel('output'); }
  function openFile(name,content){
    const existing=state.files.get(name); const f={name,content,original:existing?.original??content,language:lang(name),dirty:false}; f.dirty=f.content!==f.original; state.files.set(name,f); state.active=name; $('emptyState').classList.add('hidden'); resetFileState();
    if(state.editor){ state.editor.setValue(content); setEditorLanguage(); state.editor.focus(); }
    renderTabs(); renderTree(); updateContext(); detect(); updateWorkspaceMode(); event('Opened',`${name}${isHtmlWorkspace()?' · live web workspace ready':''}`,'ok'); scheduleLive();
  }
  function openFiles(files){ [...files].filter(f=>f.size<=5*1024*1024).forEach(file=>{const r=new FileReader();r.onload=()=>openFile(file.webkitRelativePath||file.name,String(r.result||''));r.readAsText(file);}); }
  function sync(){ const f=current(); if(!f||!state.editor)return false; const v=state.editor.getValue(); if(v===f.content)return false; f.content=v; f.dirty=v!==f.original; renderTabs(); renderTree(); return true; }
  function renderTabs(){ $('fileTabs').innerHTML=[...state.files.values()].map(f=>`<button class="file-tab ${f.name===state.active?'active':''}" data-file="${esc(f.name)}"><span class="lang">${esc(f.language)}</span><span class="tab-name">${esc(f.name)}</span>${f.dirty?'<span class="dirty">●</span>':''}<span class="x" data-close-file="${esc(f.name)}">×</span></button>`).join(''); }
  function renderTree(){ if(!state.files.size){$('fileTree').innerHTML='<div class="tree-empty">No files</div>';return;} $('fileTree').innerHTML=[...state.files.values()].map(f=>`<div class="tree-file ${f.name===state.active?'active':''}" data-tree-file="${esc(f.name)}"><span class="tree-icon">${esc(f.language==='html'?'<>':f.language==='python'?'🐍':f.language==='javascript'?'JS':'·')}</span><span>${esc(f.name)}</span>${f.dirty?'<b>●</b>':''}<button class="tree-more" data-tree-menu="${esc(f.name)}">···</button></div>`).join(''); }
  function activateFile(name){ const f=state.files.get(name); if(!f)return; state.active=name; state.editor.setValue(f.content); setEditorLanguage(); resetFileState(); renderTabs(); renderTree(); updateContext(); detect(); updateWorkspaceMode(); scheduleLive(); }
  function closeFile(name){ state.files.delete(name); if(state.active===name){ const next=state.files.keys().next().value; if(next)activateFile(next); else {state.active=null;state.editor.setValue('');$('emptyState').classList.remove('hidden');state.detected=null;resetFileState();updateContext();updateWorkspaceMode();} } renderTabs();renderTree(); }
  function createFile(name){ name=(name||'untitled.txt').trim()||'untitled.txt'; if(state.files.has(name)){name='untitled-'+Date.now()+'.txt';} openFile(name,''); addHistory('Created',name); }
  function renameCurrent(name){ const f=current(); name=(name||'').trim(); if(!f||!name||name===f.name)return; if(state.files.has(name)){event('Rename','A file with that name already exists.','bad');return;} state.files.delete(f.name); f.name=name; f.language=lang(name); state.files.set(name,f); state.active=name; renderTabs();renderTree();setEditorLanguage();updateContext();detect();updateWorkspaceMode();event('Renamed',`${name}`,'ok'); }
  function saveCurrent(){ const f=current(); if(!f)return; f.original=f.content;f.dirty=false;renderTabs();renderTree();addHistory('Saved',f.name);event('Saved',f.name,'ok');setStatus('Saved','ready'); }
  function downloadBlob(name,content,type='text/plain'){ const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000); }
  function downloadCurrent(){ const f=current(); if(f)downloadBlob(f.name,f.content); }
  async function downloadProject(){ if(typeof JSZip==='undefined'){return downloadCurrent();} const zip=new JSZip();state.files.forEach(f=>zip.file(f.name,f.content));const blob=await zip.generateAsync({type:'blob'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='bugfalse-project.zip';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000); }

  function updateWorkspaceMode(){ const web=isHtmlWorkspace(); $('webPane').classList.toggle('hidden',!web); $('editorStage').classList.toggle('web-mode',web); if(web){$('webPath').textContent=current()?.name||'index.html';updateWeb();}else $('previewStatus').textContent=''; refreshLayout(); }
  function buildWebSource(){
    const html=current()?.content||''; let source=html;
    const css=[...state.files.values()].filter(f=>f.language==='css').map(f=>`<style data-bugfalse-file="${esc(f.name)}">${f.content}</style>`).join('');
    const js=[...state.files.values()].filter(f=>f.language==='javascript' && f.name!==current()?.name).map(f=>`<script data-bugfalse-file="${esc(f.name)}">${f.content.replace(/<\/script/gi,'<\\/script')}</script>`).join('');
    const bridge=`<script>(function(){const send=(type,args)=>parent.postMessage({source:'bugfalse-web',type,args:Array.from(args).map(x=>{try{return typeof x==='string'?x:JSON.stringify(x)}catch{return String(x)}})},'*');['log','info','warn','error'].forEach(k=>{const o=console[k];console[k]=function(){send(k,arguments);o.apply(console,arguments)}});window.addEventListener('error',e=>send('error',[e.message+' @ '+(e.filename||'page')+':'+e.lineno]));window.addEventListener('unhandledrejection',e=>send('error',['Unhandled promise rejection',e.reason]));})();<\\/script>`;
    if(/<html[\s>]/i.test(source)){ source=source.replace(/<head([^>]*)>/i,`<head$1>${bridge}${css}`).replace(/<\/body>/i,`${js}</body>`); }
    else source=`<!doctype html><html><head><meta charset="utf-8">${bridge}${css}</head><body>${source}${js}</body></html>`;
    return source;
  }
  function updateWeb(){ if(!isHtmlWorkspace())return; $('webPath').textContent=current()?.name||'index.html';$('previewFrame').srcdoc=buildWebSource();$('previewStatus').textContent='Live · '+new Date().toLocaleTimeString(); }

  function scheduleLive(){ clearTimeout(state.timer); if(!$('liveToggle')?.checked || !current())return; state.timer=setTimeout(()=>{if(isHtmlWorkspace()){sync();updateWeb();event('Updated',`${current().name} changed · live web output refreshed`,'ok');setStatus('Live','ready');}else if(EXECUTABLE.has(current().language)){execute(true);}else{analyzeLocal();}},state.debounce); }
  async function execute(live=false){ const f=current(); if(!f)return; sync(); if(isHtmlWorkspace())return updateWeb(); if(!EXECUTABLE.has(f.language)){analyzeLocal();return;} if(state.running)return; state.running=true;setStatus('Running','running');event(live?'Running':'Run',`${f.name} · ${f.language}`);renderPanel('output');
    try{const r=await fetch('/execute/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:f.content,filename:f.name})});const data=await r.json();state.output=data; if(data.stdout)event('stdout',data.stdout,'ok');if(data.stderr)event(data.ok?'stderr':'Error',data.stderr,data.ok?'':'bad');event('Finished',data.ok?`exit code 0 · ${data.duration_ms} ms`:`exit code ${data.exit_code ?? 'unknown'} · ${data.duration_ms ?? 0} ms`,data.ok?'ok':'bad');setStatus(data.ok?'Ready':'Error',data.ok?'ready':'error');parseProblems(data.stderr||'');renderPanel('output');}
    catch(err){state.output={ok:false,stderr:String(err)};event('Error',String(err),'bad');setStatus('Error','error');renderPanel('output');}
    finally{state.running=false;}
  }
  function analyzeLocal(){ const f=current();if(!f)return; if(f.language==='json'){try{JSON.parse(f.content);state.analysis={score:100,issues:[],analysis:'Valid JSON.'};}catch(e){state.analysis={score:40,issues:[{severity:'error',message:e.message,type:'JSON',line:null}],analysis:'Invalid JSON.'};}} else state.analysis={score:null,issues:[],analysis:'Live analysis is available through CodeAI.'};renderPanel('analysis'); }
  function parseProblems(text){ const f=current(); if(!f)return; const m=text.match(/(?:File "([^"]+)", line (\\d+)[^\\n]*\\n)?([^\\n]+)$/m); state.problems=m?[{severity:'error',message:m[3],line:Number(m[2]||0)}]:[]; }

  async function runCodeAI(){
    const f=current(); if(!f){$('codeAiStatus').textContent='Open a file first';return;}
    const mode=state.codeAiMode==='custom'?'improve':state.codeAiMode; const instruction=state.codeAiMode==='custom'?$('codeAiPrompt').value.trim():'';
    if(state.codeAiMode==='custom'&&!instruction){$('codeAiStatus').textContent='Enter the change you want';$('codeAiPrompt').focus();return;}
    sync(); state.running=true;setStatus('CodeAI','running');$('codeAiStatus').textContent='Analyzing…';event('CodeAI',`${f.name} · ${mode}`);renderPanel('output');
    try{
      const r=await fetch('/debug/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:f.content,filename:f.name,language:f.language,framework:state.detected?.framework||'',mode,instruction})});
      const data=await r.json(); if(!r.ok)throw new Error(data.detail||'CodeAI request failed');
      data.original_code=f.content; state.analysis=data;
      const newCode=data.fixed_code;
      const issueCount=(data.issues||[]).length;
      if(newCode && ['fix','improve','refactor','optimize'].includes(mode) && newCode.trim()!==f.content.trim()){
        const before=f.content; f.content=newCode;f.dirty=true;state.editor.setValue(newCode);renderTabs();renderTree();
        addHistory('CodeAI',`${mode} · ${issueCount} issue(s) reported`);event('CodeAI',`${issueCount} issue(s) found · code updated`,'ok');
        if(isHtmlWorkspace()){updateWeb();event('Rendered',`${f.name} · CodeAI changes visible in web output`,'ok');}
        else if(EXECUTABLE.has(f.language)){await execute(true);}else analyzeLocal();
      } else {
        event('CodeAI',data.error||`Analysis complete · ${issueCount} issue(s)` ,data.error?'bad':'ok');
      }
      $('codeAiStatus').textContent=data.error?'Failed':(newCode?'Applied · live result updated':'Analysis complete');
      renderPanel('output');
    }catch(err){event('CodeAI error',String(err),'bad');$('codeAiStatus').textContent='Failed';setStatus('Error','error');renderPanel('output');}
    finally{state.running=false;}
  }
  function setCodeAiMode(mode){state.codeAiMode=mode;document.querySelectorAll('[data-codeai-mode]').forEach(b=>b.classList.toggle('active',b.dataset.codeaiMode===mode));$('codeAiPrompt').classList.toggle('hidden',mode!=='custom');$('runCodeAi').textContent=mode==='custom'?'Apply':'Run';$('codeAiStatus').textContent=mode==='custom'?'Waiting for your instruction':'Ready';}

  function renderPanel(panel){
    document.querySelectorAll('.panel-tab').forEach(b=>b.classList.toggle('active',b.dataset.panel===panel));
    const c=$('panelContent');
    if(panel==='output'){c.innerHTML=state.events.length?state.events.map(e=>`<div class="event ${e.kind}"><span>${esc(e.time)}</span><b>${esc(e.type)}</b><span>${esc(e.detail)}</span></div>`).join(''):'<div class="empty-panel">No live output yet.</div>';return;}
    if(panel==='problems'){const ps=state.problems||[];c.innerHTML=ps.length?ps.map(p=>`<div class="problem error"><span class="sev">ERROR</span><div><strong>${esc(p.message)}</strong><small>${p.line?`Line ${p.line}`:''}</small></div></div>`).join(''):'<div class="empty-panel">No problems detected.</div>';return;}
    if(panel==='tests'){c.innerHTML='<div class="empty-panel">Tests will appear here when a test runner is available.</div>';return;}
    if(panel==='diff'){if(!state.analysis?.fixed_code){c.innerHTML='<div class="empty-panel">CodeAI changes will appear here after a code modification.</div>';return;}const before=state.analysis.original_code||'';const after=state.analysis.fixed_code; c.innerHTML=`<div class="diff-toolbar"><span>CodeAI proposed/applied changes</span></div><div class="diff"><div class="diff-line removed">− Previous version</div><div class="diff-line added">+ Updated version (${after.split('\\n').length} lines)</div></div>`;return;}
    if(panel==='analysis'){const a=state.analysis;if(!a){c.innerHTML='<div class="empty-panel">No analysis yet.</div>';return;}c.innerHTML=`<div class="analysis"><div class="score">${a.score??'—'}<small>health score</small></div><div><h3>${(a.issues||[]).length} issue(s)</h3><p>${esc(a.analysis||a.summary||'No additional analysis.')}</p></div></div>`;return;}
  }

  function initMonaco(){ require.config({paths:{vs:'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs'}}); require(['vs/editor/editor.main'],()=>{state.monaco=monaco;state.editor=monaco.editor.create($('monaco'),{value:'',language:'plaintext',theme:'vs-dark',automaticLayout:true,fontSize:14,lineHeight:22,fontFamily:'JetBrains Mono,SFMono-Regular,Consolas,monospace',minimap:{enabled:true},padding:{top:10,bottom:10},scrollBeyondLastLine:false,smoothScrolling:true,wordWrap:'off'});state.editor.onDidChangeModelContent(()=>{if(!state.active)return;sync();scheduleLive();});state.editor.onDidChangeCursorPosition(()=>{const p=state.editor.getPosition();$('cursor').textContent=`Ln ${p.lineNumber}, Col ${p.column}`;});}); }
  function initWebSplitter(){const stage=$('editorStage'),divider=$('workspaceDivider');if(!stage||!divider)return;let dragging=false;const move=e=>{if(!dragging||!isHtmlWorkspace())return;const r=stage.getBoundingClientRect(),min=280,max=r.width-420,x=Math.max(min,Math.min(max,e.clientX-r.left)),pct=x/r.width*100;stage.querySelector('.editor-pane').style.flexBasis=pct+'%';stage.querySelector('.web-pane').style.flexBasis=(100-pct)+'%';state.editor?.layout();};const up=()=>{dragging=false;divider.classList.remove('dragging');document.body.style.cursor='';};divider.addEventListener('pointerdown',e=>{dragging=true;divider.classList.add('dragging');document.body.style.cursor='col-resize';});divider.addEventListener('pointermove',move);divider.addEventListener('pointerup',up);divider.addEventListener('pointercancel',up);}
  function refreshLayout(){requestAnimationFrame(()=>state.editor?.layout());}
  function setSidebarCollapsed(c){$('app').classList.toggle('sidebar-collapsed',c);localStorage.setItem('bugfalse-sidebar-collapsed',c?'1':'0');refreshLayout();}
  function setBottomCollapsed(c){$('bottomToggle').closest('.bottom-panel').classList.toggle('collapsed',c);$('bottomToggle').textContent=c?'⌃':'⌄';localStorage.setItem('bugfalse-bottom-collapsed',c?'1':'0');refreshLayout();}
  function showFileMenu(show){$('fileMenu').classList.toggle('hidden',!show);}
  function init(){
    initMonaco();renderPanel('output');renderTree();setSidebarCollapsed(localStorage.getItem('bugfalse-sidebar-collapsed')==='1');setBottomCollapsed(localStorage.getItem('bugfalse-bottom-collapsed')==='1');
    $('fileMenuBtn').onclick=e=>{e.stopPropagation();showFileMenu($('fileMenu').classList.contains('hidden'));};
    document.addEventListener('click',e=>{if(!e.target.closest('.file-menu')&&!e.target.closest('#fileMenuBtn'))showFileMenu(false);});
    document.querySelectorAll('[data-file-action]').forEach(b=>b.onclick=()=>{const a=b.dataset.fileAction;showFileMenu(false);if(a==='new'){$('newFileName').value='untitled.txt';$('newFileModal').classList.remove('hidden');$('newFileName').focus();}if(a==='open')$('fileInput').click();if(a==='folder')$('folderInput').click();if(a==='rename'){const f=current();if(f){$('renameFileName').value=f.name;$('renameModal').classList.remove('hidden');$('renameFileName').focus();}}if(a==='save')saveCurrent();if(a==='download')state.files.size>1?downloadProject():downloadCurrent();if(a==='delete'&&current())closeFile(current().name);});
    $('newFileBtn').onclick=()=>{$('newFileName').value='untitled.txt';$('newFileModal').classList.remove('hidden');$('newFileName').focus()};
    $('fileInput').onchange=e=>{openFiles(e.target.files);e.target.value=''};$('folderInput').onchange=e=>{openFiles(e.target.files);e.target.value=''};
    $('runBtn').onclick=()=>execute(false);$('liveToggle').onchange=()=>{if($('liveToggle').checked)scheduleLive()};
    $('debounceSelect').onchange=e=>state.debounce=Number(e.target.value);$('minimapToggle').onchange=e=>state.editor?.updateOptions({minimap:{enabled:e.target.checked}});$('settingsBtn').onclick=()=>$('settingsModal').classList.remove('hidden');$('themeBtn').onclick=()=>{state.theme=state.theme==='dark'?'light':'dark';document.body.classList.toggle('light',state.theme==='light');state.editor&&state.monaco.editor.setTheme(state.theme==='light'?'vs':'vs-dark');};$('bottomToggle').onclick=()=>setBottomCollapsed(!$('bottomToggle').closest('.bottom-panel').classList.contains('collapsed'));
    $('codeAiToggle').onclick=e=>{e.stopPropagation();$('codeAiPopover').classList.toggle('hidden');};$('closeCodeAi').onclick=()=>$('codeAiPopover').classList.add('hidden');document.querySelectorAll('[data-codeai-mode]').forEach(b=>b.onclick=()=>setCodeAiMode(b.dataset.codeaiMode));$('runCodeAi').onclick=runCodeAI;
    document.querySelectorAll('.panel-tab').forEach(b=>b.onclick=()=>renderPanel(b.dataset.panel));document.querySelectorAll('[data-viewport]').forEach(b=>b.onclick=()=>{state.viewport=b.dataset.viewport;document.querySelectorAll('[data-viewport]').forEach(x=>x.classList.toggle('active',x===b));const f=$('previewFrame');f.classList.remove('vp-tablet','vp-mobile');if(state.viewport==='tablet')f.classList.add('vp-tablet');if(state.viewport==='mobile')f.classList.add('vp-mobile');});
    $('webRefresh').onclick=()=>{if(isHtmlWorkspace()){updateWeb();event('Refresh','Live web output refreshed','ok')}};initWebSplitter();new ResizeObserver(()=>state.editor?.layout()).observe($('editorStage'));
    $('previewFrame').addEventListener('load',()=>{if(isHtmlWorkspace()){event('Rendered',`${current().name} · browser output ready`,'ok');setStatus('Live','ready')}});window.addEventListener('message',e=>{if(e.data?.source!=='bugfalse-web')return;const type=e.data.type||'log',text=(e.data.args||[]).join(' ');event(type.toUpperCase(),text,type==='error'?'bad':'');});
    document.addEventListener('click',e=>{const tab=e.target.closest('[data-file]');if(tab&&!e.target.closest('[data-close-file]'))activateFile(tab.dataset.file);const close=e.target.closest('[data-close-file]');if(close){e.stopPropagation();closeFile(close.dataset.closeFile);}const tree=e.target.closest('[data-tree-file]');if(tree&&!e.target.closest('[data-tree-menu]'))activateFile(tree.dataset.treeFile);const more=e.target.closest('[data-tree-menu]');if(more){e.stopPropagation();const name=more.dataset.treeMenu;const action=prompt(`File: ${name}\nType rename, delete, or cancel`,'cancel');if(action==='rename'){state.active=name;$('renameFileName').value=name;$('renameModal').classList.remove('hidden');}if(action==='delete')closeFile(name);}const closeModal=e.target.closest('[data-close]');if(closeModal)$(closeModal.dataset.close)?.classList.add('hidden');});
    window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>{e.preventDefault();if(e.dataTransfer.files.length)openFiles(e.dataTransfer.files);});
    document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();saveCurrent();}if((e.ctrlKey||e.metaKey)&&e.key==='o'){e.preventDefault();$('fileInput').click();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='b'){e.preventDefault();setSidebarCollapsed(!$('app').classList.contains('sidebar-collapsed'));}if(e.key==='Escape'){showFileMenu(false);$('codeAiPopover').classList.add('hidden');document.querySelectorAll('.modal:not(.hidden)').forEach(m=>m.classList.add('hidden'));}});
    $('createFileConfirm').onclick=()=>{$('newFileModal').classList.add('hidden');createFile($('newFileName').value)};$('newFileName').onkeydown=e=>{if(e.key==='Enter')$('createFileConfirm').click()};$('renameFileConfirm').onclick=()=>{$('renameModal').classList.add('hidden');renameCurrent($('renameFileName').value)};$('renameFileName').onkeydown=e=>{if(e.key==='Enter')$('renameFileConfirm').click()};
  }
  init();
})();
