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
