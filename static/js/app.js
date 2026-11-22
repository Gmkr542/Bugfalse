(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const LANG_MAP = {
    py:'python', js:'javascript', mjs:'javascript', cjs:'javascript', jsx:'javascript',
    ts:'typescript', tsx:'typescript', html:'html', htm:'html', css:'css', scss:'css',
    json:'json', md:'markdown', yaml:'yaml', yml:'yaml', sql:'sql', sh:'shell',
    java:'java', c:'c', cpp:'cpp', h:'cpp', cs:'csharp', go:'go', rs:'rust',
    php:'php', rb:'ruby', swift:'swift', kt:'kotlin', xml:'xml', svg:'xml'
  };
  const WEB_LANGS = new Set(['html', 'css', 'javascript', 'typescript']);
  const SAMPLE_FILES = {
    'main.py': `def calculate_total(items):
    total = 0
    for item in items:
        if item is None:
            continue
        total += item.price
    return total

class Item:
    def __init__(self, price):
        self.price = price

print(calculate_total([Item(10), None, Item(25)]))
`,
    'utils.py': `def safe_divide(a, b):
    # Intentional bug: missing zero check
    return a / b
`
  };

  const state = {
    files: new Map(),
    active: null,
    editor: null,
    monaco: null,
    theme: localStorage.getItem('bf-theme') || 'dark',
    live: localStorage.getItem('bf-live') !== '0',
    autoHeal: localStorage.getItem('bf-autoheal') === '1',
    minimap: localStorage.getItem('bf-minimap') !== '0',
    problems: [],
    lastAnalysis: null,
    lastAiPrevious: null,
    repoMeta: null,
    suppressChange: false,
    liveTimer: null,
    busyAi: false,
  };

  const current = () => (state.active ? state.files.get(state.active) : null);
  const langFor = (name) => LANG_MAP[(name.split('.').pop() || '').toLowerCase()] || 'plaintext';
  const isWebMode = () => {
    const f = current();
    if (!f) return false;
    if (f.language === 'html') return true;
    return WEB_LANGS.has(f.language) && [...state.files.values()].some((x) => x.language === 'html');
  };

  function setStatus(text) {
    $('statusState').textContent = text;
  }

  function termLog(text, kind = 'sys') {
    const hist = $('terminalHistory');
    const div = document.createElement('div');
    div.className = `term-line ${kind}`;
    div.textContent = text;
    hist.appendChild(div);
    hist.scrollTop = hist.scrollHeight;
  }

  function appendCopilot(text, role = 'bot') {
    const box = $('copilotMessages');
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function setProblems(items) {
    state.problems = items || [];
    $('problemBadge').textContent = String(state.problems.length);
    $('statusProblems').textContent = `⊗ ${state.problems.length}`;
    const list = $('problemsList');
    if (!state.problems.length) {
      list.innerHTML = '<div class="empty-msg">No problems have been detected in the workspace.</div>';
      return;
    }
    list.innerHTML = state.problems.map((p) =>
      `<div class="problem-row" data-jump-line="${Number(p.line) || 1}">` +
      `<span class="sev">${esc((p.severity || 'ERROR').toUpperCase())}</span>` +
      `<span>${esc(p.message || '')}</span>` +
      `${p.line ? `<small style="margin-left:auto;color:var(--text-muted)">Ln ${esc(p.line)}</small>` : ''}` +
      `</div>`
    ).join('');
  }

  function switchSideView(viewName) {
    $('primarySidebar').classList.remove('collapsed');
    $('toggleSidebarBtn').classList.add('active');
    document.querySelectorAll('.activity-btn[data-sideview]').forEach((b) => {
      b.classList.toggle('active', b.dataset.sideview === viewName);
    });
    document.querySelectorAll('.sideview').forEach((v) => {
      v.classList.toggle('hidden', v.id !== `sideview-${viewName}`);
    });
    requestAnimationFrame(() => state.editor?.layout());
  }

  function switchBottomTab(tabName) {
    $('bottomPanel').classList.remove('collapsed');
    $('togglePanelBtn').classList.add('active');
    document.querySelectorAll('.panel-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.bottom === tabName);
    });
    document.querySelectorAll('.bottom-view').forEach((v) => {
      v.classList.toggle('hidden', v.id !== `bottom-${tabName}`);
    });
    requestAnimationFrame(() => state.editor?.layout());
  }

  function renderTabs() {
    const bar = $('fileTabs');
    bar.innerHTML = [...state.files.values()].map((f) =>
      `<button class="tab ${f.name === state.active ? 'active' : ''}" data-open-tab="${esc(f.name)}" type="button">` +
      `<span class="t-lang">${esc(f.language.slice(0, 4))}</span>` +
      `<span class="t-name">${esc(f.name.split('/').pop())}</span>` +
      `${f.dirty ? '<span class="tree-dirty">●</span>' : ''}` +
      `<span class="t-close" data-close-tab="${esc(f.name)}">×</span>` +
      `</button>`
    ).join('');
  }

  function renderTree() {
    const tree = $('fileTree');
    if (!state.files.size) {
      tree.innerHTML = '<div class="tree-empty">No files open. Create a file, import from disk, or paste a GitHub repo URL.</div>';
      return;
    }
    const sorted = [...state.files.values()].sort((a, b) => a.name.localeCompare(b.name));
    tree.innerHTML = sorted.map((f) =>
      `<div class="tree-item ${f.name === state.active ? 'active' : ''}" data-tree-open="${esc(f.name)}" title="${esc(f.name)}">` +
      `<span class="tree-badge">${esc(f.language.slice(0, 3))}</span>` +
      `<span class="tree-path">${esc(f.name)}</span>` +
      `${f.dirty ? '<span class="tree-dirty">●</span>' : ''}` +
      `<span class="tree-del" data-tree-del="${esc(f.name)}">×</span>` +
      `</div>`
    ).join('');
  }

  function updateWorkbenchUI() {
    const f = current();
    $('welcomeScreen').classList.toggle('hidden', !!f);
    $('breadcrumbs').textContent = f ? `BugFalse Studio › ${f.name.split('/').join(' › ')}` : 'BugFalse Studio › Welcome';
    $('statusLang').textContent = f ? f.language.toUpperCase() : 'Plain Text';
    $('copilotContext').textContent = f ? f.name : 'No active file';
    $('commandBarLabel').textContent = f ? `${f.name} — BugFalse Studio` : 'BugFalse — Search files, import GitHub repo, or run AI…';

    const web = isWebMode();
    $('webPane').classList.toggle('hidden', !web);
    $('webSash').classList.toggle('hidden', !web);
    if (web) {
      $('webAddress').textContent = `localhost:8000/${f.name}`;
      refreshWebPreview();
    }
    requestAnimationFrame(() => state.editor?.layout());
  }

  function openFile(name, content = '', activate = true) {
    const existing = state.files.get(name);
    const fileObj = {
      name,
      content: String(content ?? ''),
      original: existing ? existing.original : String(content ?? ''),
      language: langFor(name),
      dirty: false,
    };
    fileObj.dirty = fileObj.content !== fileObj.original;
    state.files.set(name, fileObj);
    if (activate) activateFile(name);
    else {
      renderTabs();
      renderTree();
    }
  }

  function activateFile(name) {
    const f = state.files.get(name);
    if (!f) return;
    state.active = name;
    state.lastAiPrevious = null;
    $('aiDiffBanner')?.classList.add('hidden');
    if (state.editor && state.monaco) {
      state.suppressChange = true;
      state.editor.setValue(f.content);
      state.monaco.editor.setModelLanguage(state.editor.getModel(), f.language);
      state.suppressChange = false;
      state.editor.focus();
    }
    renderTabs();
    renderTree();
    updateWorkbenchUI();
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
        if (state.editor) {
          state.suppressChange = true;
          state.editor.setValue('');
          state.suppressChange = false;
        }
        updateWorkbenchUI();
      }
    }
    renderTabs();
    renderTree();
  }

  function syncEditorContent() {
    const f = current();
    if (!f || !state.editor) return;
    const val = state.editor.getValue();
    if (val !== f.content) {
      f.content = val;
      f.dirty = val !== f.original;
      renderTabs();
      renderTree();
    }
  }

  function refreshWebPreview() {
    if (!isWebMode()) return;
    const active = current();
    let html = active.language === 'html' ? active.content : '';
    if (!html) {
      const htmlFile = [...state.files.values()].find((x) => x.language === 'html');
      html = htmlFile ? htmlFile.content : `<pre>${esc(active.content)}</pre>`;
    }
    const css = [...state.files.values()].filter((x) => x.language === 'css').map((x) => `<style>${x.content}</style>`).join('
');
    const js = [...state.files.values()].filter((x) => x.language === 'javascript').map((x) => `<script>${x.content.replace(/<\/script/gi, '<\/script')}</script>`).join('
');
    if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `${css}</head>`);
    else html = `${css}${html}`;
    if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, `${js}</body>`);
    else html = `${html}${js}`;
    $('previewFrame').srcdoc = html;
  }

  // ── GitHub Repository Import by URL ──
  async function importGithubRepository(rawUrl, branch = '', subpath = '', statusTarget = null) {
    const repoUrl = (rawUrl || '').trim();
    if (!repoUrl) {
      if (statusTarget) {
        statusTarget.textContent = 'Enter a GitHub repository URL or owner/repo.';
        statusTarget.className = 'side-status err';
      }
      return false;
    }

    setStatus('Importing GitHub…');
    termLog(`$ git import ${repoUrl}${branch ? ' -b ' + branch : ''}`, 'user');
    if (statusTarget) {
      statusTarget.textContent = 'Downloading repository from GitHub…';
      statusTarget.className = 'side-status';
    }

    try {
      const res = await fetch('/github/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo_url: repoUrl, branch: branch || null, subpath: subpath || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `GitHub import failed (${res.status})`);

      const entries = Object.entries(data.files || {});
      if (!entries.length) throw new Error('Repository contained no supported source files.');

      state.files.clear();
      entries.forEach(([path, text]) => openFile(path, text, false));
      activateFile(entries[0][0]);

      state.repoMeta = { owner: data.owner, repo: data.repo, branch: data.branch };
      $('statusBranch').textContent = `⎇ ${data.owner}/${data.repo}@${data.branch}`;
      const banner = $('repoBanner');
      banner.textContent = `${data.owner}/${data.repo} (${data.branch})`;
      banner.classList.remove('hidden');

      const summary = `Imported ${data.imported_count} files from ${data.owner}/${data.repo} (${data.branch}).`;
      termLog(summary, 'sys');
      appendCopilot(`${summary} Ask me anything about this codebase or click Auto-Fix / Improve.`, 'bot');
      if (statusTarget) {
        statusTarget.textContent = summary;
        statusTarget.className = 'side-status ok';
      }
      setStatus('Ready');
      return true;
    } catch (err) {
      const msg = err?.message || String(err);
      termLog(`GitHub import error: ${msg}`, 'err');
      if (statusTarget) {
        statusTarget.textContent = msg;
        statusTarget.className = 'side-status err';
      }
      setStatus('Import Failed');
      return false;
    }
  }

  // ── AI Auto-Fix / Improve / Analyze ──
  async function runAiAction(mode = 'fix', instruction = '') {
    const f = current();
    if (!f) {
      termLog('No active file open. Open or import a file first.', 'err');
      switchBottomTab('terminal');
      return;
    }
    if (state.busyAi) return;

    syncEditorContent();
    const originalCode = f.content;
    state.busyAi = true;
    setStatus(`AI ${mode}…`);
    termLog(`$ bugfalse ai --mode=${mode} ${f.name}`, 'user');

    try {
      const res = await fetch('/debug/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: originalCode,
          filename: f.name,
          language: f.language,
          mode,
          instruction: instruction || null,
          apiKey: localStorage.getItem('bf-groq-key') || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `AI request failed (${res.status})`);

      if (data.error) {
        const msg = [data.error, data.hint].filter(Boolean).join(' — ');
        termLog(`AI Error: ${msg}`, 'err');
        setProblems(data.issues || []);
        setStatus('AI Error');
        return;
      }

      state.lastAnalysis = data;
      setProblems(data.issues || []);
      renderAiReview(data);

      const shouldApply = ['fix', 'improve', 'refactor', 'optimize', 'custom'].includes(mode);
      const revised = typeof data.fixed_code === 'string' ? data.fixed_code : '';

      if (shouldApply && revised.trim() && revised.trim() !== originalCode.trim()) {
        state.lastAiPrevious = { name: f.name, content: originalCode };
        f.content = revised;
        f.dirty = revised !== f.original;
        if (state.editor) {
          state.suppressChange = true;
          state.editor.setValue(revised);
          state.suppressChange = false;
        }
        renderTabs();
        renderTree();
        refreshWebPreview();
        $('aiDiffBanner')?.classList.remove('hidden');
        termLog(`✔ Applied AI ${mode} updates to ${f.name}.`, 'ai');
        appendCopilot(`Applied **${mode}** to \`${f.name}\`:
${data.analysis || 'Code updated.'}`, 'bot');
      } else {
        termLog(`✔ AI ${mode} complete: ${data.analysis || 'No code edits required.'}`, 'ai');
        appendCopilot(data.analysis || 'Analysis complete. Check the AI Review tab for details.', 'bot');
        switchBottomTab('review');
      }
      setStatus('Ready');
    } catch (err) {
      termLog(`AI failure: ${err?.message || String(err)}`, 'err');
      setStatus('AI Failed');
    } finally {
      state.busyAi = false;
    }
  }

  function renderAiReview(data) {
    const body = $('aiReviewBody');
    const issues = (data.issues || []).map((i) =>
      `<li><strong>${esc(i.type || i.severity || 'Issue')}</strong>${i.line ? ` (Ln ${esc(i.line)})` : ''}: ${esc(i.message || '')}</li>`
    ).join('');
    const imps = (data.improvements || []).map((s) =>
      `<li>${esc(typeof s === 'string' ? s : JSON.stringify(s))}</li>`
    ).join('');
    body.innerHTML =
      `<h4>AI ${esc((data.mode || 'review').toUpperCase())} Summary</h4>` +
      `<p>${esc(data.analysis || 'Completed.')}</p>` +
      (issues ? `<h4>Detected Issues</h4><ul>${issues}</ul>` : '') +
      (imps ? `<h4>Improvements &amp; Suggestions</h4><ul>${imps}</ul>` : '');
  }

  // ── Code Execution ──
  async function executeCurrentFile() {
    const f = current();
    if (!f) return;
    syncEditorContent();
    if (isWebMode()) {
      refreshWebPreview();
      termLog(`Refreshed live web preview for ${f.name}`, 'sys');
      return;
    }
    setStatus('Running…');
    termLog(`$ run ${f.name}`, 'user');
    switchBottomTab('output');
    $('executionOutput').textContent = `Running ${f.name}…`;

    try {
      const res = await fetch('/execute/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: f.name, code: f.content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Execution unavailable (${res.status})`);

      const outText = [
        data.stdout ? `STDOUT:
${data.stdout}` : '',
        data.stderr ? `STDERR:
${data.stderr}` : '',
        `Exit code: ${data.exit_code} · ${data.duration_ms ?? 0} ms`,
      ].filter(Boolean).join('

');
      $('executionOutput').textContent = outText;
      termLog(data.ok ? `✔ Exited with code 0 (${data.duration_ms} ms)` : `✖ Failed (exit ${data.exit_code})`, data.ok ? 'sys' : 'err');

      if (!data.ok && state.autoHeal) {
        termLog('Auto-Fix on Error is ON — invoking AI debugger…', 'ai');
        await runAiAction('fix', `Fix this runtime error:
${data.stderr || ''}`);
      }
      setStatus(data.ok ? 'Ready' : 'Runtime Error');
    } catch (err) {
      const msg = err?.message || String(err);
      $('executionOutput').textContent = msg;
      termLog(msg, 'err');
      setStatus('Execution Disabled');
    }
  }

  // ── AI Terminal & Copilot Chat ──
  async function sendAiChat(message, target = 'terminal') {
    const text = message.trim();
    if (!text) return;

    if (target === 'terminal') {
      termLog(`bugfalse@ai:~$ ${text}`, 'user');
      if (text === '/help') {
        termLog('Commands: /fix | /improve | /analyze | /run | /import <github-url> | /clear | or ask any question.', 'sys');
        return;
      }
      if (text === '/clear') {
        $('terminalHistory').innerHTML = '';
        return;
      }
      if (text === '/fix') return runAiAction('fix');
      if (text === '/improve') return runAiAction('improve');
      if (text === '/analyze') return runAiAction('analyze');
      if (text === '/run') return executeCurrentFile();
      if (text.startsWith('/import ')) {
        return importGithubRepository(text.slice(8).trim());
      }
    } else {
      appendCopilot(text, 'user');
    }

    const f = current();
    syncEditorContent();
    setStatus('AI Thinking…');
    try {
      const res = await fetch('/chatbot/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          code: f ? f.content : '',
          filename: f ? f.name : '',
          language: f ? f.language : '',
          apiKey: localStorage.getItem('bf-groq-key') || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      const reply = data.reply || data.detail || 'No response from AI.';
      if (target === 'terminal') termLog(reply, 'ai');
      else appendCopilot(reply, 'bot');
      setStatus('Ready');
    } catch (err) {
      const errMsg = `AI Chat Error: ${err?.message || String(err)}`;
      if (target === 'terminal') termLog(errMsg, 'err');
      else appendCopilot(errMsg, 'bot');
      setStatus('AI Error');
    }
  }

  // ── Command Palette ──
  const COMMANDS = [
    { label: 'GitHub: Import Repository from URL…', hint: 'Paste URL in box above & press Enter', run: () => switchSideView('github') },
    { label: 'AI: Auto-Fix Bugs in Active File', hint: 'Ctrl+Alt+F', run: () => runAiAction('fix') },
    { label: 'AI: Auto-Improve & Refactor Active File', hint: '', run: () => runAiAction('improve') },
    { label: 'AI: Security Audit Active File', hint: '', run: () => runAiAction('security') },
    { label: 'AI: Generate Unit Tests', hint: '', run: () => runAiAction('tests') },
    { label: 'File: New File…', hint: 'Ctrl+N', run: () => { $('newFileModal').classList.remove('hidden'); $('newFileName').focus(); } },
    { label: 'File: Open Local Files…', hint: 'Ctrl+O', run: () => $('fileInput').click() },
    { label: 'File: Open Local Folder…', hint: '', run: () => $('folderInput').click() },
    { label: 'File: Load Sample Python Project', hint: '', run: () => loadSampleWorkspace() },
    { label: 'Run: Execute Active File', hint: 'Ctrl+Enter', run: () => executeCurrentFile() },
    { label: 'View: Toggle Dark / Light Theme', hint: '', run: () => toggleTheme() },
  ];

  function openCommandPalette(prefill = '') {
    $('commandModal').classList.remove('hidden');
    const inp = $('paletteInput');
    inp.value = prefill;
    renderPaletteList(prefill);
    inp.focus();
  }

  function renderPaletteList(query) {
    const q = query.trim();
    const list = $('paletteList');
    const looksLikeRepo = /^(https?:\/\/)?(www\.)?github\.com\/|^[\w.-]+\/[\w.-]+$/i.test(q);
    let items = [];
    if (looksLikeRepo) {
      items.push({
        label: `Import GitHub Repository: ${q}`,
        hint: 'Press Enter',
        run: () => {
          $('commandModal').classList.add('hidden');
          switchSideView('github');
          $('sideGithubUrl').value = q;
          importGithubRepository(q, '', '', $('sideGithubStatus'));
        },
      });
    }
    const filtered = COMMANDS.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
    items = items.concat(filtered);
    list.innerHTML = items.map((item, idx) =>
      `<button class="palette-item" data-pal-idx="${idx}" type="button"><span>${esc(item.label)}</span><small>${esc(item.hint)}</small></button>`
    ).join('');
    list._items = items;
  }

  function loadSampleWorkspace() {
    Object.entries(SAMPLE_FILES).forEach(([k, v], idx) => openFile(k, v, idx === 0));
    termLog('Loaded sample Python workspace (main.py, utils.py). Try clicking Auto-Fix!', 'sys');
  }

  function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('bf-theme', state.theme);
    document.body.classList.toggle('light', state.theme === 'light');
    state.monaco?.editor.setTheme(state.theme === 'light' ? 'vs' : 'vs-dark');
  }

  async function exportWorkspaceZip() {
    if (!state.files.size) return;
    syncEditorContent();
    if (typeof JSZip === 'undefined') {
      const f = current();
      if (!f) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([f.content], { type: 'text/plain' }));
      a.download = f.name.split('/').pop();
      a.click();
      return;
    }
    const zip = new JSZip();
    state.files.forEach((f) => zip.file(f.name, f.content));
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.repoMeta?.repo || 'bugfalse-workspace'}.zip`;
    a.click();
  }

  function initMonaco() {
    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
    require(['vs/editor/editor.main'], () => {
      state.monaco = monaco;
      state.editor = monaco.editor.create($('monaco'), {
        value: '',
        language: 'plaintext',
        theme: state.theme === 'light' ? 'vs' : 'vs-dark',
        automaticLayout: true,
        fontSize: 13.5,
        lineHeight: 21,
        fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
        minimap: { enabled: state.minimap },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 4,
      });

      state.editor.onDidChangeModelContent(() => {
        if (state.suppressChange || !state.active) return;
        syncEditorContent();
        if (state.live && isWebMode()) {
          clearTimeout(state.liveTimer);
          state.liveTimer = setTimeout(refreshWebPreview, 400);
        }
      });

      state.editor.onDidChangeCursorPosition(() => {
        const p = state.editor.getPosition();
        $('statusCursor').textContent = `Ln ${p.lineNumber}, Col ${p.column}`;
      });
    });
  }

  function bindEvents() {
    document.body.classList.toggle('light', state.theme === 'light');
    initMonaco();

    // Top Menubar
    document.querySelectorAll('.menu-trigger').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const targetId = btn.dataset.menu;
        const menu = $(targetId);
        const wasHidden = menu.classList.contains('hidden');
        document.querySelectorAll('.dropdown-menu').forEach((m) => m.classList.add('hidden'));
        if (wasHidden) {
          const rect = btn.getBoundingClientRect();
          menu.style.left = `${rect.left}px`;
          menu.classList.remove('hidden');
        }
      };
    });
    document.addEventListener('click', () => document.querySelectorAll('.dropdown-menu').forEach((m) => m.classList.add('hidden')));

    // Menu & Toolbar Actions
    document.addEventListener('click', (e) => {
      const act = e.target.closest('[data-action]')?.dataset.action;
      if (act) {
        if (act === 'new-file') { $('newFileModal').classList.remove('hidden'); $('newFileName').focus(); }
        if (act === 'load-sample') loadSampleWorkspace();
        if (act === 'open-files') $('fileInput').click();
        if (act === 'open-folder') $('folderInput').click();
        if (act === 'import-github') switchSideView('github');
        if (act === 'save-file') {
          const f = current();
          if (f) { syncEditorContent(); f.original = f.content; f.dirty = false; renderTabs(); renderTree(); setStatus(`Saved ${f.name}`); }
        }
        if (act === 'rename-file') {
          const f = current();
          if (f) { $('renameInput').value = f.name; $('renameModal').classList.remove('hidden'); $('renameInput').focus(); }
        }
        if (act === 'export-zip') exportWorkspaceZip();
        if (act === 'close-file' && current()) closeFile(current().name);
        if (act === 'undo') state.editor?.trigger('menu', 'undo', null);
        if (act === 'redo') state.editor?.trigger('menu', 'redo', null);
        if (act === 'find') state.editor?.getAction('actions.find')?.run();
        if (act === 'format') state.editor?.getAction('editor.action.formatDocument')?.run();
        if (act === 'view-explorer') switchSideView('explorer');
        if (act === 'view-search') { switchSideView('search'); $('workspaceSearchInput').focus(); }
        if (act === 'view-github') switchSideView('github');
        if (act === 'toggle-terminal') { $('bottomPanel').classList.toggle('collapsed'); requestAnimationFrame(() => state.editor?.layout()); }
        if (act === 'toggle-theme') toggleTheme();
        if (act === 'run-code') executeCurrentFile();
        if (act === 'clear-terminal') $('terminalHistory').innerHTML = '';
      }

      const aiCmd = e.target.closest('[data-ai-cmd]')?.dataset.aiCmd;
      if (aiCmd) {
        if (aiCmd === 'explain') sendAiChat('Explain what this file does and highlight any edge cases.', 'copilot');
        else runAiAction(aiCmd);
      }

      const sideBtn = e.target.closest('.activity-btn[data-sideview]');
      if (sideBtn) switchSideView(sideBtn.dataset.sideview);

      const botTab = e.target.closest('.panel-tab[data-bottom]');
      if (botTab) switchBottomTab(botTab.dataset.bottom);

      const openTab = e.target.closest('[data-open-tab]');
      if (openTab && !e.target.closest('[data-close-tab]')) activateFile(openTab.dataset.openTab);

      const closeTab = e.target.closest('[data-close-tab]');
      if (closeTab) { e.stopPropagation(); closeFile(closeTab.dataset.closeTab); }

      const treeOpen = e.target.closest('[data-tree-open]');
      if (treeOpen && !e.target.closest('[data-tree-del]')) activateFile(treeOpen.dataset.treeOpen);

      const treeDel = e.target.closest('[data-tree-del]');
      if (treeDel) { e.stopPropagation(); closeFile(treeDel.dataset.treeDel); }

      const jump = e.target.closest('[data-jump-line]');
      if (jump && state.editor) {
        const ln = Number(jump.dataset.jumpLine) || 1;
        state.editor.revealLineInCenter(ln);
        state.editor.setPosition({ lineNumber: ln, column: 1 });
        state.editor.focus();
      }

      const closeModal = e.target.closest('[data-close]');
      if (closeModal) $(closeModal.dataset.close)?.classList.add('hidden');

      const palItem = e.target.closest('[data-pal-idx]');
      if (palItem) {
        const items = $('paletteList')._items || [];
        $('commandModal').classList.add('hidden');
        items[Number(palItem.dataset.palIdx)]?.run();
      }
    });

    // Top Quick Toolbar & Layout Toggles
    $('commandPaletteBtn').onclick = () => openCommandPalette('');
    $('topGithubBtn').onclick = () => switchSideView('github');
    $('topAutoFixBtn').onclick = () => runAiAction('fix');
    $('topImproveBtn').onclick = () => runAiAction('improve');
    $('topRunBtn').onclick = executeCurrentFile;
    $('tabFixBtn').onclick = () => runAiAction('fix');
    $('tabImproveBtn').onclick = () => runAiAction('improve');
    $('tabRunBtn').onclick = executeCurrentFile;

    $('toggleSidebarBtn').onclick = () => {
      $('primarySidebar').classList.toggle('collapsed');
      $('toggleSidebarBtn').classList.toggle('active');
      requestAnimationFrame(() => state.editor?.layout());
    };
    $('togglePanelBtn').onclick = () => {
      $('bottomPanel').classList.toggle('collapsed');
      $('togglePanelBtn').classList.toggle('active');
      requestAnimationFrame(() => state.editor?.layout());
    };
    $('toggleAiPanelBtn').onclick = () => {
      $('aiSidebar').classList.toggle('collapsed');
      $('toggleAiPanelBtn').classList.toggle('active');
      requestAnimationFrame(() => state.editor?.layout());
    };
    $('closeBottomBtn').onclick = () => { $('bottomPanel').classList.add('collapsed'); $('togglePanelBtn').classList.remove('active'); };
    $('clearBottomBtn').onclick = () => { $('terminalHistory').innerHTML = ''; $('executionOutput').textContent = ''; };

    // Welcome Screen & Sidebar Buttons
    $('welNewFile').onclick = () => { $('newFileModal').classList.remove('hidden'); $('newFileName').focus(); };
    $('welImportFiles').onclick = () => $('fileInput').click();
    $('welGithubRepo').onclick = () => { switchSideView('github'); $('sideGithubUrl').focus(); };
    $('welSampleCode').onclick = loadSampleWorkspace;
    $('welGithubGo').onclick = () => importGithubRepository($('welGithubInput').value, '', '', $('welGithubMsg'));
    $('welGithubInput').onkeydown = (e) => { if (e.key === 'Enter') $('welGithubGo').click(); };

    $('sideNewFileBtn').onclick = () => { $('newFileModal').classList.remove('hidden'); $('newFileName').focus(); };
    $('sideImportFileBtn').onclick = () => $('fileInput').click();
    $('sideGithubBtn').onclick = () => { switchSideView('github'); $('sideGithubUrl').focus(); };
    $('sideExportZipBtn').onclick = exportWorkspaceZip;
    $('sideGithubFetchBtn').onclick = () => importGithubRepository($('sideGithubUrl').value, $('sideGithubBranch').value, $('sideGithubSubpath').value, $('sideGithubStatus'));
    $('sideGithubUrl').onkeydown = (e) => { if (e.key === 'Enter') $('sideGithubFetchBtn').click(); };

    // Workspace Search
    $('workspaceSearchInput').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      const resBox = $('workspaceSearchResults');
      if (!q) { resBox.innerHTML = 'Type to search across all loaded files.'; return; }
      const hits = [];
      state.files.forEach((f) => {
        f.content.split('
').forEach((line, idx) => {
          if (line.toLowerCase().includes(q) && hits.length < 40) {
            hits.push({ file: f.name, line: idx + 1, text: line.trim() });
          }
        });
      });
      resBox.innerHTML = hits.length
        ? hits.map((h) => `<div class="search-hit" data-search-file="${esc(h.file)}" data-search-line="${h.line}"><strong>${esc(h.file)}:${h.line}</strong><code>${esc(h.text)}</code></div>`).join('')
        : 'No matches found.';
    };
    $('workspaceSearchResults').onclick = (e) => {
      const hit = e.target.closest('[data-search-file]');
      if (!hit) return;
      activateFile(hit.dataset.searchFile);
      const ln = Number(hit.dataset.searchLine) || 1;
      state.editor?.revealLineInCenter(ln);
      state.editor?.setPosition({ lineNumber: ln, column: 1 });
    };

    // Undo AI Edit
    $('revertAiBtn').onclick = () => {
      if (!state.lastAiPrevious) return;
      const f = state.files.get(state.lastAiPrevious.name);
      if (f) {
        f.content = state.lastAiPrevious.content;
        f.dirty = f.content !== f.original;
        if (state.active === f.name && state.editor) {
          state.suppressChange = true;
          state.editor.setValue(f.content);
          state.suppressChange = false;
        }
        renderTabs();
        renderTree();
        termLog(`Reverted AI edit on ${f.name}.`, 'sys');
      }
      state.lastAiPrevious = null;
      $('aiDiffBanner').classList.add('hidden');
    };

    // File & Folder Inputs + Drag & Drop
    const handleUpload = (fileList) => {
      [...fileList].forEach((file) => {
        if (file.size > 3 * 1024 * 1024) return;
        const r = new FileReader();
        r.onload = () => openFile(file.webkitRelativePath || file.name, r.result || '');
        r.readAsText(file);
      });
    };
    $('fileInput').onchange = (e) => { handleUpload(e.target.files); e.target.value = ''; };
    $('folderInput').onchange = (e) => { handleUpload(e.target.files); e.target.value = ''; };
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) handleUpload(e.dataTransfer.files); });

    // AI Terminal & Copilot Submit
    $('terminalForm').onsubmit = (e) => {
      e.preventDefault();
      const v = $('terminalInput').value;
      $('terminalInput').value = '';
      sendAiChat(v, 'terminal');
    };
    $('copilotForm').onsubmit = (e) => {
      e.preventDefault();
      const v = $('copilotInput').value;
      $('copilotInput').value = '';
      sendAiChat(v, 'copilot');
    };
    $('copilotInput').onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('copilotForm').requestSubmit();
      }
    };
    $('clearChatBtn').onclick = () => { $('copilotMessages').innerHTML = ''; };

    // Modals & Settings
    $('confirmNewFile').onclick = () => {
      const name = $('newFileName').value.trim() || 'untitled.py';
      $('newFileModal').classList.add('hidden');
      openFile(name, '');
    };
    $('newFileName').onkeydown = (e) => { if (e.key === 'Enter') $('confirmNewFile').click(); };

    $('confirmRename').onclick = () => {
      const f = current();
      const next = $('renameInput').value.trim();
      $('renameModal').classList.add('hidden');
      if (!f || !next || next === f.name || state.files.has(next)) return;
      state.files.delete(f.name);
      f.name = next;
      f.language = langFor(next);
      state.files.set(next, f);
      activateFile(next);
    };

    $('themeToggleActivity').onclick = toggleTheme;
    $('settingsActivityBtn').onclick = () => $('settingsModal').classList.remove('hidden');
    $('settingsGroqKey').value = localStorage.getItem('bf-groq-key') || '';
    $('settingsGroqKey').onchange = (e) => localStorage.setItem('bf-groq-key', e.target.value.trim());
    $('settingsLive').checked = state.live;
    $('settingsLive').onchange = (e) => { state.live = e.target.checked; localStorage.setItem('bf-live', state.live ? '1' : '0'); };
    $('settingsAutoHeal').checked = state.autoHeal;
    $('autoHealCheckbox').checked = state.autoHeal;
    const syncAutoHeal = (val) => {
      state.autoHeal = val;
      $('settingsAutoHeal').checked = val;
      $('autoHealCheckbox').checked = val;
      localStorage.setItem('bf-autoheal', val ? '1' : '0');
    };
    $('settingsAutoHeal').onchange = (e) => syncAutoHeal(e.target.checked);
    $('autoHealCheckbox').onchange = (e) => syncAutoHeal(e.target.checked);
    $('settingsMinimap').checked = state.minimap;
    $('settingsMinimap').onchange = (e) => {
      state.minimap = e.target.checked;
      localStorage.setItem('bf-minimap', state.minimap ? '1' : '0');
      state.editor?.updateOptions({ minimap: { enabled: state.minimap } });
    };

    // Web Preview Controls
    $('webRefreshBtn').onclick = refreshWebPreview;
    document.querySelectorAll('[data-vp]').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('[data-vp]').forEach((x) => x.classList.toggle('active', x === b));
        const frame = $('previewFrame');
        frame.classList.remove('tablet', 'mobile');
        if (b.dataset.vp !== 'desktop') frame.classList.add(b.dataset.vp);
      };
    });

    // Command Palette Input
    $('paletteInput').oninput = (e) => renderPaletteList(e.target.value);
    $('paletteInput').onkeydown = (e) => {
      if (e.key === 'Enter') {
        const items = $('paletteList')._items || [];
        if (items.length) {
          $('commandModal').classList.add('hidden');
          items[0].run();
        }
      }
    };
    $('commandModal').onclick = (e) => { if (e.target.id === 'commandModal') $('commandModal').classList.add('hidden'); };

    // Global Keyboard Shortcuts
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openCommandPalette(''); }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); const f = current(); if (f) { syncEditorContent(); f.original = f.content; f.dirty = false; renderTabs(); renderTree(); setStatus(`Saved ${f.name}`); } }
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('fileInput').click(); }
      if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); $('toggleSidebarBtn').click(); }
      if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); $('togglePanelBtn').click(); }
      if (mod && e.key === 'Enter' && document.activeElement?.id !== 'copilotInput') { e.preventDefault(); executeCurrentFile(); }
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal:not(.hidden), .dropdown-menu:not(.hidden)').forEach((el) => el.classList.add('hidden'));
      }
    });
  }

  bindEvents();
})();
