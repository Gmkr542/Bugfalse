import os
import shutil
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

RUNTIMES = {
    "python": {"label": "Python", "extensions": [".py"], "command": "python"},
    "javascript": {"label": "JavaScript", "extensions": [".js", ".mjs", ".cjs"], "command": "node"},
    "typescript": {"label": "TypeScript", "extensions": [".ts", ".tsx"], "command": "tsx"},
    "java": {"label": "Java", "extensions": [".java"], "command": "java"},
    "c": {"label": "C", "extensions": [".c"], "command": "gcc"},
    "cpp": {"label": "C++", "extensions": [".cc", ".cpp", ".cxx"], "command": "g++"},
    "go": {"label": "Go", "extensions": [".go"], "command": "go"},
    "rust": {"label": "Rust", "extensions": [".rs"], "command": "rustc"},
    "php": {"label": "PHP", "extensions": [".php"], "command": "php"},
    "ruby": {"label": "Ruby", "extensions": [".rb"], "command": "ruby"},
    "csharp": {"label": "C#", "extensions": [".cs"], "command": "dotnet"},
    "swift": {"label": "Swift", "extensions": [".swift"], "command": "swift"},
    "kotlin": {"label": "Kotlin", "extensions": [".kt", ".kts"], "command": "kotlinc"},
}

FRAMEWORK_MARKERS = [
    ("Next.js", {"next": "package.json", "next.config.js": None, "next.config.mjs": None}),
    ("React", {"react": "package.json"}),
    ("Vite", {"vite": "package.json", "vite.config.js": None, "vite.config.ts": None}),
    ("Express", {"express": "package.json"}),
    ("NestJS", {"@nestjs/core": "package.json", "nest-cli.json": None}),
    ("FastAPI", {"fastapi": "requirements.txt", "fastapi": "pyproject.toml"}),
    ("Django", {"django": "requirements.txt", "manage.py": None}),
    ("Flask", {"flask": "requirements.txt", "app.py": None}),
    ("Spring Boot", {"spring-boot": "pom.xml", "build.gradle": None, "build.gradle.kts": None}),
    ("ASP.NET Core", {"Microsoft.AspNetCore": "*.csproj", "Program.cs": None}),
]

class DetectRequest(BaseModel):
    filename: str = "main.py"
    files: dict[str, str] = {}


def detect_language(filename: str):
    lower = filename.lower()
    for lang, info in RUNTIMES.items():
        if any(lower.endswith(ext) for ext in info["extensions"]):
            return lang
    if lower.endswith(".html"): return "html"
    if lower.endswith(".css"): return "css"
    if lower.endswith(".json"): return "json"
    if lower.endswith((".yaml", ".yml")): return "yaml"
    if lower.endswith(".sql"): return "sql"
    return "plaintext"


def detect_framework(files: dict[str, str]):
    names = {os.path.basename(k).lower(): k for k in files}
    contents = {k.lower(): (v or "").lower() for k, v in files.items()}
    package = next((v for k, v in contents.items() if os.path.basename(k) == "package.json"), "")
    req = next((v for k, v in contents.items() if os.path.basename(k) in ("requirements.txt", "pyproject.toml", "poetry.lock")), "")
    for framework, marker in FRAMEWORK_MARKERS:
        for token, manifest in marker.items():
            if manifest is None and token.lower() in names:
                return framework
            if manifest == "package.json" and token.lower() in package:
                return framework
            if manifest in ("requirements.txt", "pyproject.toml") and token.lower() in req:
                return framework
            if manifest == "pom.xml":
                pom = contents.get(next((k for k in contents if os.path.basename(k) == "pom.xml"), ""), "")
                if token.lower() in pom:
                    return framework
            if manifest == "*.csproj" and any(k.endswith(".csproj") and token.lower() in v for k, v in contents.items()):
                return framework
    return None


@router.get("/catalog")
async def catalog():
    return {"runtimes": [{**info, "id": lang, "available": bool(shutil.which(info["command"]))} for lang, info in RUNTIMES.items()]}


@router.post("/detect")
async def detect(payload: DetectRequest):
    language = detect_language(payload.filename)
    framework = detect_framework(payload.files or {payload.filename: ""})
    info = RUNTIMES.get(language)
    return {
        "language": language,
        "language_label": info["label"] if info else language.title(),
        "framework": framework,
        "runtime_available": bool(info and shutil.which(info["command"])),
    }
