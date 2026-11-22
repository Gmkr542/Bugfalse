import os
import shutil
from pathlib import Path
from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()


class DetectRequest(BaseModel):
    filename: str = Field(default="main.py", max_length=200)
    files: dict[str, str] = Field(default_factory=dict)


EXT_MAP = {
    ".py": "python", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".html": "html", ".htm": "html", ".css": "css", ".scss": "css",
    ".json": "json", ".sql": "sql", ".md": "markdown", ".yaml": "yaml", ".yml": "yaml",
    ".go": "go", ".rs": "rust", ".java": "java", ".c": "c", ".cpp": "cpp", ".rb": "ruby", ".php": "php",
}


def detect_language(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    return EXT_MAP.get(ext, "plaintext")


def detect_framework(files: dict[str, str], language: str) -> str | None:
    joined = "\n".join(list(files.values())[:10]).lower()
    names = {Path(k).name.lower() for k in files.keys()}
    if "fastapi" in joined:
        return "FastAPI"
    if "flask" in joined:
        return "Flask"
    if "django" in joined:
        return "Django"
    if "react" in joined or ("package.json" in names and '"react"' in joined):
        return "React"
    if "express" in joined:
        return "Express"
    if language == "html":
        return "Web"
    return None


@router.get("/catalog")
async def catalog():
    runtimes = [
        {"id": "python", "label": "Python", "extensions": [".py"], "available": bool(shutil.which("python") or shutil.which("python3"))},
        {"id": "javascript", "label": "JavaScript", "extensions": [".js", ".jsx"], "available": bool(shutil.which("node"))},
        {"id": "typescript", "label": "TypeScript", "extensions": [".ts", ".tsx"], "available": bool(shutil.which("tsx") or shutil.which("ts-node"))},
        {"id": "html", "label": "HTML/CSS Live Preview", "extensions": [".html", ".css"], "available": True},
    ]
    return {
        "runtimes": runtimes,
        "execution_enabled": os.getenv("BUGFALSE_ENABLE_LOCAL_EXECUTION", "false").lower() == "true",
    }


@router.post("/detect")
async def detect(payload: DetectRequest):
    language = detect_language(payload.filename)
    framework = detect_framework(payload.files, language)
    cmd_map = {"python": "python", "javascript": "node", "typescript": "tsx", "go": "go", "rust": "rustc", "java": "java"}
    cmd = cmd_map.get(language)
    available = True if language in {"html", "css", "json", "markdown"} else bool(cmd and shutil.which(cmd))
    return {
        "language": language,
        "language_label": language.title(),
        "framework": framework,
        "runtime_available": available,
    }
