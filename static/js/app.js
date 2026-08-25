(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const LANG = {
    py:'python', js:'javascript', mjs:'javascript', cjs:'javascript', jsx:'javascript',
    ts:'typescript', tsx:'typescript', java:'java', c:'c', cc:'cpp', cpp:'cpp', cxx:'cpp',
    cs:'csharp', go:'go', rs:'rust', php:'php', rb:'ruby', swift:'swift', kt:'kotlin', kts:'kotlin',
    html:'html', htm:'html', css:'css', json:'json', sql:'sql', md:'markdown', yaml:'yaml', yml:'yaml', txt:'plaintext'
  };

  const EXECUTABLE = new Set(['python','javascript','typescript','php','ruby','go','rust','c','cpp','java','swift']);
  const WEB = new Set(['html','css','javascript','typescript']);
  const MAX_FILE_BYTES = 5 * 1024 * 1024;

  const state = {
    files: new Map(),
    active: null,
    editor: null,
    monaco: null,
    detected: null,
    events: [],
    problems: [],
    analysis: null,
    timer: null,
    debounce: Number(localStorage.getItem('bugfalse-debounce') || 800),
    requestRevision: 0,
    executionRevision: 0,
    aiRevision: 0,
    running: false,
    theme: localStorage.getItem('bugfalse-theme') || 'dark',
    viewport: 'desktop',
    codeAiMode: 'improve',
    pendingAi: false,
    suppressEditorChange: false,
    webSplit: Number(localStorage.getItem('bugfalse-web-split') || 40),
    live: localStorage.getItem('bugfalse-live') !== '0'
  };

  const current = () => state.active ? state.files.get(state.active) : null;
  const languageFor = (name) => LANG[(name.split('.').pop() || '').toLowerCase()] || 'plaintext';
  const isWebFile = (f = current()) => !!f && WEB.has(f.language);
  const hasHtmlProject = () => [...state.files.values()].some(f => f.language === 'html');
  const isWebWorkspace = () => !!current() && (current().language === 'html' || (WEB.has(current().language) && hasHtmlProject()));

  function setStatus(text, kind = 'ready') {
    $('statusText').textContent = text;
    $('statusDot').className = `status-dot ${kind}`;
  }

  function addEvent(type, detail, kind = '') {
    state.events.unshift({ time: new Date().toLocaleTimeString(), type, detail, kind });
    state.events = state.events.slice(0, 150);
    if ($('.panel-tab.active')?.dataset.panel === 'output') renderPanel('output');
  }

  function addProblem(message, line = null, severity = 'error') {
    state.problems = [{ message, line, severity }, ...state.problems].slice(0, 50);
    $('problemCount').textContent = String(state.problems.length);
    if ($('.panel-tab.active')?.dataset.panel === 'problems') renderPanel('problems');
  }

  function clearDiagnostics() {
    state.problems = [];
    $('problemCount').textContent = '0';
  }

  function syncFromEditor() {
    const f = current();
    if (!f || !state.editor) return false;
    const content = state.editor.getValue();
    if (content === f.content) return false;
    f.content = content;
    f.dirty = content !== f.original;
    renderTabs();
    renderTree();
    return true;
  }

  function updateHeader() {
    const f = current();
    $('workspaceName').textContent = f ? `${f.name}${f.dirty ? ' •' : ''}` : 'No file';
    $('fileStatus').textContent = f ? f.name : 'No file';
    const run = $('runBtn');
    const showRun = !!f && EXECUTABLE.has(f.language) && !isWebWorkspace();
    run.classList.toggle('hidden', !showRun);
    run.disabled = !f || state.running;
    run.textContent = state.running ? 'Running…' : 'Run';
  }

  async function detectProject() {
    const f = current();
    if (!f) { state.detected = null; return; }
    const files = {};
    state.files.forEach((v, k) => { files[k] = v.content.slice(0, 100000); });
    try {
      const response = await fetch('/runtime/detect', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ filename: f.name, files })
      });
      state.detected = response.ok ? await response.json() : null;
    } catch { state.detected = null; }
  }

  function setEditorLanguage() {
    if (!state.editor || !state.monaco) return;
    state.monaco.editor.setModelLanguage(state.editor.getModel(), current()?.language || 'plaintext');
  }

  function resetWorkspaceDiagnostics() {
    state.events = [];
    state.analysis = null;
    clearDiagnostics();
    renderPanel('output');
  }

  function openFile(name, content) {
    if (!name) return;
    const existing = state.files.get(name);
    const f = {
      name,
      content: String(content ?? ''),
      original: existing ? existing.original : String(content ?? ''),
      language: languageFor(name),
      dirty: existing ? existing.dirty : false
    };
    f.dirty = f.content !== f.original;
    state.files.set(name, f);
    state.active = name;
    if (state.editor) {
      state.suppressEditorChange = true;
      state.editor.setValue(f.content);
      state.suppressEditorChange = false;
      setEditorLanguage();
      state.editor.focus();
    }
    $('emptyState').classList.add('hidden');
    resetWorkspaceDiagnostics();
    renderTabs(); renderTree(); updateWorkspace();
    detectProject().then(updateWorkspace);
    addEvent('Opened', `${name}${isWebWorkspace() ? ' · live web workspace ready' : ''}`, 'ok');
    setStatus(isWebWorkspace() ? 'Live' : 'Ready', 'ready');
    scheduleLive(true);
  }

  function openFiles(fileList) {
    const files = [...fileList].filter((file) => file.size <= MAX_FILE_BYTES);
    if (!files.length) {
      addEvent('Import', `Files must be smaller than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`, 'bad');
      return;
    }
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => openFile(file.webkitRelativePath || file.name, reader.result || '');
      reader.onerror = () => addEvent('Import error', `${file.name} could not be read.`, 'bad');
      reader.readAsText(file);
    });
  }

  function activateFile(name) {
    const f = state.files.get(name);
    if (!f || !state.editor) return;
    state.active = name;
    state.suppressEditorChange = true;
    state.editor.setValue(f.content);
    state.suppressEditorChange = false;
    setEditorLanguage();
    resetWorkspaceDiagnostics();
    renderTabs(); renderTree(); updateWorkspace();
    detectProject().then(updateWorkspace);
    scheduleLive(true);
  }

  function closeFile(name) {
    if (!state.files.has(name)) return;
    const wasActive = state.active === name;
    state.files.delete(name);
    if (wasActive) {
      const next = state.files.keys().next().value;
      if (next) activateFile(next);
      else {
        state.active = null;
        state.suppressEditorChange = true;
        state.editor?.setValue('');
        state.suppressEditorChange = false;
        $('emptyState').classList.remove('hidden');
        resetWorkspaceDiagnostics();
        updateWorkspace();
      }
    }
    renderTabs(); renderTree();
  }

  function createFile(name) {
    let filename = (name || 'untitled.txt').trim() || 'untitled.txt';
    if (state.files.has(filename)) {
      const dot = filename.lastIndexOf('.');
      const base = dot > 0 ? filename.slice(0, dot) : filename;
      const ext = dot > 0 ? filename.slice(dot) : '.txt';
      let i = 2;
      while (state.files.has(`${base}-${i}${ext}`)) i++;
      filename = `${base}-${i}${ext}`;
    }
    openFile(filename, '');
    addEvent('Created', filename, 'ok');
  }

  function renameCurrent(newName) {
    const f = current();
    const name = (newName || '').trim();
    if (!f || !name || name === f.name) return;
    if (state.files.has(name)) { addEvent('Rename error', `${name} already exists.`, 'bad'); return; }
    state.files.delete(f.name);
    f.name = name;
    f.language = languageFor(name);
    state.files.set(name, f);
    state.active = name;
    setEditorLanguage();
    renderTabs(); renderTree(); updateWorkspace();
    detectProject().then(updateWorkspace);
    addEvent('Renamed', name, 'ok');
  }

  function saveCurrent() {
    const f = current();
    if (!f) return;
    syncFromEditor();
    f.original = f.content;
    f.dirty = false;
    renderTabs(); renderTree(); updateHeader();
    addEvent('Saved', f.name, 'ok');
    setStatus('Saved', 'ready');
  }

  function downloadBlob(name, content, type = 'text/plain') {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCurrent() { const f = current(); if (f) { syncFromEditor(); downloadBlob(f.name, f.content); addEvent('Downloaded', f.name, 'ok'); } }

  async function downloadProject() {
    if (!state.files.size) return;
    syncFromEditor();
    if (typeof JSZip === 'undefined') return downloadCurrent();
    const zip = new JSZip();
    state.files.forEach((f) => zip.file(f.name, f.content));
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = 'bugfalse-project.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    addEvent('Downloaded', 'bugfalse-project.zip', 'ok');
  }

  function renderTabs() {
    $('fileTabs').innerHTML = [...state.files.values()].map((f) =>
      `<button class="file-tab ${f.name === state.active ? 'active' : ''}" data-file="${esc(f.name)}" type="button">`+
      `<span class="lang">${esc(f.language)}</span><span class="tab-name">${esc(f.name.split('/').pop())}</span>`+
      `${f.dirty ? '<span class="dirty">●</span>' : ''}<span class="x" data-close-file="${esc(f.name)}">×</span></button>`
    ).join('');
  }

  function renderTree() {
    if (!state.files.size) { $('fileTree').innerHTML = '<div class="tree-empty">No files</div>'; return; }
    $('fileTree').innerHTML = [...state.files.values()].map((f) => {
      const icon = f.language === 'html' ? '<>' : f.language === 'python' ? 'py' : f.language === 'javascript' ? 'js' : f.language.slice(0, 3);
      return `<div class="tree-file ${f.name === state.active ? 'active' : ''}" data-tree-file="${esc(f.name)}">`+
        `<span class="tree-icon">${esc(icon)}</span><span class="tab-name">${esc(f.name)}</span>`+
        `${f.dirty ? '<b>●</b>' : ''}<button class="tree-more" data-tree-menu="${esc(f.name)}" type="button" aria-label="File actions">···</button></div>`;
    }).join('');
  }

  function updateWorkspace() {
    const web = isWebWorkspace();
    $('app').classList.toggle('has-file', !!current());
    $('app').classList.toggle('has-web', web);
    $('webPane').classList.toggle('hidden', !web);
    $('workspaceDivider').classList.toggle('hidden', !web);
    $('editorStage').classList.toggle('web-mode', web);
    updateHeader();
    if (web) {
      $('webPath').textContent = `/${current()?.name || 'index.html'}`;
      applyWebSplit();
      updateWeb();
    }
    refreshLayout();
  }

  function applyWebSplit() {
    if (!isWebWorkspace()) return;
    const editorPct = Math.max(30, Math.min(60, state.webSplit));
    $('editorPane').style.flexBasis = `${editorPct}%`;
    $('webPane').style.flexBasis = `${100 - editorPct}%`;
  }

  function buildWebSource() {
    const active = current();
    if (!active) return '';
    let html = active.language === 'html' ? active.content : '';
    if (!html) {
      const htmlFile = [...state.files.values()].find(f => f.language === 'html');
      html = htmlFile?.content || `<main>${esc(active.content)}</main>`;
    }
    const css = [...state.files.values()].filter(f => f.language === 'css').map(f => `<style data-bugfalse-file="${esc(f.name)}">${f.content}</style>`).join('\n');
    const js = [...state.files.values()].filter(f => f.language === 'javascript').map(f => `<script data-bugfalse-file="${esc(f.name)}">${f.content.replace(/<\/script/gi, '<\\/script')}</script>`).join('\n');
    const bridge = `<script>(function(){function send(type,args){parent.postMessage({source:'bugfalse-web',type,args:Array.from(args).map(function(x){try{return typeof x==='string'?x:JSON.stringify(x)}catch(e){return String(x)}})},'*')}['log','info','warn','error'].forEach(function(k){var old=console[k];console[k]=function(){send(k,arguments);old.apply(console,arguments)}});window.addEventListener('error',function(e){send('error',[e.message+' @ '+(e.filename||'page')+':'+e.lineno])});window.addEventListener('unhandledrejection',function(e){send('error',['Unhandled promise rejection',e.reason])});})();<\/script>`;
    if (/<html[\s>]/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>${bridge}${css}`).replace(/<\/body>/i, `${js}</body>`);
      if (!/<head[\s>]/i.test(html)) html = html.replace(/<html([^>]*)>/i, `<html$1><head>${bridge}${css}</head>`);
    } else {
      html = `<!doctype html><html><head><meta charset="utf-8">${bridge}${css}</head><body>${html}${js}</body></html>`;
    }
    return html;
  }

  function updateWeb() {
    if (!isWebWorkspace()) return;
    $('previewFrame').srcdoc = buildWebSource();
    $('previewStatus').textContent = `Live · ${new Date().toLocaleTimeString()}`;
  }

  function scheduleLive(immediate = false) {
    clearTimeout(state.timer);
    if (!state.live || !current()) return;
    state.timer = setTimeout(() => {
      syncFromEditor();
      if (isWebWorkspace()) {
        updateWeb();
        addEvent('Updated', `${current().name} changed · web output refreshed`, 'ok');
        setStatus('Live', 'ready');
      } else if (EXECUTABLE.has(current().language)) {
        execute(true);
      } else {
        validateLocal();
      }
    }, immediate ? 0 : state.debounce);
  }

  async function execute(live = false) {
    const f = current(); if (!f) return;
    syncFromEditor();
    if (isWebWorkspace()) { updateWeb(); return; }
    if (!EXECUTABLE.has(f.language)) { validateLocal(); return; }
    const revision = ++state.requestRevision;
    state.executionRevision = revision;
    state.running = true; updateHeader(); setStatus('Running', 'running');
    addEvent(live ? 'Live run' : 'Run', `${f.name} · ${f.language}`);
    try {
      const response = await fetch('/execute/', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({code:f.content, filename:f.name}) });
      const data = await response.json().catch(() => ({}));
      if (revision !== state.aiRevision) return;
      if (!response.ok) throw new Error(data.detail || `Execution request failed (${response.status})`);
      if (data.stdout) addEvent('stdout', data.stdout, 'ok');
      if (data.stderr) addEvent(data.ok ? 'stderr' : 'Error', data.stderr, data.ok ? '' : 'bad');
      parseProblems(data.stderr || '');
      addEvent('Finished', data.ok ? `exit code 0 · ${data.duration_ms ?? 0} ms` : `exit code ${data.exit_code ?? 'unknown'} · ${data.duration_ms ?? 0} ms`, data.ok ? 'ok' : 'bad');
      setStatus(data.ok ? 'Ready' : 'Error', data.ok ? 'ready' : 'error');
      renderPanel('output');
    } catch (error) {
      if (revision !== state.requestRevision) return;
      addEvent('Execution error', error.message || String(error), 'bad');
      addProblem(error.message || String(error));
      setStatus('Error', 'error');
    } finally {
      if (revision === state.executionRevision) { state.running = false; updateHeader(); }
    }
  }

  function parseProblems(text) {
    clearDiagnostics();
    if (!text) return;
    const python = text.match(/File "([^"]+)", line (\d+)[^\n]*\n([^\n]+)/m);
    if (python) addProblem(python[3].trim(), Number(python[2]));
    else if (/error|exception|traceback|syntaxerror|referenceerror|nameerror/i.test(text)) addProblem(text.split('\n').filter(Boolean).slice(-1)[0].slice(0, 500));
  }

  function validateLocal() {
    const f = current(); if (!f) return;
    clearDiagnostics();
    if (f.language === 'json') {
      try { JSON.parse(f.content); addEvent('Validated', 'Valid JSON', 'ok'); }
      catch (e) { addProblem(e.message); addEvent('Validation error', e.message, 'bad'); }
    } else if (f.language === 'yaml') {
      addEvent('Validated', 'YAML syntax validation requires a server-side YAML parser.', '');
    } else {
      addEvent('Ready', `${f.name} · live analysis available through CodeAI`, '');
    }
    renderPanel('output');
  }

  async function runCodeAI() {
    const f = current();
    if (!f) { $('codeAiStatus').textContent = 'Open a file first'; return; }
    if (state.pendingAi) return;
    const mode = state.codeAiMode;
    const instruction = mode === 'custom' ? $('codeAiPrompt').value.trim() : '';
    if (mode === 'custom' && !instruction) { $('codeAiStatus').textContent = 'Enter the change you want'; $('codeAiPrompt').focus(); return; }

    syncFromEditor();
    const source = f.content;
    state.pendingAi = true;
    const revision = ++state.aiRevision;
    $('codeAiStatus').textContent = 'Working…';
    setStatus('CodeAI', 'running');
    addEvent('CodeAI', `${f.name} · ${mode}`);
    updateHeader();

    try {
      const response = await fetch('/debug/', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({code:source, filename:f.name, language:f.language, framework:state.detected?.framework || '', mode, instruction})
      });
      const data = await response.json().catch(() => ({}));
      if (revision !== state.aiRevision) return;
      if (!response.ok) throw new Error(data.detail || `CodeAI request failed (${response.status})`);
      if (data.error) {
        const detail = [data.error, data.hint].filter(Boolean).join(' — ');
        addEvent('CodeAI error', detail, 'bad');
        $('codeAiStatus').textContent = `Failed: ${String(detail).slice(0, 90)}`;
        setStatus('CodeAI failed', 'error');
        renderPanel('output');
        return;
      }

      state.analysis = data;
      const updated = typeof data.fixed_code === 'string' ? data.fixed_code : '';
      if (['fix','improve','refactor','optimize','custom'].includes(mode) && !updated.trim()) {
        const reason = data.analysis || 'AI returned no revised code.';
        addEvent('CodeAI error', reason, 'bad');
        $('codeAiStatus').textContent = `Failed: ${String(reason).slice(0, 90)}`;
        setStatus('CodeAI failed', 'error');
        renderPanel('output');
        return;
      }
      const shouldApply = ['fix','improve','refactor','optimize'].includes(mode) || mode === 'custom';
      if (shouldApply && updated.trim() && updated.trim() !== source.trim()) {
        f.content = updated;
        f.dirty = updated !== f.original;
        state.suppressEditorChange = true;
        state.editor.setValue(updated);
        state.suppressEditorChange = false;
        renderTabs(); renderTree(); updateHeader();
        addEvent('CodeAI applied', `${f.name} updated`, 'ok');
        if (isWebWorkspace()) {
          updateWeb();
          addEvent('Rendered', `${f.name} · web output refreshed`, 'ok');
          setStatus('Live', 'ready');
        } else if (EXECUTABLE.has(f.language)) {
          await execute(true);
        } else {
          validateLocal();
        }
        $('codeAiStatus').textContent = 'Applied · live result updated';
      } else {
        addEvent('CodeAI', `No code change was necessary${data.analysis ? ` · ${String(data.analysis).slice(0, 180)}` : ''}`, 'ok');
        $('codeAiStatus').textContent = 'No changes needed';
        setStatus('Ready', 'ready');
      }
      renderPanel('output');
    } catch (error) {
      if (revision === state.aiRevision) {
        const message = error?.message || String(error);
        addEvent('CodeAI error', message, 'bad');
        $('codeAiStatus').textContent = `Failed: ${message.slice(0, 90)}`;
        setStatus('CodeAI failed', 'error');
        renderPanel('output');
      }
    } finally {
      if (revision === state.aiRevision) { state.pendingAi = false; updateHeader(); }
    }
  }

  function setCodeAiMode(mode) {
    state.codeAiMode = mode;
    document.querySelectorAll('[data-codeai-mode]').forEach((b) => b.classList.toggle('active', b.dataset.codeaiMode === mode));
    $('codeAiPrompt').classList.toggle('hidden', mode !== 'custom');
    $('runCodeAi').textContent = mode === 'custom' ? 'Apply' : 'Run';
    $('codeAiStatus').textContent = mode === 'custom' ? 'Waiting for your instruction' : 'Ready';
    if (mode === 'custom') $('codeAiPrompt').focus();
  }

  function renderPanel(panel) {
    document.querySelectorAll('.panel-tab').forEach((b) => b.classList.toggle('active', b.dataset.panel === panel));
    const content = $('panelContent');
    if (panel === 'output') {
      content.innerHTML = state.events.length ? state.events.map((e) => `<div class="event ${e.kind}"><span>${esc(e.time)}</span><b>${esc(e.type)}</b><span>${esc(e.detail)}</span></div>`).join('') : '<div class="empty-panel">No live output yet.</div>';
    } else {
      content.innerHTML = state.problems.length ? state.problems.map((p) => `<div class="problem"><span class="sev">${esc(p.severity.toUpperCase())}</span><div><strong>${esc(p.message)}</strong>${p.line ? `<small>Line ${p.line}</small>` : ''}</div></div>`).join('') : '<div class="empty-panel">No problems.</div>';
    }
  }

  function initMonaco() {
    require.config({ paths:{ vs:'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
    require(['vs/editor/editor.main'], () => {
      state.monaco = monaco;
      state.editor = monaco.editor.create($('monaco'), {
        value:'', language:'plaintext', theme:state.theme === 'light' ? 'vs' : 'vs-dark', automaticLayout:true,
        fontSize:14, lineHeight:22, fontFamily:'JetBrains Mono,SFMono-Regular,Consolas,monospace',
        minimap:{enabled:localStorage.getItem('bugfalse-minimap') !== '0'}, padding:{top:8,bottom:8},
        scrollBeyondLastLine:false, smoothScrolling:true, wordWrap:'off', tabSize:4
      });
      state.editor.onDidChangeModelContent(() => {
        if (!state.active || state.suppressEditorChange) return;
        const changed = syncFromEditor();
        if (!changed) return;
        setStatus('Unsaved', 'ready');
        scheduleLive();
      });
      state.editor.onDidChangeCursorPosition(() => {
        const p = state.editor.getPosition();
        $('cursor').textContent = `Ln ${p.lineNumber}, Col ${p.column}`;
      });
      updateWorkspace();
    });
  }

  function initWebSplitter() {
    const divider = $('workspaceDivider');
    let dragging = false;
    const move = (event) => {
      if (!dragging || !isWebWorkspace()) return;
      const rect = $('editorStage').getBoundingClientRect();
      const x = Math.max(280, Math.min(rect.width - 360, event.clientX - rect.left));
      state.webSplit = Math.max(30, Math.min(60, x / rect.width * 100));
      applyWebSplit(); state.editor?.layout();
    };
    const end = () => { dragging = false; divider.classList.remove('dragging'); document.body.style.cursor = ''; localStorage.setItem('bugfalse-web-split', String(state.webSplit)); };
    divider.addEventListener('pointerdown', (e) => { dragging = true; divider.classList.add('dragging'); divider.setPointerCapture?.(e.pointerId); document.body.style.cursor = 'col-resize'; });
    divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', end); divider.addEventListener('pointercancel', end);
  }

  function setSidebarCollapsed(collapsed) {
    $('app').classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem('bugfalse-sidebar-collapsed', collapsed ? '1' : '0');
    refreshLayout();
  }
  function setBottomCollapsed(collapsed) {
    $('bottomPanel').classList.toggle('collapsed', collapsed);
    $('bottomToggle').textContent = collapsed ? '⌃' : '⌄';
    localStorage.setItem('bugfalse-bottom-collapsed', collapsed ? '1' : '0');
    refreshLayout();
  }
  function refreshLayout() { requestAnimationFrame(() => state.editor?.layout()); }
  function showFileMenu(show) { $('fileMenu').classList.toggle('hidden', !show); }

  function init() {
    document.body.classList.toggle('light', state.theme === 'light');
    initMonaco(); renderTabs(); renderTree(); renderPanel('output');
    setSidebarCollapsed(localStorage.getItem('bugfalse-sidebar-collapsed') === '1');
    setBottomCollapsed(localStorage.getItem('bugfalse-bottom-collapsed') === '1');

    $('fileMenuBtn').onclick = (e) => { e.stopPropagation(); showFileMenu($('fileMenu').classList.contains('hidden')); };
    document.addEventListener('click', (e) => { if (!e.target.closest('#fileMenu') && !e.target.closest('#fileMenuBtn')) showFileMenu(false); });

    document.querySelectorAll('[data-file-action]').forEach((button) => button.addEventListener('click', () => {
      const action = button.dataset.fileAction; showFileMenu(false);
      if (action === 'new') { $('newFileName').value = 'untitled.txt'; $('newFileModal').classList.remove('hidden'); $('newFileName').focus(); }
      if (action === 'open') $('fileInput').click();
      if (action === 'folder') $('folderInput').click();
      if (action === 'save') saveCurrent();
      if (action === 'rename') { const f = current(); if (f) { $('renameFileName').value = f.name; $('renameModal').classList.remove('hidden'); $('renameFileName').focus(); } }
      if (action === 'download') state.files.size > 1 ? downloadProject() : downloadCurrent();
      if (action === 'delete' && current()) closeFile(current().name);
    }));

    $('newFileBtn').onclick = () => { $('newFileName').value = 'untitled.txt'; $('newFileModal').classList.remove('hidden'); $('newFileName').focus(); };
    $('fileInput').onchange = (e) => { openFiles(e.target.files); e.target.value = ''; };
    $('folderInput').onchange = (e) => { openFiles(e.target.files); e.target.value = ''; };
    $('runBtn').onclick = () => execute(false);
    $('settingsBtn').onclick = () => $('settingsModal').classList.remove('hidden');
    $('themeBtn').onclick = () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('bugfalse-theme', state.theme); document.body.classList.toggle('light', state.theme === 'light'); state.monaco?.editor.setTheme(state.theme === 'light' ? 'vs' : 'vs-dark'); };
    $('bottomToggle').onclick = () => setBottomCollapsed(!$('bottomPanel').classList.contains('collapsed'));
    $('debounceSelect').value = String(state.debounce);
    $('debounceSelect').onchange = (e) => { state.debounce = Number(e.target.value); localStorage.setItem('bugfalse-debounce', String(state.debounce)); };
    $('minimapToggle').checked = localStorage.getItem('bugfalse-minimap') !== '0';
    $('minimapToggle').onchange = (e) => { localStorage.setItem('bugfalse-minimap', e.target.checked ? '1' : '0'); state.editor?.updateOptions({minimap:{enabled:e.target.checked}}); };

    $('codeAiToggle').onclick = (e) => { e.stopPropagation(); $('codeAiPopover').classList.toggle('hidden'); };
    $('closeCodeAi').onclick = () => $('codeAiPopover').classList.add('hidden');
    document.querySelectorAll('[data-codeai-mode]').forEach((b) => b.onclick = () => setCodeAiMode(b.dataset.codeaiMode));
    $('runCodeAi').onclick = runCodeAI;
    $('codeAiPrompt').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runCodeAI(); });

    document.querySelectorAll('.panel-tab').forEach((b) => b.onclick = () => renderPanel(b.dataset.panel));
    document.querySelectorAll('[data-viewport]').forEach((b) => b.onclick = () => {
      state.viewport = b.dataset.viewport;
      document.querySelectorAll('[data-viewport]').forEach((x) => x.classList.toggle('active', x === b));
      $('previewFrame').classList.remove('vp-tablet','vp-mobile');
      if (state.viewport !== 'desktop') $('previewFrame').classList.add(`vp-${state.viewport}`);
    });
    $('webRefresh').onclick = () => { updateWeb(); addEvent('Refresh', 'Web output refreshed', 'ok'); };
    initWebSplitter();

    $('previewFrame').addEventListener('load', () => { if (isWebWorkspace()) { $('previewStatus').textContent = `Live · ${new Date().toLocaleTimeString()}`; addEvent('Rendered', `${current().name} · browser output ready`, 'ok'); } });
    window.addEventListener('message', (e) => {
      if (e.data?.source !== 'bugfalse-web') return;
      const text = (e.data.args || []).join(' ');
      const type = e.data.type || 'log';
      addEvent(type.toUpperCase(), text, type === 'error' ? 'bad' : '');
      if (type === 'error') addProblem(text);
    });

    document.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-file]');
      if (tab && !e.target.closest('[data-close-file]')) activateFile(tab.dataset.file);
      const close = e.target.closest('[data-close-file]');
      if (close) { e.stopPropagation(); closeFile(close.dataset.closeFile); }
      const tree = e.target.closest('[data-tree-file]');
      if (tree && !e.target.closest('[data-tree-menu]')) activateFile(tree.dataset.treeFile);
      const more = e.target.closest('[data-tree-menu]');
      if (more) {
        e.stopPropagation();
        const name = more.dataset.treeMenu;
        const action = prompt(`File: ${name}\nType rename or delete`, 'cancel');
        if (action === 'rename') { activateFile(name); $('renameFileName').value = name; $('renameModal').classList.remove('hidden'); $('renameFileName').focus(); }
        if (action === 'delete') closeFile(name);
      }
      const closeModal = e.target.closest('[data-close]');
      if (closeModal) $(closeModal.dataset.close)?.classList.add('hidden');
    });

    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files); });

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrent(); }
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('fileInput').click(); }
      if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); setSidebarCollapsed(!$('app').classList.contains('sidebar-collapsed')); }
      if (mod && e.key === 'Enter' && current() && EXECUTABLE.has(current().language) && !isWebWorkspace()) { e.preventDefault(); execute(false); }
      if (e.key === 'Escape') { showFileMenu(false); $('codeAiPopover').classList.add('hidden'); document.querySelectorAll('.modal:not(.hidden)').forEach((m) => m.classList.add('hidden')); }
    });

    $('createFileConfirm').onclick = () => { $('newFileModal').classList.add('hidden'); createFile($('newFileName').value); };
    $('newFileName').onkeydown = (e) => { if (e.key === 'Enter') $('createFileConfirm').click(); };
    $('renameFileConfirm').onclick = () => { $('renameModal').classList.add('hidden'); renameCurrent($('renameFileName').value); };
    $('renameFileName').onkeydown = (e) => { if (e.key === 'Enter') $('renameFileConfirm').click(); };

    window.addEventListener('resize', refreshLayout);
  }

  init();
})();
