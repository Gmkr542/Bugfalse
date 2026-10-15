import shutil
from pathlib import Path
from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()

class DetectRequest(BaseModel):
    filename: str = Field(default="main.py", max_length=200)
    files: dict[str, str] = Field(default_factory=dict)

def detect_language(filename: str):
    ext = Path(filename).suffix.lower()
    return {".py": "python", ".js": "javascript", ".ts": "typescript", ".html": "html",
            ".css": "css", ".json": "json", ".sql": "sql", ".md": "markdown"}.get(ext, "plaintext")

@router.get("/catalog")
async def catalog():
    runtimes = [
        {"id": "python", "label": "Python", "extensions": [".py"], "available": bool(shutil.which("python"))},
        {"id": "javascript", "label": "JavaScript", "extensions": [".js"], "available": bool(shutil.which("node"))},
        {"id": "typescript", "label": "TypeScript", "extensions": [".ts"], "available": bool(shutil.which("tsx"))},
    ]
    return {"runtimes": runtimes, "execution_enabled": __import__("os").getenv("BUGFALSE_ENABLE_LOCAL_EXECUTION", "false").lower() == "true"}

@router.post("/detect")
async def detect(payload: DetectRequest):
    language = detect_language(payload.filename)
    return {"language": language, "language_label": language.title(), "framework": None,
            "runtime_available": bool(shutil.which(language)) if language in {"python", "javascript", "typescript"} else False}
