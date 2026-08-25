(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const LANG = {py:'python',js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',java:'java',c:'c',cc:'cpp',cpp:'cpp',cxx:'cpp',cs:'csharp',go:'go',rs:'rust',php:'php',rb:'ruby',swift:'swift',kt:'kotlin',kts:'kotlin',html:'html',css:'css',json:'json',sql:'sql',md:'markdown',yaml:'yaml',yml:'yaml',txt:'plaintext'};
  const PROFILE = {
    python:['🐍','Python','Tracebacks, tests and AI debugging.','Run'], javascript:['JS','JavaScript','Browser/web editing or Node execution.','Run'], typescript:['TS','TypeScript','Typed editing and web-aware diagnostics.','Run'],
    html:['<>','HTML','Live web workspace with browser-style output.','Web'], css:['#','CSS','Stylesheet editing and diagnostics.','Analyze'], json:['{}','JSON','Validation-focused structured data.','Validate'], sql:['SQL','SQL','Query review and optimization workspace.','Analyze'],
    java:['☕','Java','Compile and runtime diagnostics.','Run'], c:['C','C','Compiler diagnostics and build/run feedback.','Run'], cpp:['C++','C++','Compiler diagnostics and build/run feedback.','Run'], go:['Go','Go','Build, run and test feedback.','Run'], rust:['🦀','Rust','Compiler and ownership diagnostics.','Run'], php:['PHP','PHP','Runtime diagnostics.','Run'], ruby:['Rb','Ruby','Runtime diagnostics.','Run'], csharp:['C#','C#','.NET diagnostics.','Run'], swift:['Swift','Swift','Compiler/runtime diagnostics.','Run'], kotlin:['Kt','Kotlin','JVM diagnostics.','Run'], markdown:['M↓','Markdown','Documentation workspace.','Analyze'], yaml:['Y','YAML','Configuration validation workspace.','Validate'], plaintext:['TXT','Text','Plain text workspace.','Analyze']
  };
  const EXECUTABLE = new Set(['python','javascript','typescript','php','ruby','go','rust','c','cpp','java','swift']);
  const state = {files:new Map(),active:null,editor:null,monaco:null,detected:null,output:null,analysis:null,history:[],events:[],timer:null,debounce:800,running:false,abort:null,theme:'dark',aiMode:'analyze',webConsole:[],webElements:[],viewport:'desktop'};
  const sample = `def calculate_total(items):\n    total = 0\n    for item in items:\n        if item is None:\n            continue\n        total += item.price\n    return total\n\nprint(calculate_total([]))\n`;
  const lang = name => LANG[(name.split('.').pop() || '').toLowerCase()] || 'plaintext';
  const current = () => state.active ? state.files.get(state.active) : null;
  const isHtmlWorkspace = () => current()?.language === 'html';
  const setStatus = (text,kind='ready') => { $('statusText').textContent=text; $('statusDot').className='status-dot '+kind; };
  const event = (type,detail,kind='') => { state.events.unshift({time:new Date().toLocaleTimeString(),type,detail,kind}); state.events=state.events.slice(0,100); if(document.querySelector('.panel-tab.active')?.dataset.panel==='output') renderPanel('output'); };
  const addHistory = (label,detail) => { state.history.unshift({time:new Date().toLocaleTimeString(),label,detail}); state.history=state.history.slice(0,50); };

  function updateContext(){
    const f=current(), p=PROFILE[f?.language]||PROFILE.plaintext, d=state.detected||{};
    $('workspaceName').textContent=f?f.name:'Untitled workspace'; $('fileStatus').textContent=f?f.name:'No file'; $('languageIcon').textContent=p[0]; $('languageTitle').textContent=p[1]; $('frameworkText').textContent=d.framework?` · ${d.framework}`:''; $('languageHint').textContent=p[2];
    $('languageState').textContent=d.runtime_available===false?'Runtime unavailable':(isHtmlWorkspace()?'Web workspace':(f?'Ready':'Ready'));
    $('runtimePill').textContent=f?(d.framework?`${d.framework} · ${p[1]}`:p[1]):'No file';
    $('runBtn').textContent=isHtmlWorkspace()?'':(f?p[3]:'Run'); $('runBtn').style.display=isHtmlWorkspace()?'none':''; $('runBtn').disabled=!f; $('downloadBtn').disabled=!f;
    $('aiContext').textContent=f?`${f.name} · ${p[1]}${d.framework?' · '+d.framework:''}`:'Open a file to give AI context.';
  }

  async function detect(){
    const f=current(); if(!f)return;
    try { const files={}; state.files.forEach((v,k)=>files[k]=v.content.slice(0,100000)); const r=await fetch('/runtime/detect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:f.name,files})}); state.detected=await r.json(); }
    catch { state.detected=null; }
    updateContext();
  }
  function setEditorLanguage(){ if(!state.editor)return; const f=current(); state.monaco.editor.setModelLanguage(state.editor.getModel(),f?.language||'plaintext'); }
  function resetFileState(){ state.output=null; state.analysis=null; state.events=[]; state.webConsole=[]; state.webElements=[]; renderPanel('output'); }
  function openFile(name,content){
    const existing=state.files.get(name); const f={name,content,original:existing?.original??content,language:lang(name),dirty:false}; f.dirty=f.content!==f.original; state.files.set(name,f); state.active=name; $('emptyState').classList.add('hidden'); resetFileState();
    if(state.editor){ state.editor.setValue(content); setEditorLanguage(); state.editor.focus(); }
    renderTabs(); renderTree(); updateContext(); detect(); updateWorkspaceMode(); if(isHtmlWorkspace()){ event('Opened',`${name} · live web workspace ready`,'ok'); scheduleLive(); } else { event('Opened',name); scheduleLive(); }
  }
  function openFiles(files){ [...files].filter(f=>f.size<=5*1024*1024).forEach(file=>{const r=new FileReader();r.onload=()=>openFile(file.webkitRelativePath||file.name,String(r.result||''));r.readAsText(file);}); }
  function sync(){ const f=current(); if(!f||!state.editor)return false; const v=state.editor.getValue(); if(v===f.content)return false; f.content=v; f.dirty=v!==f.original; renderTabs(); renderTree(); return true; }

  function renderTabs(){
    $('fileTabs').innerHTML=[...state.files.values()].map(f=>`<button class="file-tab ${f.name===state.active?'active':''}" data-file="${esc(f.name)}"><span class="lang">${esc(f.language)}</span><span class="tab-name">${esc(f.name)}</span>${f.dirty?'<span class="dirty">●</span>':''}<span class="x" data-close-file="${esc(f.name)}">×</span></button>`).join('');
  }
  function renderTree(){
    if(!state.files.size){$('fileTree').innerHTML='<div class="tree-empty">No files</div>';return;}
    $('fileTree').innerHTML=[...state.files.values()].map(f=>`<div class="tree-file ${f.name===state.active?'active':''}" data-tree-file="${esc(f.name)}"><span class="tree-icon">${esc(f.language==='html'?'<>':f.language==='python'?'🐍':f.language==='javascript'?'JS':'·')}</span><span>${esc(f.name)}</span>${f.dirty?'<b>●</b>':''}<button class="tree-more" data-tree-menu="${esc(f.name)}">···</button></div>`).join('');
  }
  function activateFile(name){ const f=state.files.get(name); if(!f)return; state.active=name; state.editor.setValue(f.content); setEditorLanguage(); resetFileState(); renderTabs(); renderTree(); updateContext(); detect(); updateWorkspaceMode(); scheduleLive(); }
  function closeFile(name){ state.files.delete(name); if(state.active===name){ const next=state.files.keys().next().value; if(next)activateFile(next); else {state.active=null;state.editor.setValue('');$('emptyState').classList.remove('hidden');state.detected=null;updateContext();updateWorkspaceMode();} } renderTabs();renderTree(); }

  function updateWorkspaceMode(){
    const web=isHtmlWorkspace(); $('webPane').classList.toggle('hidden',!web); $('editorStage').classList.toggle('web-mode',web);
    if(web){ $('webPath').textContent=current()?.name||'index.html'; updateWeb(); }
    else { $('inspectPanel').innerHTML=''; }
  }
  function buildWebSource(){
    const html=current()?.content||''; let source=html;
    const css=[...state.files.values()].filter(f=>f.language==='css').map(f=>`<style data-bugfalse-file="${esc(f.name)}">${f.content}</style>`).join('');
    const js=[...state.files.values()].filter(f=>f.language==='javascript' && f.name!==current()?.name).map(f=>`<script data-bugfalse-file="${esc(f.name)}">${f.content.replace(/<\/script/gi,'<\\/script')}</script>`).join('');
    if(/<html[\s>]/i.test(source)){ source=source.replace(/<head([^>]*)>/i,`<head$1>${css}`).replace(/<\/body>/i,`${js}</body>`); }
    else source=`<!doctype html><html><head><meta charset="utf-8">${css}</head><body>${source}${js}</body></html>`;
    const bridge=`<script>(function(){const send=(type,args)=>parent.postMessage({source:'bugfalse-web',type,args:Array.from(args).map(x=>{try{return typeof x==='string'?x:JSON.stringify(x)}catch{return String(x)}})},'*');['log','info','warn','error'].forEach(k=>{const o=console[k];console[k]=function(){send(k,arguments);o.apply(console,arguments)}});window.addEventListener('error',e=>send('error',[e.message+' @ '+(e.filename||'page')+':'+e.lineno]));window.addEventListener('unhandledrejection',e=>send('error',['Unhandled promise rejection',e.reason]));})();<\/script>`;
    return source.replace(/<head([^>]*)>/i,`<head$1>${bridge}`);
  }
  function updateWeb(){
    if(!isHtmlWorkspace())return; $('webPath').textContent=current()?.name||'index.html'; $('previewFrame').srcdoc=buildWebSource(); $('previewStatus').textContent='Live · '+new Date().toLocaleTimeString();
    const html=current()?.content||''; try { const doc=new DOMParser().parseFromString(html,'text/html'); state.webElements=buildElementTree(doc.body); renderInspect('elements'); } catch {}
  }
  function buildElementTree(root,depth=0){ if(!root)return[]; return [...root.children].slice(0,80).map(el=>({tag:el.tagName.toLowerCase(),id:el.id||'',classes:[...el.classList].slice(0,4),depth,children:buildElementTree(el,depth+1)})); }
  function flattenElements(nodes,out=[]){nodes.forEach(n=>{out.push(n);flattenElements(n.children,out)});return out;}
  function renderInspect(kind='console'){
    document.querySelectorAll('.inspect-tab').forEach(b=>b.classList.toggle('active',b.dataset.inspect===kind));
    if(kind==='console') $('inspectPanel').innerHTML=state.webConsole.length?state.webConsole.map(x=>`<div class="console-line ${esc(x.type)}"><span>${esc(x.time)}</span><b>${esc(x.type)}</b><code>${esc(x.text)}</code></div>`).join(''):'<div class="inspect-empty">Console is clear.</div>';
    else { const flat=flattenElements(state.webElements); $('inspectPanel').innerHTML=flat.length?flat.map(n=>`<div class="element-line" style="--depth:${n.depth}"><span>›</span>&lt;${esc(n.tag)}${n.id?' id="'+esc(n.id)+'"':''}${n.classes.length?' class="'+esc(n.classes.join(' '))+'"':''}&gt;</div>`).join(''):'<div class="inspect-empty">No body elements yet.</div>'; }
  }
  function scheduleLive(){
    clearTimeout(state.timer); if(!$('liveToggle').checked)return; const f=current(); if(!f)return;
    const targetName=f.name, captured=state.editor?.getValue()??f.content;
    state.timer=setTimeout(async()=>{const active=current();if(!active||active.name!==targetName)return;const changed=sync(); if(!changed)return;
      if(isHtmlWorkspace()){updateWeb();event('Updated',`${f.name} changed · live web output refreshed`,'ok');setStatus('Live','ready');return;}
      if(EXECUTABLE.has(f.language)){event('Running',`${f.name} changed · live execution`);await execute(true,captured);} else if(f.language==='json'){validateJson();} else if(f.language==='yaml'){validateYaml();} else {event('Updated',`${f.name} changed`,'ok');setStatus('Live','ready');}
    },state.debounce);
  }
  async function execute(live=false,capturedCode=null){
    const f=current();if(!f)return;const code=capturedCode??(sync(),f.content); if(isHtmlWorkspace()){updateWeb();return;}
    if(f.language==='json'){validateJson();return} if(f.language==='yaml'){validateYaml();return}
    if(!EXECUTABLE.has(f.language)){event('Info',`${f.language} is editor-only in this runtime`);setStatus('Editor only','ready');renderPanel('output');return}
    state.running=true;$('runBtn').disabled=true;$('stopBtn').disabled=false;setStatus(live?'Live run…':'Running…','running');state.output=null;renderPanel('output');const controller=new AbortController();state.abort=controller;
    try{const r=await fetch('/execute/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,filename:f.name}),signal:controller.signal});const data=await r.json();if(!r.ok)throw new Error(data.detail||'Execution failed');state.output=data;event(data.ok?'Passed':'Failed',`${f.name} · ${data.duration_ms||0} ms`,data.ok?'ok':'bad');setStatus(data.ok?'Verified':data.runtime_available===false?'Runtime unavailable':'Execution failed',data.ok?'ready':'error');addHistory(data.ok?'Run passed':'Run failed',f.name);renderPanel('output');const line=traceLine(data.stderr);if(line&&state.editor){state.editor.revealLineInCenter(line);state.editor.setPosition({lineNumber:line,column:1});}}
    catch(e){if(e.name!=='AbortError'){state.output={ok:false,stderr:e.message};event('Error',e.message,'bad');setStatus('Execution failed','error');renderPanel('output')}}
    finally{state.running=false;$('runBtn').disabled=!current();$('stopBtn').disabled=true;state.abort=null;}
  }
  function traceLine(s){const m=String(s||'').match(/(?:line\s+|\.py[":])([0-9]+)/i);return m?Number(m[1]):null;}
  function validateJson(){const f=current();try{JSON.parse(f.content);state.output={ok:true,stdout:'Valid JSON.\n',stderr:''};event('Valid',`${f.name} · JSON parsed`,'ok');setStatus('Valid JSON','ready')}catch(e){state.output={ok:false,stdout:'',stderr:e.message};event('Invalid',`${f.name} · JSON validation failed`,'bad');setStatus('Invalid JSON','error')}renderPanel('output')}
  function validateYaml(){const f=current();const bad=/^\s*[^#\n]+:\s*:\s*/m.test(f.content);state.output={ok:!bad,stdout:bad?'':'Basic YAML structure looks valid.\n',stderr:bad?'Possible YAML syntax issue.':''};event(bad?'Review':'Valid',`${f.name} · configuration check`,bad?'bad':'ok');setStatus(bad?'Review YAML':'YAML looks valid',bad?'error':'ready');renderPanel('output')}
  function diffHtml(before,after){const a=before.split('\n'),b=after.split('\n'),n=Math.max(a.length,b.length);let out='';for(let i=0;i<n;i++){if(a[i]===b[i])out+=`<div class="diff-line">  ${esc(a[i]??'')}</div>`;else{if(a[i]!==undefined)out+=`<div class="diff-line removed">- ${esc(a[i])}</div>`;if(b[i]!==undefined)out+=`<div class="diff-line added">+ ${esc(b[i])}</div>`}}return out}
  function renderPanel(name){
    document.querySelectorAll('.panel-tab').forEach(b=>b.classList.toggle('active',b.dataset.panel===name));const out=state.output||{},r=state.analysis||{};let html='';
    if(name==='output'){
      if(isHtmlWorkspace()){
        const events=state.events.length?state.events.map(e=>`<div class="event ${e.kind}"><span>${esc(e.time)}</span><b>${esc(e.type)}</b><span>${esc(e.detail)}</span></div>`).join(''):'<div class="empty-panel">Edit HTML to see live web updates here.</div>';
        html=`<div class="output-head"><span><i class="live-dot"></i>Live web updates</span><span>${state.events.length} events</span></div>${events}`;
      } else {
        html=`<div class="output-head"><span>${out.ok===true?'✓ Success':out.stderr?'✕ Failed':'Ready'}</span><span>${out.duration_ms?esc(out.duration_ms)+' ms':''}</span></div><pre class="terminal">${esc(out.stdout||out.stderr||'Run or edit the current file to see live output.')}</pre>`;
      }
    }
    if(name==='problems'){const issues=r.issues||[];html=issues.length?issues.map(i=>`<div class="problem ${esc(i.severity||'warning')}"><span class="sev">${esc((i.severity||'warning').toUpperCase())}</span><div><strong>${esc(i.message||'Issue')}</strong><small>${esc(i.type||'')} ${i.line?'· line '+i.line:''}</small></div></div>`).join(''):'<div class="empty-panel"><div>✓<strong>No reported problems</strong><span>Run or analyze the current file.</span></div></div>';}
    if(name==='tests')html='<div class="empty-panel"><div>✓<strong>Tests workspace ready</strong><span>Ask AI to generate tests, then run them in the project runtime.</span></div></div>';
    if(name==='analysis')html=`<div class="analysis"><div class="score">${r.score??'—'}<small>health score</small></div><div><h3>${esc(r.summary?.errors??0)} errors · ${esc(r.summary?.warnings??0)} warnings</h3><p>${esc(r.analysis||'No analysis yet.')}</p></div></div>`;
    if(name==='diff')html=r.fixed_code?`<div class="diff-toolbar"><span>Proposed changes</span><span class="spacer"></span><button id="rejectDiff">Reject</button><button class="apply" id="applyDiff">Apply</button></div><div class="diff">${diffHtml(current()?.content||'',r.fixed_code)}</div>`:'<div class="empty-panel"><div>↔<strong>No AI changes</strong><span>Ask AI to fix or improve the current file.</span></div></div>';
    $('panelContent').innerHTML=html;$('problemCount').textContent=(r.issues||[]).length;
  }
  function addMessage(role,text,klass=''){const el=document.createElement('div');el.className=`msg ${role} ${klass}`;el.innerHTML=`<div class="role">${role==='user'?'You':'BugFalse AI'}</div><div class="bubble">${esc(text)}</div>`;$('chat').appendChild(el);$('chat').scrollTop=$('chat').scrollHeight;return el;}
  function formatAI(r){let text=r.analysis||r.explanation||r.error||'Analysis complete.';if(r.issues?.length)text+=`\n\n${r.issues.map(i=>`• ${i.severity||'info'}: ${i.message}${i.line?' (line '+i.line+')':''}`).join('\n')}`;if(r.improvements?.length)text+=`\n\nImprovements:\n${r.improvements.map(x=>'• '+x).join('\n')}`;return text;}
  async function ai(mode=state.aiMode,question=''){const f=current();if(!f){addMessage('ai','Open a file first so I can work with real code.');return}state.aiMode=mode;document.querySelectorAll('.ai-modes button').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));const q=question||({analyze:'Analyze this file for important bugs, risks and improvements.',fix:'Find the important bugs and propose a safe fix.',improve:'Improve this code while preserving its behavior.'}[mode]||'Help me with this code.');addMessage('user',q);const typing=addMessage('ai','Working…','typing');try{const r=await fetch('/debug/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:f.content,filename:f.name,language:f.language,framework:state.detected?.framework||null,mode})});const data=await r.json();typing.remove();if(!r.ok)throw new Error(data.detail||'AI request failed');state.analysis=data;addMessage('ai',formatAI(data));if(data.fixed_code){renderPanel('diff');addHistory('AI proposal',`${mode} · ${f.name}`)}else renderPanel('analysis');setStatus('AI ready','ready')}catch(e){typing.remove();addMessage('ai',`AI request failed: ${e.message}`);setStatus('AI error','error')}}
  function applyAI(){const f=current();if(!f||!state.analysis?.fixed_code)return;f.content=state.analysis.fixed_code;f.dirty=f.content!==f.original;state.editor.setValue(f.content);renderTabs();renderTree();event('AI applied',`${f.name} · current workspace updated`,'ok');setStatus('AI changes applied','ready');if(isHtmlWorkspace()){updateWeb();scheduleLive()}else if(EXECUTABLE.has(f.language))setTimeout(()=>execute(true),200);renderPanel('diff');}
  function downloadCurrent(){const f=current();if(!f)return;const blob=new Blob([f.content],{type:'text/plain;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=f.name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);}
  async function downloadProject(){if(state.files.size<2){downloadCurrent();return}const zip=new JSZip();state.files.forEach(f=>zip.file(f.name,f.content));const blob=await zip.generateAsync({type:'blob'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='bugfalse-project.zip';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);}
  function createFile(name='untitled.txt'){name=name.trim()||'untitled.txt';if(!name.includes('.'))name+='.txt';if(state.files.has(name)){let i=2,base=name.replace(/(\.[^.]+)$/,'');const ext=(name.match(/\.[^.]+$/)||['.txt'])[0];while(state.files.has(`${base}-${i}${ext}`))i++;name=`${base}-${i}${ext}`;}openFile(name,'');addHistory('Created file',name);}
  function renameCurrent(name){const f=current();if(!f)return;name=name.trim();if(!name)return;if(!name.includes('.'))name+='.txt';if(name===f.name)return;if(state.files.has(name)){alert('A file with that name already exists.');return}state.files.delete(f.name);f.name=name;f.language=lang(name);state.files.set(name,f);state.active=name;setEditorLanguage();renderTabs();renderTree();updateContext();detect();updateWorkspaceMode();event('Renamed',name,'ok');}
  function saveCurrent(){const f=current();if(!f)return;sync();f.original=f.content;f.dirty=false;renderTabs();renderTree();event('Saved',f.name,'ok');setStatus('Saved','ready');}
  function showFileMenu(show=true){$('fileMenu').classList.toggle('hidden',!show);}
  function openTreeMenu(name){const f=state.files.get(name);if(!f)return;const action=prompt(`File: ${name}\nType an action: rename, download, delete`, '');if(action==='rename'){ $('renameFileName').value=name;$('renameModal').classList.remove('hidden');$('renameFileName').focus(); } else if(action==='download'){activateFile(name);downloadCurrent()} else if(action==='delete'){closeFile(name);}}
  function initMonaco(){require.config({paths:{vs:'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs'}});require(['vs/editor/editor.main'],()=>{state.monaco=monaco;state.editor=monaco.editor.create($('monaco'),{value:'',language:'plaintext',theme:'vs-dark',automaticLayout:true,fontSize:14,lineHeight:22,fontFamily:'JetBrains Mono,SFMono-Regular,Consolas,monospace',minimap:{enabled:true},padding:{top:14,bottom:14},scrollBeyondLastLine:false,smoothScrolling:true,wordWrap:'off'});state.editor.onDidChangeModelContent(()=>{if(!state.active)return;sync();scheduleLive()});state.editor.onDidChangeCursorPosition(()=>{const p=state.editor.getPosition();$('cursor').textContent=`Ln ${p.lineNumber}, Col ${p.column}`});});}

  function init(){
    initMonaco(); renderPanel('output'); renderTree();
    $('fileMenuBtn').onclick=e=>{e.stopPropagation();showFileMenu($('fileMenu').classList.contains('hidden'));};
    document.addEventListener('click',e=>{if(!e.target.closest('.file-menu')&&!e.target.closest('#fileMenuBtn'))showFileMenu(false);});
    document.querySelectorAll('[data-file-action]').forEach(b=>b.onclick=()=>{const a=b.dataset.fileAction;showFileMenu(false);if(a==='new'){$('newFileName').value='untitled.txt';$('newFileModal').classList.remove('hidden');$('newFileName').focus();}if(a==='open')$('fileInput').click();if(a==='folder')$('folderInput').click();if(a==='rename'){const f=current();if(f){$('renameFileName').value=f.name;$('renameModal').classList.remove('hidden');$('renameFileName').focus();}}if(a==='save')saveCurrent();if(a==='download')state.files.size>1?downloadProject():downloadCurrent();if(a==='delete'&&current())closeFile(current().name);});
    $('openBtn').onclick=()=>$('fileInput').click();$('emptyOpen').onclick=()=>$('fileInput').click();$('emptyNew').onclick=()=>{$('newFileName').value='untitled.txt';$('newFileModal').classList.remove('hidden');$('newFileName').focus()};$('newFileBtn').onclick=()=>$('emptyNew').click();
    $('fileInput').onchange=e=>{openFiles(e.target.files);e.target.value=''};$('folderInput').onchange=e=>{openFiles(e.target.files);e.target.value=''};
    $('sampleBtn')?.addEventListener('click',()=>openFile('main.py',sample)); $('downloadBtn').onclick=()=>state.files.size>1?downloadProject():downloadCurrent(); $('runBtn').onclick=()=>execute(false); $('stopBtn').onclick=()=>state.abort?.abort();
    $('liveToggle').onchange=()=>{if($('liveToggle').checked)scheduleLive()};$('debounceSelect').onchange=e=>state.debounce=Number(e.target.value);$('minimapToggle').onchange=e=>state.editor?.updateOptions({minimap:{enabled:e.target.checked}});
    $('settingsBtn').onclick=()=>$('settingsModal').classList.remove('hidden');$('themeBtn').onclick=()=>{state.theme=state.theme==='dark'?'light':'dark';document.body.classList.toggle('light',state.theme==='light');if(state.editor)state.monaco.editor.setTheme(state.theme==='light'?'vs':'vs-dark')};
    $('closeAi').onclick=()=>{$('aiPanel').classList.add('collapsed');$('reopenAi').classList.remove('hidden')};$('reopenAi').onclick=()=>{$('aiPanel').classList.remove('collapsed');$('reopenAi').classList.add('hidden')};
    document.querySelectorAll('.ai-modes button').forEach(b=>b.onclick=()=>ai(b.dataset.mode));document.querySelectorAll('.quick button').forEach(b=>b.onclick=()=>ai('analyze',b.dataset.question));$('sendAi').onclick=()=>{const q=$('aiInput').value.trim();if(!q)return;$('aiInput').value='';const mode=/improv/i.test(q)?'improve':/fix|bug|error|fail/i.test(q)?'fix':'analyze';ai(mode,q)};$('aiInput').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('sendAi').click()}};
    $('createFileConfirm').onclick=()=>{$('newFileModal').classList.add('hidden');createFile($('newFileName').value)};$('newFileName').onkeydown=e=>{if(e.key==='Enter')$('createFileConfirm').click()};$('renameFileConfirm').onclick=()=>{$('renameModal').classList.add('hidden');renameCurrent($('renameFileName').value)};$('renameFileName').onkeydown=e=>{if(e.key==='Enter')$('renameFileConfirm').click()};
    document.querySelectorAll('.panel-tab').forEach(b=>b.onclick=()=>renderPanel(b.dataset.panel));
    document.querySelectorAll('.inspect-tab').forEach(b=>b.onclick=()=>renderInspect(b.dataset.inspect));
    document.querySelectorAll('[data-viewport]').forEach(b=>b.onclick=()=>{state.viewport=b.dataset.viewport;document.querySelectorAll('[data-viewport]').forEach(x=>x.classList.toggle('active',x===b));const f=$('previewFrame');f.classList.remove('vp-tablet','vp-mobile');if(state.viewport==='tablet')f.classList.add('vp-tablet');if(state.viewport==='mobile')f.classList.add('vp-mobile');});
    $('webRefresh').onclick=()=>{if(isHtmlWorkspace()){updateWeb();event('Refresh','Live web output refreshed','ok')}};
    $('previewFrame').addEventListener('load',()=>{if(isHtmlWorkspace()){event('Rendered',`${current().name} · browser output ready`,'ok');setStatus('Live','ready')}});
    window.addEventListener('message',e=>{if(e.data?.source!=='bugfalse-web')return;const type=e.data.type||'log';const text=(e.data.args||[]).join(' ');state.webConsole.unshift({time:new Date().toLocaleTimeString(),type,text});state.webConsole=state.webConsole.slice(0,100);renderInspect('console');event(type.toUpperCase(),text,type==='error'?'bad':'');});
    document.addEventListener('click',e=>{const tab=e.target.closest('[data-file]');if(tab&&!e.target.closest('[data-close-file]'))activateFile(tab.dataset.file);const close=e.target.closest('[data-close-file]');if(close){e.stopPropagation();closeFile(close.dataset.closeFile)}const tree=e.target.closest('[data-tree-file]');if(tree&&!e.target.closest('[data-tree-menu]'))activateFile(tree.dataset.treeFile);const more=e.target.closest('[data-tree-menu]');if(more){e.stopPropagation();openTreeMenu(more.dataset.treeMenu)}if(e.target.id==='applyDiff')applyAI();if(e.target.id==='rejectDiff'){state.analysis={...state.analysis,fixed_code:null};renderPanel('diff')}const closeModal=e.target.closest('[data-close]');if(closeModal)$(closeModal.dataset.close)?.classList.add('hidden')});
    window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>{e.preventDefault();if(e.dataTransfer.files.length)openFiles(e.dataTransfer.files)});
    document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();execute(false)}if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();saveCurrent()}if((e.ctrlKey||e.metaKey)&&e.key==='o'){e.preventDefault();$('fileInput').click()}if(e.key==='Escape'){showFileMenu(false);document.querySelectorAll('.modal:not(.hidden)').forEach(m=>m.classList.add('hidden'))}});
  }
  init();
})();
