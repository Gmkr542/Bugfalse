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
    { cmd: '/fix', desc: '[File] Auto-fix bugs in the active file' },
    { cmd: '/improve', desc: '[File] Improve readability & structure of active file' },
    { cmd: '/update ', desc: '[File] Update active file (e.g. /update add logging)' },
    { cmd: '/repo-overview', desc: '[Repo] Map & summarize the entire repository' },
    { cmd: '/repo-audit', desc: '[Repo] Cross-file bug, import & config audit' },
    { cmd: '/repo-update ', desc: '[Repo] Coordinated multi-file AI update across repo' },
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
    previousRepoSnapshot: null,
    lastRepo: null,
    fileFilter: "",
    collapsedFolders: new Set(),
    termHistory: [],
    termHistoryIdx: -1,
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
    const lower = f.name.toLowerCase();
    if (lower.startsWith('templates/') && (lower.endsWith('.html') || lower.endsWith('.htm'))) return false;
    if (f.language === 'html') return true;
    return WEB_LANGS.has(f.language) && [...state.files.values()].some((x) => x.language === 'html' && !x.name.toLowerCase().startsWith('templates/'));
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
    if (!badge || !label) return;
    const userKey = (localStorage.getItem('bf-groq-key') || '').trim();

    if (userKey) {
      state.aiAvailable = true;
      badge.className = 'ai-status-pill available';
      label.textContent = 'AI Available';
      return;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch('/ready', { signal: ctrl.signal, cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      state.aiAvailable = Boolean(res.ok && data.ai_configured);
    } catch {
      state.aiAvailable = false;
    } finally {
      clearTimeout(timer);
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

  function folderOf(path) {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? '/' : path.slice(0, idx);
  }

  function buildFileTreeNodes(files) {
    const root = { folders: new Map(), files: [] };
    files.forEach((f) => {
      const parts = f.name.split('/');
      let node = root;
      let acc = '';
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        acc = acc ? `${acc}/${seg}` : seg;
        if (!node.folders.has(seg)) {
          node.folders.set(seg, { name: seg, path: acc, folders: new Map(), files: [] });
        }
        node = node.folders.get(seg);
      }
      node.files.push(f);
    });
    return root;
  }

  function countNodeFiles(node) {
    let total = node.files.length;
    node.folders.forEach((child) => { total += countNodeFiles(child); });
    return total;
  }

  function renderTreeHtml(node, depth = 0, forceExpand = false) {
    let html = '';
    const sortedFolders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    sortedFolders.forEach((folder) => {
      const collapsed = !forceExpand && state.collapsedFolders.has(folder.path);
      const pad = 8 + depth * 12;
      html +=
        `<div class="tree-folder" data-folder-toggle="${esc(folder.path)}" style="padding-left:${pad}px" title="${esc(folder.path)}">` +
        `<span class="twisty">${collapsed ? '▸' : '▾'}</span>` +
        `<span class="f-name">${esc(folder.name)}</span>` +
        `<span class="f-count">${countNodeFiles(folder)}</span>` +
        `</div>`;
      if (!collapsed) {
        html += renderTreeHtml(folder, depth + 1, forceExpand);
      }
    });

    const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    sortedFiles.forEach((f) => {
      const pad = 10 + depth * 12;
      const baseName = f.name.split('/').pop();
      const ext = (baseName.includes('.') ? baseName.split('.').pop() : 'txt').slice(0, 4).toUpperCase();
      html +=
        `<div class="file-item ${f.name === state.active ? 'active' : ''}" data-file-item="${esc(f.name)}" style="padding-left:${pad}px" title="${esc(f.name)}">` +
        `<span class="ext-tag">${esc(ext)}</span>` +
        `<span>${esc(baseName)}${f.dirty ? ' •' : ''}</span>` +
        `</div>`;
    });
    return html;
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

    const qFilter = (state.fileFilter || '').trim().toLowerCase();
    const visibleFiles = [...state.files.values()].filter((f) => !qFilter || f.name.toLowerCase().includes(qFilter));
    const treeRoot = buildFileTreeNodes(visibleFiles);
    $('fileList').innerHTML = visibleFiles.length
      ? renderTreeHtml(treeRoot, 0, Boolean(qFilter))
      : '<div class="t-entry sys" style="padding:10px">No files match filter.</div>';

    const repoBadge = $('repoScopeBadge');
    const repoBtn = $('repoNavBtn');
    if (state.lastRepo) {
      repoBadge.textContent = `${state.lastRepo.label} (${state.files.size})`;
      repoBadge.classList.remove('hidden');
      repoBtn?.classList.add('has-repo');
    } else if (state.files.size > 1) {
      repoBadge.textContent = `Workspace (${state.files.size} files)`;
      repoBadge.classList.remove('hidden');
      repoBtn?.classList.add('has-repo');
    } else {
      repoBadge.classList.add('hidden');
      repoBtn?.classList.remove('has-repo');
    }

    const cur = current();
    $('activeFolderLabel').textContent = cur ? folderOf(cur.name) : '/';
    $('activeFileLabel').textContent = cur ? `${cur.name.split('/').pop()}${cur.dirty ? ' •' : ''}` : 'No file';
    $('emptyOverlay').classList.toggle('hidden', !!cur);
  }

  function openFolderNavDropdown(anchorBtn) {
    const menu = $('folderNavMenu');
    const wasHidden = menu.classList.contains('hidden');
    document.querySelectorAll('.menu-dropdown').forEach((m) => m.classList.add('hidden'));
    document.querySelectorAll('.nav-btn, .path-pill').forEach((b) => b.classList.remove('open'));
    if (!wasHidden) return;

    const folderCounts = new Map();
    state.files.forEach((f) => {
      const dir = folderOf(f.name);
      folderCounts.set(dir, (folderCounts.get(dir) || 0) + 1);
    });
    if (!folderCounts.size) folderCounts.set('/', 0);

    const activeDir = current() ? folderOf(current().name) : '/';
    menu.innerHTML = [...folderCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dir, cnt]) =>
        `<button type="button" class="${dir === activeDir ? 'current' : ''}" data-pick-folder="${esc(dir)}" role="menuitem">` +
        `<span>${esc(dir)}</span><span class="dd-meta">${cnt} file${cnt === 1 ? '' : 's'}</span>` +
        `</button>`
      )
      .join('');

    const r = anchorBtn.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.classList.remove('hidden');
    anchorBtn.classList.add('open');
  }

  function openFileNavDropdown(anchorBtn) {
    const menu = $('fileNavMenu');
    const wasHidden = menu.classList.contains('hidden');
    document.querySelectorAll('.menu-dropdown').forEach((m) => m.classList.add('hidden'));
    document.querySelectorAll('.nav-btn, .path-pill').forEach((b) => b.classList.remove('open'));
    if (!wasHidden) return;

    if (!state.files.size) {
      menu.innerHTML = '<button type="button" data-cmd="new-file" role="menuitem"><span>+ New File...</span></button>' +
        '<button type="button" data-cmd="github-import" role="menuitem"><span>Import GitHub Repo...</span></button>';
    } else {
      const activeDir = current() ? folderOf(current().name) : null;
      const all = [...state.files.values()].sort((a, b) => {
        const aInDir = folderOf(a.name) === activeDir ? 0 : 1;
        const bInDir = folderOf(b.name) === activeDir ? 0 : 1;
        return aInDir - bInDir || a.name.localeCompare(b.name);
      });
      menu.innerHTML = all.map((f) =>
        `<button type="button" class="${f.name === state.active ? 'current' : ''}" data-pick-file="${esc(f.name)}" role="menuitem">` +
        `<span>${esc(f.name)}${f.dirty ? ' •' : ''}</span><span class="dd-meta">${esc(f.language)}</span>` +
        `</button>`
      ).join('');
    }

    const r = anchorBtn.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.classList.remove('hidden');
    anchorBtn.classList.add('open');
  }

  function refreshPreview() {
    if (!isWebWorkspace()) return;
    const active = current();
    let html = active.language === 'html' ? active.content : '';
    if (!html) {
      const htmlFile = [...state.files.values()].find((x) => x.language === 'html');
      html = htmlFile ? htmlFile.content : `<pre>${esc(active.content)}</pre>`;
    }
    const css = [...state.files.values()].filter((x) => x.language === 'css').map((x) => `<style>${x.content}</style>`).join('\n');
    const js = [...state.files.values()].filter((x) => x.language === 'javascript').map((x) => `<script>${x.content.replace(/<\/script/gi, '<\/script')}</script>`).join('\n');
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
    logTerminal(`Fetching GitHub repository: ${cleaned}...`, 'sys');
    if (modalStatus) {
      modalStatus.textContent = 'Fetching repository files...';
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

      state.lastRepo = { label: `${data.owner}/${data.repo}@${data.branch || 'main'}`, url: data.repo_url || `https://github.com/${data.owner}/${data.repo}`, branch: data.branch || 'main' };
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
    $('terminalSubStatus').textContent = `AI running (${mode})...`;
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
        const oldLines = beforeCode.split('\n').length;
        const newLines = revised.split('\n').length;
        const delta = newLines - oldLines;
        const deltaText = delta === 0 ? `${newLines} lines` : `${newLines} lines (${delta > 0 ? '+' + delta : delta})`;
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

  // ── Whole-Repository AI Actions: Overview, Cross-File Audit, Multi-File Update ──
  async function runRepoAction(mode = 'overview', instruction = '') {
    showTerminal();
    if (!state.files.size) {
      logTerminal('Import a GitHub repository or open workspace files first to use Repo AI tools.', 'err');
      return;
    }
    if (state.busyAi) return;

    syncEditor();
    const filesPayload = {};
    state.files.forEach((f) => { filesPayload[f.name] = f.content; });
    const repoLabel = state.lastRepo?.label || `Workspace (${state.files.size} files)`;

    state.busyAi = true;
    $('terminalSubStatus').textContent = `Repo AI (${mode})...`;
    logTerminal(`> Repo AI [${mode}] across ${state.files.size} file(s)${instruction ? ': ' + instruction : ''}`, 'user');

    try {
      const res = await fetch('/debug/repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: filesPayload,
          mode,
          instruction: instruction || null,
          repo_name: repoLabel,
          apiKey: (localStorage.getItem('bf-groq-key') || '').trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Repo AI failed (${res.status})`);
      if (data.error) {
        logTerminal(`Repo AI Error: ${data.error}`, 'err');
        return;
      }

      logTerminal(`Repo Summary (${repoLabel}):
${data.summary || 'Completed.'}`, 'ai');

      if (data.architecture?.length) {
        logTerminal('Architecture & Entry Points:
' + data.architecture.map((x) => `  • ${x}`).join('
'), 'sys');
      }
      if (data.issues?.length) {
        logTerminal(
          'Cross-File Findings:
' +
            data.issues.map((iss) => `  - [${iss.severity || 'issue'}] ${iss.file || 'repo'}${iss.line ? ':' + iss.line : ''} — ${iss.message || ''}`).join('
'),
          'err'
        );
      }
      if (data.recommendations?.length) {
        logTerminal('Recommendations:
' + data.recommendations.map((r) => `  * ${r}`).join('
'), 'sys');
      }

      const updates = data.updated_files && typeof data.updated_files === 'object' ? Object.entries(data.updated_files) : [];
      if (updates.length) {
        const snapshot = new Map();
        state.files.forEach((f, k) => snapshot.set(k, f.content));
        state.previousRepoSnapshot = snapshot;
        state.previousCode = null;

        updates.forEach(([path, newContent]) => {
          const target = state.files.get(path);
          if (target) {
            target.content = newContent;
            target.dirty = newContent !== target.original;
            if (state.active === path && state.editor) {
              state.suppressChange = true;
              state.editor.setValue(newContent);
              state.suppressChange = false;
            }
          }
        });

        $('fileDrawer').classList.remove('hidden');
        renderTabsAndFiles();
        refreshPreview();
        $('undoAiBtn').classList.remove('hidden');
        logTerminal(
          `Updated ${updates.length} file(s) across repository:
` +
            updates.map(([p]) => `  ✔ ${p}`).join('
') +
            `
Use 'Undo AI Edit' to revert all repo changes or File -> Commit & Push to GitHub to publish.`,
          'ai'
        );
      } else if (mode === 'update') {
        logTerminal('No multi-file edits were produced for that instruction.', 'sys');
      }
    } catch (err) {
      logTerminal(`Repo AI Error: ${err?.message || String(err)}`, 'err');
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
        logTerminal('Auto-Fix is ON — sending runtime error to AI...', 'ai');
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
    if (text === '/repo-overview') return runRepoAction('overview');
    if (text === '/repo-audit') return runRepoAction('audit');
    if (text.startsWith('/repo-update ')) return runRepoAction('update', text.slice(13).trim());
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

  function createFallbackEditor() {
    const host = $('monaco');
    if (!host || host.querySelector('textarea')) return;
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    ta.style.cssText = 'width:100%;height:100%;border:0;outline:none;resize:none;padding:16px;background:var(--bg);color:var(--text);font:14px/1.6 var(--mono);tab-size:4;';
    host.appendChild(ta);
    state.editor = {
      getValue: () => ta.value,
      setValue: (v) => { ta.value = String(v ?? ''); },
      focus: () => ta.focus(),
      layout: () => {},
      getModel: () => null,
      updateOptions: () => {},
    };
    ta.addEventListener('input', () => {
      if (state.suppressChange || !state.active) return;
      syncEditor();
      scheduleAutoFetchContext();
      if (state.livePreview && isWebWorkspace()) {
        clearTimeout(state.previewTimer);
        state.previewTimer = setTimeout(refreshPreview, 400);
      }
    });
  }

  function initMonaco(retries = 20) {
    if (typeof window.require !== 'function') {
      if (retries > 0) {
        setTimeout(() => initMonaco(retries - 1), 150);
      } else {
        createFallbackEditor();
      }
      return;
    }
    try {
      window.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
      window.require(['vs/editor/editor.main'], () => {
        state.monaco = window.monaco;
        const activeBeforeLoad = current();
        $('monaco').innerHTML = '';
        state.editor = window.monaco.editor.create($('monaco'), {
          value: activeBeforeLoad ? activeBeforeLoad.content : '',
          language: activeBeforeLoad ? activeBeforeLoad.language : 'plaintext',
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
      }, () => createFallbackEditor());
    } catch {
      createFallbackEditor();
    }
  }

  function init() {
    document.body.classList.toggle('light', state.theme === 'light');
    refreshAiAvailability();

    if ($('folderNavBtn')) {
      $('folderNavBtn').onclick = (e) => { e.stopPropagation(); openFolderNavDropdown($('folderNavBtn')); };
    }
    if ($('fileNavBtn')) {
      $('fileNavBtn').onclick = (e) => { e.stopPropagation(); openFileNavDropdown($('fileNavBtn')); };
    }
    if ($('drawerCollapseAllBtn')) {
      $('drawerCollapseAllBtn').onclick = () => {
        if (state.collapsedFolders.size) {
          state.collapsedFolders.clear();
        } else {
          state.files.forEach((f) => {
            const parts = f.name.split('/');
            let acc = '';
            for (let i = 0; i < parts.length - 1; i++) {
              acc = acc ? `${acc}/${parts[i]}` : parts[i];
              state.collapsedFolders.add(acc);
            }
          });
        }
        renderTabsAndFiles();
      };
    }

    // Top Nav Dropdowns (File, View, Run, AI)
    document.querySelectorAll('.nav-btn[data-menu]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const menu = $(btn.dataset.menu);
        const wasHidden = menu.classList.contains('hidden');
        document.querySelectorAll('.menu-dropdown').forEach((m) => m.classList.add('hidden'));
        document.querySelectorAll('.nav-btn, .path-pill').forEach((b) => b.classList.remove('open'));
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
      document.querySelectorAll('.nav-btn, .path-pill').forEach((b) => b.classList.remove('open'));
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
        if (cmd === 'github-push') { $('pushStatusMsg').textContent = ''; if (state.lastRepo) { $('pushRepoInput').value = state.lastRepo.url; $('pushBranchInput').value = state.lastRepo.branch; } $('pushScopeInput').value = $('pushAllFilesToggle')?.checked ? 'All workspace files' : (current()?.name || 'Active file'); $('githubPushModal').classList.remove('hidden'); }
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
        if (cmd === 'find-file') { $('fileDrawer').classList.remove('hidden'); requestAnimationFrame(() => state.editor?.layout()); }
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

      const repoAiMode = e.target.closest('[data-repo-ai]')?.dataset.repoAi;
      if (repoAiMode) {
        if (repoAiMode === 'update') {
          $('repoUpdateModal').classList.remove('hidden');
          $('repoUpdateInput').focus();
        } else {
          runRepoAction(repoAiMode);
        }
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

      const folderToggle = e.target.closest('[data-folder-toggle]');
      if (folderToggle) {
        const dirPath = folderToggle.dataset.folderToggle;
        if (state.collapsedFolders.has(dirPath)) state.collapsedFolders.delete(dirPath);
        else state.collapsedFolders.add(dirPath);
        renderTabsAndFiles();
      }

      const pickFolder = e.target.closest('[data-pick-folder]');
      if (pickFolder) {
        const targetDir = pickFolder.dataset.pickFolder;
        state.collapsedFolders.delete(targetDir);
        $('fileDrawer').classList.remove('hidden');
        const firstInDir = [...state.files.values()]
          .filter((f) => folderOf(f.name) === targetDir)
          .sort((a, b) => a.name.localeCompare(b.name))[0];
        if (firstInDir) activateFile(firstInDir.name);
        else renderTabsAndFiles();
      }

      const pickFile = e.target.closest('[data-pick-file]');
      if (pickFile) {
        activateFile(pickFile.dataset.pickFile);
      }

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
    $('terminalInput').onkeydown = (e) => {
      if (e.key === 'ArrowUp' && state.termHistory.length) {
        e.preventDefault();
        state.termHistoryIdx = state.termHistoryIdx < 0
          ? state.termHistory.length - 1
          : Math.max(0, state.termHistoryIdx - 1);
        $('terminalInput').value = state.termHistory[state.termHistoryIdx];
      } else if (e.key === 'ArrowDown' && state.termHistory.length) {
        e.preventDefault();
        if (state.termHistoryIdx >= state.termHistory.length - 1) {
          state.termHistoryIdx = -1;
          $('terminalInput').value = '';
        } else if (state.termHistoryIdx >= 0) {
          state.termHistoryIdx += 1;
          $('terminalInput').value = state.termHistory[state.termHistoryIdx];
        }
      }
    };
    $('terminalForm').onsubmit = (e) => {
      e.preventDefault();
      const v = $('terminalInput').value;
      if (v.trim()) {
        state.termHistory.push(v.trim());
        state.termHistoryIdx = -1;
      }
      $('terminalInput').value = '';
      handleTerminalCommand(v);
    };
    $('undoAiBtn').onclick = () => {
      if (state.previousRepoSnapshot) {
        state.previousRepoSnapshot.forEach((oldContent, name) => {
          const f = state.files.get(name);
          if (f) {
            f.content = oldContent;
            f.dirty = f.content !== f.original;
            if (state.active === name && state.editor) {
              state.suppressChange = true;
              state.editor.setValue(oldContent);
              state.suppressChange = false;
            }
          }
        });
        renderTabsAndFiles();
        logTerminal('Reverted last repo-wide multi-file AI update.', 'sys');
        state.previousRepoSnapshot = null;
        $('undoAiBtn').classList.add('hidden');
        return;
      }
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


    // GitHub Push from Web UI
    const savedGhToken = () => (localStorage.getItem('bf-gh-token') || '').trim();
    if ($('pushTokenInput')) $('pushTokenInput').value = savedGhToken();
    if ($('rememberTokenToggle')) $('rememberTokenToggle').checked = Boolean(savedGhToken());

    if ($('confirmPushBtn')) {
      $('confirmPushBtn').onclick = async () => {
        const repoUrl = ($('pushRepoInput').value || state.lastRepo?.url || '').trim();
        const branch = ($('pushBranchInput').value || state.lastRepo?.branch || 'main').trim();
        const message = ($('pushMessageInput').value || 'Update from BugFalse').trim();
        const token = ($('pushTokenInput').value || savedGhToken()).trim();
        const pushAll = Boolean($('pushAllFilesToggle')?.checked);
        const msgEl = $('pushStatusMsg');

        if (!repoUrl || !token) {
          msgEl.textContent = 'Enter both a GitHub repository URL and a Personal Access Token.';
          msgEl.className = 'modal-msg err';
          return;
        }
        if ($('rememberTokenToggle')?.checked) localStorage.setItem('bf-gh-token', token);
        else localStorage.removeItem('bf-gh-token');
        syncEditor();

        const filesToPush = {};
        if (pushAll) {
          state.files.forEach((f) => { filesToPush[f.name] = f.content; });
        } else {
          const f = current();
          if (!f) {
            msgEl.textContent = 'No active file open to push.';
            msgEl.className = 'modal-msg err';
            return;
          }
          filesToPush[f.name] = f.content;
        }

        msgEl.textContent = 'Pushing changes to GitHub...';
        msgEl.className = 'modal-msg';
        showTerminal();
        logTerminal(`Pushing ${Object.keys(filesToPush).length} file(s) to ${repoUrl} (${branch})...`, 'sys');

        try {
          const res = await fetch('/github/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              repo_url: repoUrl,
              branch,
              commit_message: message,
              token,
              files: filesToPush,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.detail || `Push failed (${res.status})`);

          Object.keys(filesToPush).forEach((name) => {
            const fileObj = state.files.get(name);
            if (fileObj) {
              fileObj.original = fileObj.content;
              fileObj.dirty = false;
            }
          });
          renderTabsAndFiles();
          msgEl.textContent = `Pushed ${data.pushed_count} file(s) to ${data.owner}/${data.repo}@${data.branch}.`;
          msgEl.className = 'modal-msg ok';
          logTerminal(`Pushed ${data.pushed_count} file(s) to ${data.owner}/${data.repo}@${data.branch}: ${message}`, 'ai');
          setTimeout(() => $('githubPushModal').classList.add('hidden'), 650);
        } catch (err) {
          const errText = err?.message || String(err);
          msgEl.textContent = errText;
          msgEl.className = 'modal-msg err';
          logTerminal(`GitHub Push Error: ${errText}`, 'err');
        }
      };
    }

    // Modals
    $('githubFetchBtn').onclick = () => importGithubRepo($('githubUrlInput').value, $('githubBranchInput').value, $('githubSubpathInput').value, $('githubStatusMsg'));
    $('githubUrlInput').onkeydown = (e) => { if (e.key === 'Enter') $('githubFetchBtn').click(); };

    if ($('fileFilterInput')) {
      $('fileFilterInput').oninput = (e) => {
        state.fileFilter = e.target.value;
        renderTabsAndFiles();
      };
    }

    if ($('confirmRepoUpdateBtn')) {
      $('confirmRepoUpdateBtn').onclick = () => {
        const inst = $('repoUpdateInput').value.trim();
        if (!inst) return;
        $('repoUpdateModal').classList.add('hidden');
        $('repoUpdateInput').value = '';
        runRepoAction('update', inst);
      };
    }

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
      if (mod && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        $('pushStatusMsg').textContent = '';
        if (state.lastRepo) { $('pushRepoInput').value = state.lastRepo.url; $('pushBranchInput').value = state.lastRepo.branch; }
        $('githubPushModal').classList.remove('hidden');
      }
      if (mod && e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); runAiAction('fix'); }
      if (mod && e.altKey && e.key.toLowerCase() === 'i') { e.preventDefault(); runAiAction('improve'); }
      if (e.key === 'Escape') {
        $('autocompleteBox').classList.add('hidden');
        document.querySelectorAll('.modal:not(.hidden), .menu-dropdown:not(.hidden)').forEach((el) => el.classList.add('hidden'));
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); initMonaco(); });
  } else {
    init();
    initMonaco();
  }
})();
