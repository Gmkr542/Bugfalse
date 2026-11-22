(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const LANGS = {
    py:'python', js:'javascript', mjs:'javascript', cjs:'javascript', jsx:'javascript',
    ts:'typescript', tsx:'typescript', html:'html', htm:'html', css:'css', scss:'css',
    json:'json', md:'markdown', yaml:'yaml', yml:'yaml', sql:'sql', sh:'shell',
    java:'java', c:'c', cpp:'cpp', h:'cpp', cs:'csharp', go:'go', rs:'rust',
    php:'php', rb:'ruby', swift:'swift', kt:'kotlin', xml:'xml', svg:'xml'
  };
  const WEB_LANGS = new Set(['html', 'css', 'javascript', 'typescript']);
  const SAMPLE_CODE = `def calculate_total(items):
    total = 0
    for item in items:
        if item is None:
            continue
        total += item.price
    return total

print(calculate_total([]))
`;

  const TERMINAL_COMMANDS = [
    { cmd: '/fix', desc: 'Auto-fix bugs in the active file' },
    { cmd: '/improve', desc: 'Improve readability, performance & structure' },
    { cmd: '/update ', desc: 'Update code with custom instruction (e.g. /update add logging)' },
    { cmd: '/analyze', desc: 'Analyze active file for issues & edge cases' },
    { cmd: '/security', desc: 'Run a security vulnerability review' },
    { cmd: '/tests', desc: 'Generate unit tests for the active file' },
    { cmd: '/run', desc: 'Execute the active file' },
    { cmd: '/import ', desc: 'Import a public GitHub repo (e.g. /import owner/repo)' },
    { cmd: '/explain', desc: 'Explain what the active file does' },
    { cmd: '/clear', desc: 'Clear terminal history' },
  ];

  const state = {
    files: new Map(),
    active: null,
    editor: null,
    monaco: null,
    theme: localStorage.getItem('bf-theme') || 'dark',
    autoFix: localStorage.getItem('bf-autofix') === '1',
    autoImprove: localStorage.getItem('bf-autoimprove') === '1',
    autoFetch: localStorage.getItem('bf-autofetch') !== '0',
    livePreview: localStorage.getItem('bf-livepreview') !== '0',
    minimap: localStorage.getItem('bf-minimap') !== '0',
    aiAvailable: false,
    previousCode: null,
    suppressChange: false,
    busyAi: false,
    previewTimer: null,
    contextTimer: null,
  };

  const current = () => (state.active ? state.files.get(state.active) : null);
  const langFor = (name) => LANGS[(name.split('.').pop() || '').toLowerCase()] || 'plaintext';
  const isWebWorkspace = () => {
    const f = current();
    if (!f) return false;
    if (f.language === 'html') return true;
    return WEB_LANGS.has(f.language) && [...state.files.values()].some((x) => x.language === 'html');
  };

  function logTerminal(text, kind = 'sys') {
    const log = $('terminalLog');
    const row = document.createElement('div');
    row.className = `t-entry ${kind}`;
    row.textContent = text;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function showTerminal() {
    $('aiTerminalDrawer').classList.remove('hidden');
    requestAnimationFrame(() => state.editor?.layout());
  }

  // ── Top-Right AI Availability Status Check ──
  async function refreshAiAvailability() {
    const badge = $('aiAvailabilityBadge');
    const label = $('aiAvailabilityText');
    const userKey = (localStorage.getItem('bf-groq-key') || '').trim();

    if (userKey) {
      state.aiAvailable = true;
      badge.className = 'ai-status-pill available';
      label.textContent = 'AI Available';
      return;
    }

    try {
      const res = await fetch('/ready');
      const data = await res.json().catch(() => ({}));
      state.aiAvailable = Boolean(res.ok && data.ai_configured);
    } catch {
      state.aiAvailable = false;
    }

    if (state.aiAvailable) {
      badge.className = 'ai-status-pill available';
      label.textContent = 'AI Available';
    } else {
      badge.className = 'ai-status-pill unavailable';
      label.textContent = 'AI Unavailable';
    }
  }

  // ── Auto-Fetch Diagnostics / Context when editing ──
  function scheduleAutoFetchContext() {
    clearTimeout(state.contextTimer);
    if (!state.autoFetch || !current()) return;
    state.contextTimer = setTimeout(async () => {
      const f = current();
      if (!f) return;
      $('terminalSubStatus').textContent = `Synced: ${f.name} (${f.language})`;
      try {
        await fetch('/runtime/detect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: f.name, files: { [f.name]: f.content.slice(0, 50000) } }),
        });
      } catch {
        // Silent background context sync
      }
    }, 900);
  }

  function renderTabsAndFiles() {
    const count = state.files.size;
    $('tabsStrip').classList.toggle('hidden', count <= 1);
    $('tabsStrip').innerHTML = [...state.files.values()].map((f) =>
      `<button class="code-tab ${f.name === state.active ? 'active' : ''}" data-tab="${esc(f.name)}" type="button">` +
      `<span>${esc(f.name.split('/').pop())}${f.dirty ? ' •' : ''}</span>` +
      `<span class="x" data-close-tab="${esc(f.name)}">×</span>` +
      `</button>`
    ).join('');

    $('fileList').innerHTML = [...state.files.values()].sort((a, b) => a.name.localeCompare(b.name)).map((f) =>
      `<div class="file-item ${f.name === state.active ? 'active' : ''}" data-file-item="${esc(f.name)}" title="${esc(f.name)}">` +
      `<span>${esc(f.name)}${f.dirty ? ' •' : ''}</span>` +
      `</div>`
    ).join('');

    const cur = current();
    $('activeFileBadge').textContent = cur ? `${cur.name}${cur.dirty ? ' •' : ''}` : 'No file';
    $('emptyOverlay').classList.toggle('hidden', !!cur);
  }

  function refreshPreview() {
    if (!isWebWorkspace()) return;
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
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${css}</head>`) : `${css}${html}`;
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${js}</body>`) : `${html}${js}`;
    $('previewFrame').srcdoc = html;
  }

  function updateLayoutState() {
    const web = isWebWorkspace();
    $('previewPane').classList.toggle('hidden', !web);
    if (web) refreshPreview();
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
    if (state.files.size > 1) $('fileDrawer').classList.remove('hidden');
    if (activate) activateFile(name);
    else renderTabsAndFiles();
  }

  function activateFile(name) {
    const f = state.files.get(name);
    if (!f) return;
    state.active = name;
    if (state.editor && state.monaco) {
      state.suppressChange = true;
      state.editor.setValue(f.content);
      state.monaco.editor.setModelLanguage(state.editor.getModel(), f.language);
      state.suppressChange = false;
      state.editor.focus();
    }
    renderTabsAndFiles();
    updateLayoutState();
    scheduleAutoFetchContext();
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
        renderTabsAndFiles();
        updateLayoutState();
      }
    } else {
      renderTabsAndFiles();
    }
  }

  function syncEditor() {
    const f = current();
    if (!f || !state.editor) return;
    const val = state.editor.getValue();
    if (val !== f.content) {
      f.content = val;
      f.dirty = val !== f.original;
      renderTabsAndFiles();
    }
  }

  // ── GitHub Repository Import ──
  async function importGithubRepo(repoUrl, branch = '', subpath = '', modalStatus = null) {
    const cleaned = (repoUrl || '').trim();
    if (!cleaned) {
      if (modalStatus) {
        modalStatus.textContent = 'Enter a GitHub URL or owner/repo.';
        modalStatus.className = 'modal-msg err';
      }
      return;
    }

    showTerminal();
    logTerminal(`Fetching GitHub repository: ${cleaned}…`, 'sys');
    if (modalStatus) {
      modalStatus.textContent = 'Fetching repository files…';
      modalStatus.className = 'modal-msg';
    }

    try {
      const res = await fetch('/github/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo_url: cleaned, branch: branch || null, subpath: subpath || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `GitHub import failed (${res.status})`);

      const entries = Object.entries(data.files || {});
      if (!entries.length) throw new Error('No supported source files found.');

      state.files.clear();
      entries.forEach(([path, code]) => openFile(path, code, false));
      activateFile(entries[0][0]);
      $('fileDrawer').classList.remove('hidden');

      logTerminal(`Loaded ${data.imported_count} files from ${data.owner}/${data.repo}@${data.branch}.`, 'ai');
      if (modalStatus) {
        modalStatus.textContent = `Loaded ${data.imported_count} files.`;
        modalStatus.className = 'modal-msg ok';
      }
      $('githubModal').classList.add('hidden');
    } catch (err) {
      const msg = err?.message || String(err);
      logTerminal(`GitHub Error: ${msg}`, 'err');
      if (modalStatus) {
        modalStatus.textContent = msg;
        modalStatus.className = 'modal-msg err';
      }
    }
  }

  // ── AI Actions: Fix, Improve, Update ──
  async function runAiAction(mode, instruction = '') {
    const f = current();
    showTerminal();
    if (!f) {
      logTerminal('Open or create a file first before running AI actions.', 'err');
      return;
    }
    if (state.busyAi) return;

    syncEditor();
    const beforeCode = f.content;
    state.busyAi = true;
    $('terminalSubStatus').textContent = `AI running (${mode})…`;
    logTerminal(`> AI ${mode}${instruction ? `: ${instruction}` : ''} [${f.name}]`, 'user');

    try {
      const res = await fetch('/debug/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: beforeCode,
          filename: f.name,
          language: f.language,
          mode,
          instruction: instruction || null,
          apiKey: (localStorage.getItem('bf-groq-key') || '').trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `AI request failed (${res.status})`);

      if (data.error) {
        const detail = [data.error, data.hint].filter(Boolean).join(' — ');
        logTerminal(`AI Error: ${detail}`, 'err');
        if (data.issues?.length) {
          data.issues.forEach((iss) => logTerminal(`• Line ${iss.line || '?'}: ${iss.message}`, 'err'));
        }
        return;
      }

      const revised = typeof data.fixed_code === 'string' ? data.fixed_code : '';
      if (revised.trim() && revised.trim() !== beforeCode.trim()) {
        state.previousCode = { name: f.name, content: beforeCode };
        f.content = revised;
        f.dirty = revised !== f.original;
        if (state.editor) {
          state.suppressChange = true;
          state.editor.setValue(revised);
          state.suppressChange = false;
        }
        renderTabsAndFiles();
        refreshPreview();
        $('undoAiBtn').classList.remove('hidden');
        logTerminal(`✔ Applied AI ${mode} to ${f.name}.
${data.analysis || ''}`, 'ai');
      } else {
        logTerminal(`✔ AI ${mode}: ${data.analysis || 'No changes required.'}`, 'ai');
      }

      if (data.issues?.length) {
        data.issues.forEach((iss) => logTerminal(`  - [${iss.severity || 'issue'}] Ln ${iss.line || '-'}: ${iss.message}`, 'sys'));
      }
      if (data.improvements?.length) {
        data.improvements.forEach((imp) => logTerminal(`  * ${typeof imp === 'string' ? imp : JSON.stringify(imp)}`, 'sys'));
      }
    } catch (err) {
      logTerminal(`AI Error: ${err?.message || String(err)}`, 'err');
    } finally {
      state.busyAi = false;
      $('terminalSubStatus').textContent = 'Ready';
    }
  }

  // ── Run Active File ──
  async function runActiveFile() {
    const f = current();
    showTerminal();
    if (!f) {
      logTerminal('No file open to run.', 'err');
      return;
    }
    syncEditor();
    if (isWebWorkspace()) {
      refreshPreview();
      logTerminal(`Refreshed live preview for ${f.name}.`, 'sys');
      return;
    }

    logTerminal(`> Run ${f.name}`, 'user');
    try {
      const res = await fetch('/execute/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: f.name, code: f.content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Execution failed (${res.status})`);

      if (data.stdout) logTerminal(data.stdout, 'sys');
      if (data.stderr) logTerminal(data.stderr, data.ok ? 'sys' : 'err');
      logTerminal(`Finished (exit code ${data.exit_code}, ${data.duration_ms ?? 0} ms)`, data.ok ? 'ai' : 'err');

      if (!data.ok && state.autoFix) {
        logTerminal('Auto-Fix is ON — sending runtime error to AI…', 'ai');
        await runAiAction('fix', `Fix this execution error:
${data.stderr || ''}`);
      }
    } catch (err) {
      logTerminal(err?.message || String(err), 'err');
    }
  }

  // ── AI Terminal Input & Auto-Suggestions ──
  function updateAutocomplete(val) {
    const box = $('autocompleteBox');
    const q = val.trim().toLowerCase();
    if (!q.startsWith('/')) {
      box.classList.add('hidden');
      return;
    }
    const matches = TERMINAL_COMMANDS.filter((c) => c.cmd.startsWith(q));
    if (!matches.length) {
      box.classList.add('hidden');
      return;
    }
    box.innerHTML = matches.map((m) =>
      `<button type="button" class="ac-item" data-ac="${esc(m.cmd)}"><span>${esc(m.cmd)}</span><small>${esc(m.desc)}</small></button>`
    ).join('');
    box.classList.remove('hidden');
  }

  async function handleTerminalCommand(raw) {
    const text = raw.trim();
    if (!text) return;
    $('autocompleteBox').classList.add('hidden');

    if (text === '/clear') {
      $('terminalLog').innerHTML = '';
      return;
    }
    if (text === '/fix') return runAiAction('fix');
    if (text === '/improve') return runAiAction('improve');
    if (text === '/analyze') return runAiAction('analyze');
    if (text === '/security') return runAiAction('security');
    if (text === '/tests') return runAiAction('tests');
    if (text === '/run') return runActiveFile();
    if (text.startsWith('/update ')) return runAiAction('update', text.slice(8).trim());
    if (text.startsWith('/import ')) return importGithubRepo(text.slice(8).trim());
    if (/^(https?:\/\/)?(www\.)?github\.com\/[\w.-]+\/[\w.-]+/i.test(text)) {
      return importGithubRepo(text);
    }

    const promptText = text === '/explain' ? 'Explain what this code does clearly.' : text;
    logTerminal(`> ${promptText}`, 'user');
    const f = current();
    syncEditor();

    try {
      const res = await fetch('/chatbot/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: promptText,
          code: f ? f.content : '',
          filename: f ? f.name : '',
          language: f ? f.language : '',
          apiKey: (localStorage.getItem('bf-groq-key') || '').trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      logTerminal(data.reply || data.detail || 'No response from AI.', 'ai');
    } catch (err) {
      logTerminal(`AI Error: ${err?.message || String(err)}`, 'err');
    }
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
        fontSize: 14,
        lineHeight: 22,
        fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace',
        minimap: { enabled: state.minimap },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 4,
      });

      state.editor.onDidChangeModelContent(() => {
        if (state.suppressChange || !state.active) return;
        syncEditor();
        scheduleAutoFetchContext();
        if (state.livePreview && isWebWorkspace()) {
          clearTimeout(state.previewTimer);
          state.previewTimer = setTimeout(refreshPreview, 400);
        }
      });
    });
  }

  function init() {
    document.body.classList.toggle('light', state.theme === 'light');
    initMonaco();
    refreshAiAvailability();

    // Top Nav Dropdowns (File, View, Run, AI)
    document.querySelectorAll('.nav-btn[data-menu]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const menu = $(btn.dataset.menu);
        const wasHidden = menu.classList.contains('hidden');
        document.querySelectorAll('.menu-dropdown').forEach((m) => m.classList.add('hidden'));
        document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('open'));
        if (wasHidden) {
          const r = btn.getBoundingClientRect();
          menu.style.left = `${r.left}px`;
          menu.classList.remove('hidden');
          btn.classList.add('open');
        }
      };
    });
    document.addEventListener('click', () => {
      document.querySelectorAll('.menu-dropdown').forEach((m) => m.classList.add('hidden'));
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('open'));
    });

    // Global Command Delegation
    document.addEventListener('click', async (e) => {
      const cmd = e.target.closest('[data-cmd]')?.dataset.cmd;
      if (cmd) {
        if (cmd === 'new-file') { $('newFileModal').classList.remove('hidden'); $('newFileInput').focus(); }
        if (cmd === 'load-sample') openFile('main.py', SAMPLE_CODE);
        if (cmd === 'open-files') $('fileInput').click();
        if (cmd === 'open-folder') $('folderInput').click();
        if (cmd === 'github-import') { $('githubStatusMsg').textContent = ''; $('githubModal').classList.remove('hidden'); $('githubUrlInput').focus(); }
        if (cmd === 'save-file') {
          const f = current();
          if (f) {
            syncEditor();
            f.original = f.content;
            f.dirty = false;
            renderTabsAndFiles();
            if (state.autoImprove) await runAiAction('improve');
          }
        }
        if (cmd === 'rename-file') {
          const f = current();
          if (f) { $('renameFileInput').value = f.name; $('renameModal').classList.remove('hidden'); $('renameFileInput').focus(); }
        }
        if (cmd === 'download-zip') {
          if (!state.files.size) return;
          syncEditor();
          if (typeof JSZip !== 'undefined') {
            const zip = new JSZip();
            state.files.forEach((f) => zip.file(f.name, f.content));
            const blob = await zip.generateAsync({ type: 'blob' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'bugfalse-workspace.zip';
            a.click();
          }
        }
        if (cmd === 'close-file' && current()) closeFile(current().name);
        if (cmd === 'toggle-files') { $('fileDrawer').classList.toggle('hidden'); requestAnimationFrame(() => state.editor?.layout()); }
        if (cmd === 'toggle-terminal') { $('aiTerminalDrawer').classList.toggle('hidden'); requestAnimationFrame(() => state.editor?.layout()); }
        if (cmd === 'toggle-preview') { $('previewPane').classList.toggle('hidden'); requestAnimationFrame(() => state.editor?.layout()); }
        if (cmd === 'toggle-minimap') {
          state.minimap = !state.minimap;
          localStorage.setItem('bf-minimap', state.minimap ? '1' : '0');
          state.editor?.updateOptions({ minimap: { enabled: state.minimap } });
        }
        if (cmd === 'toggle-theme') {
          state.theme = state.theme === 'dark' ? 'light' : 'dark';
          localStorage.setItem('bf-theme', state.theme);
          document.body.classList.toggle('light', state.theme === 'light');
          state.monaco?.editor.setTheme(state.theme === 'light' ? 'vs' : 'vs-dark');
        }
        if (cmd === 'run-code') runActiveFile();
        if (cmd === 'clear-terminal') $('terminalLog').innerHTML = '';
        if (cmd === 'open-terminal') { showTerminal(); $('terminalInput').focus(); }
        if (cmd === 'open-settings') $('settingsModal').classList.remove('hidden');
      }

      const aiMode = e.target.closest('[data-ai]')?.dataset.ai;
      if (aiMode) {
        if (aiMode === 'update') {
          $('updateModal').classList.remove('hidden');
          $('updateInstructionInput').focus();
        } else {
          runAiAction(aiMode);
        }
      }

      const tab = e.target.closest('[data-tab]');
      if (tab && !e.target.closest('[data-close-tab]')) activateFile(tab.dataset.tab);

      const closeTab = e.target.closest('[data-close-tab]');
      if (closeTab) { e.stopPropagation(); closeFile(closeTab.dataset.closeTab); }

      const fileItem = e.target.closest('[data-file-item]');
      if (fileItem) activateFile(fileItem.dataset.fileItem);

      const closeModal = e.target.closest('[data-close]');
      if (closeModal) $(closeModal.dataset.close)?.classList.add('hidden');

      const suggest = e.target.closest('[data-suggest]');
      if (suggest) {
        const val = suggest.dataset.suggest;
        if (val.endsWith(' ')) {
          $('terminalInput').value = val;
          $('terminalInput').focus();
        } else {
          handleTerminalCommand(val);
        }
      }

      const ac = e.target.closest('[data-ac]');
      if (ac) {
        const val = ac.dataset.ac;
        $('autocompleteBox').classList.add('hidden');
        if (val.endsWith(' ')) {
          $('terminalInput').value = val;
          $('terminalInput').focus();
        } else {
          $('terminalInput').value = '';
          handleTerminalCommand(val);
        }
      }
    });

    // Empty Overlay & Drawer Buttons
    $('startWriteBtn').onclick = () => { $('newFileModal').classList.remove('hidden'); $('newFileInput').focus(); };
    $('startImportBtn').onclick = () => $('fileInput').click();
    $('startGithubBtn').onclick = () => { $('githubStatusMsg').textContent = ''; $('githubModal').classList.remove('hidden'); $('githubUrlInput').focus(); };
    $('drawerNewBtn').onclick = () => { $('newFileModal').classList.remove('hidden'); $('newFileInput').focus(); };
    $('drawerGithubBtn').onclick = () => { $('githubStatusMsg').textContent = ''; $('githubModal').classList.remove('hidden'); $('githubUrlInput').focus(); };
    $('drawerCloseBtn').onclick = () => { $('fileDrawer').classList.add('hidden'); requestAnimationFrame(() => state.editor?.layout()); };
    $('refreshPreviewBtn').onclick = refreshPreview;

    // Terminal Controls
    $('clearTermBtn').onclick = () => { $('terminalLog').innerHTML = ''; };
    $('closeTermBtn').onclick = () => { $('aiTerminalDrawer').classList.add('hidden'); requestAnimationFrame(() => state.editor?.layout()); };
    $('terminalInput').oninput = (e) => updateAutocomplete(e.target.value);
    $('terminalForm').onsubmit = (e) => {
      e.preventDefault();
      const v = $('terminalInput').value;
      $('terminalInput').value = '';
      handleTerminalCommand(v);
    };
    $('undoAiBtn').onclick = () => {
      if (!state.previousCode) return;
      const f = state.files.get(state.previousCode.name);
      if (f) {
        f.content = state.previousCode.content;
        f.dirty = f.content !== f.original;
        if (state.active === f.name && state.editor) {
          state.suppressChange = true;
          state.editor.setValue(f.content);
          state.suppressChange = false;
        }
        renderTabsAndFiles();
        logTerminal(`Reverted last AI change on ${f.name}.`, 'sys');
      }
      state.previousCode = null;
      $('undoAiBtn').classList.add('hidden');
    };

    // Modals
    $('githubFetchBtn').onclick = () => importGithubRepo($('githubUrlInput').value, $('githubBranchInput').value, $('githubSubpathInput').value, $('githubStatusMsg'));
    $('githubUrlInput').onkeydown = (e) => { if (e.key === 'Enter') $('githubFetchBtn').click(); };

    $('confirmUpdateBtn').onclick = () => {
      const inst = $('updateInstructionInput').value.trim();
      if (!inst) return;
      $('updateModal').classList.add('hidden');
      $('updateInstructionInput').value = '';
      runAiAction('update', inst);
    };

    $('createFileBtn').onclick = () => {
      const name = $('newFileInput').value.trim() || 'main.py';
      $('newFileModal').classList.add('hidden');
      openFile(name, '');
    };
    $('newFileInput').onkeydown = (e) => { if (e.key === 'Enter') $('createFileBtn').click(); };

    $('confirmRenameBtn').onclick = () => {
      const f = current();
      const next = $('renameFileInput').value.trim();
      $('renameModal').classList.add('hidden');
      if (!f || !next || next === f.name || state.files.has(next)) return;
      state.files.delete(f.name);
      f.name = next;
      f.language = langFor(next);
      state.files.set(next, f);
      activateFile(next);
    };

    // Settings Toggles
    $('toggleAutoFix').checked = state.autoFix;
    $('toggleAutoFix').onchange = (e) => { state.autoFix = e.target.checked; localStorage.setItem('bf-autofix', state.autoFix ? '1' : '0'); };
    $('toggleAutoImprove').checked = state.autoImprove;
    $('toggleAutoImprove').onchange = (e) => { state.autoImprove = e.target.checked; localStorage.setItem('bf-autoimprove', state.autoImprove ? '1' : '0'); };
    $('toggleAutoFetch').checked = state.autoFetch;
    $('toggleAutoFetch').onchange = (e) => { state.autoFetch = e.target.checked; localStorage.setItem('bf-autofetch', state.autoFetch ? '1' : '0'); };
    $('toggleLivePreview').checked = state.livePreview;
    $('toggleLivePreview').onchange = (e) => { state.livePreview = e.target.checked; localStorage.setItem('bf-livepreview', state.livePreview ? '1' : '0'); };
    $('groqKeyInput').value = localStorage.getItem('bf-groq-key') || '';
    $('groqKeyInput').onchange = (e) => {
      localStorage.setItem('bf-groq-key', e.target.value.trim());
      refreshAiAvailability();
    };

    // File Upload & Drag-and-Drop
    const loadFiles = (list) => {
      [...list].forEach((file) => {
        if (file.size > 3 * 1024 * 1024) return;
        const r = new FileReader();
        r.onload = () => openFile(file.webkitRelativePath || file.name, r.result || '');
        r.readAsText(file);
      });
    };
    $('fileInput').onchange = (e) => { loadFiles(e.target.files); e.target.value = ''; };
    $('folderInput').onchange = (e) => { loadFiles(e.target.files); e.target.value = ''; };
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); });

    // Shortcuts
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        const f = current();
        if (f) { syncEditor(); f.original = f.content; f.dirty = false; renderTabsAndFiles(); if (state.autoImprove) runAiAction('improve'); }
      }
      if (mod && e.key === 'Enter') { e.preventDefault(); runActiveFile(); }
      if (e.key === 'Escape') {
        $('autocompleteBox').classList.add('hidden');
        document.querySelectorAll('.modal:not(.hidden), .menu-dropdown:not(.hidden)').forEach((el) => el.classList.add('hidden'));
      }
    });
  }

  init();
})();
