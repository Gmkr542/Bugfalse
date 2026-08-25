# BugFalse — AI Engineering Workspace

BugFalse is a developer workspace for **editing, running, understanding, debugging, improving and downloading code** with AI.

## What is included

- Professional Monaco editor
- Large, distraction-free coding area
- Multi-file workspace and drag/drop import
- Language-aware workspace behavior
- HTML/CSS/JS/TS live browser preview beside the editor
- Live preview changes tracked in Output
- Python, JavaScript, TypeScript, Java, C, C++, Go, Rust, PHP and Ruby execution when runtimes are installed
- JSON/YAML validation
- AI Analyze / Fix / Improve workflow
- AI proposal and reviewable diff before applying changes
- Automatic validation after AI changes
- Clickable problem-to-line workflow
- Project ZIP download
- Current-file download
- File history in the client workspace
- Professional AI chat with current-file context
- Theme and editor settings
- FastAPI backend with health/status endpoints
- Docker deployment image containing the main execution runtimes

## Core workflow

```text
Open / drop code
      ↓
Edit manually
      ↓
Live feedback
      ↓
Run / preview
      ↓
Analyze with AI
      ↓
Fix / improve
      ↓
Review diff
      ↓
Apply
      ↓
Verify
      ↓
Download
```

## Local development

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
uvicorn app:app --reload
```

Open `http://localhost:8000`.

Set `GROQ_TOKEN` before using AI:

```bash
GROQ_TOKEN=your_key_here
```

## Render deployment

The repository includes a `Dockerfile` and `render.yaml`. Render can build the Docker image and run the FastAPI application with the configured `PORT`.

The Docker image includes:

- Python
- Node.js / npm
- TypeScript runner (`tsx`)
- GCC / G++
- Java 17
- Go
- Rust
- PHP
- Ruby

Add `GROQ_TOKEN` as a **secret environment variable** in Render. Never commit an API key.

## Important execution security note

The execution service applies strict size, timeout and output limits and runs each job in a temporary directory. It is suitable for controlled development use, but arbitrary public code execution should ultimately move to a dedicated isolated sandbox service/container per job (for example Firecracker or a hardened container worker) before offering untrusted multi-tenant execution at scale.

## AI behavior

AI changes are never silently applied. BugFalse shows a proposed full-file change in the AI Diff panel. The developer can reject or apply it. After applying, web projects refresh their live preview and executable projects can be verified automatically.

## Project structure

```text
BugFalse/
├── app.py
├── config.py
├── Dockerfile
├── render.yaml
├── requirements.txt
├── routes/
│   ├── debug.py
│   ├── execute.py
│   ├── runtime.py
│   └── chatbot.py
├── services/
│   ├── groq_service.py
│   ├── gemini_service.py
│   └── llama_service.py
├── static/
│   ├── css/styles.css
│   └── js/app.js
├── templates/
│   └── index.html
├── tests/
└── utils/
```

## Verification

The repository is verified with the existing test suite before release.

## Workspace model

BugFalse separates three concerns:

- **File management** — the `File` header menu and Explorer handle create/open/folder/rename/save/download/delete.
- **Code editing** — Monaco remains the clean primary editing surface.
- **Language workspace** — contextual tools appear around the editor only when useful.

### HTML web workspace

When an HTML file is active, BugFalse switches to a web-development workspace automatically. The editor occupies the left side and a larger browser-style live output occupies the right. The live output includes a small Console/Elements inspection area. HTML changes are debounced, rendered automatically, and recorded in Live Output. CSS and JavaScript files in the local workspace are included in the HTML document when possible.

Other languages keep the normal editor + output workflow. HTML is intentionally the trigger for the web workspace so the interface does not become a browser-inspector layout for unrelated files.

## File controls

Use **File** in the top header for New File, Open File, Open Folder, Rename, Save, Download, and Delete. New files default to `untitled.txt`; renaming a file changes the detected language and workspace behavior.
