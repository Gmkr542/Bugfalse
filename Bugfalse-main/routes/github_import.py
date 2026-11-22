import base64
import io
import logging
import os
import re
import zipfile
from urllib.parse import urlparse

import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger("bugfalse.github")
router = APIRouter()

MAX_IMPORT_FILES = 60
MAX_FILE_BYTES = 250_000
MAX_TOTAL_BYTES = 2_500_000

ALLOWED_EXTENSIONS = {
    ".py", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
    ".html", ".htm", ".css", ".scss", ".json", ".md", ".txt",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env.example",
    ".sql", ".sh", ".bash", ".java", ".c", ".h", ".cpp", ".hpp",
    ".cs", ".go", ".rs", ".php", ".rb", ".swift", ".kt", ".kts",
    ".xml", ".svg", ".dockerfile",
}
ALLOWED_FILENAMES = {
    "dockerfile", "makefile", "procfile", "readme", "license",
    "requirements.txt", "package.json", "tsconfig.json", "cargo.toml", "go.mod",
}
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env",
    "dist", "build", ".next", ".nuxt", "target", "vendor", ".pytest_cache",
}


class GitHubImportRequest(BaseModel):
    repo_url: str = Field(..., min_length=5, max_length=500)
    branch: str | None = Field(default=None, max_length=120)
    subpath: str | None = Field(default=None, max_length=250)


def parse_github_url(raw_url: str) -> tuple[str, str, str | None, str | None]:
    """Parse owner, repo, optional branch, and optional subpath from GitHub URLs or owner/repo shorthand."""
    cleaned = raw_url.strip().rstrip("/")
    if cleaned.endswith(".git"):
        cleaned = cleaned[:-4]

    if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", cleaned):
        owner, repo = cleaned.split("/", 1)
        return owner, repo, None, None

    if not cleaned.startswith(("http://", "https://")):
        cleaned = "https://" + cleaned

    parsed = urlparse(cleaned)
    if parsed.netloc.lower() not in {"github.com", "www.github.com"}:
        raise ValueError("URL must be a valid github.com repository link (e.g., https://github.com/owner/repo).")

    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2:
        raise ValueError("GitHub URL must include both owner and repository name.")

    owner, repo = parts[0], parts[1]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", owner) or not re.fullmatch(r"[A-Za-z0-9_.-]+", repo):
        raise ValueError("Invalid GitHub owner or repository name.")

    branch = None
    subpath = None
    if len(parts) >= 4 and parts[2] in {"tree", "blob"}:
        branch = parts[3]
        if len(parts) > 4:
            subpath = "/".join(parts[4:])

    return owner, repo, branch, subpath


def _is_supported_file(path: str) -> bool:
    parts = path.split("/")
    if any(part in SKIP_DIRS or (part.startswith(".") and part not in {".env.example", ".gitignore"}) for part in parts[:-1]):
        return False
    filename = parts[-1].lower()
    if filename in ALLOWED_FILENAMES:
        return True
    _, ext = os.path.splitext(filename)
    return ext in ALLOWED_EXTENSIONS


def _github_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "BugFalse-Workspace/6.1",
    }
    token = os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _sort_key(path: str):
    priority_names = {"main.py", "app.py", "index.py", "index.js", "index.ts", "index.html", "package.json", "readme.md"}
    return (0 if path.split("/")[-1].lower() in priority_names else 1, path.count("/"), path)


@router.post("/import")
def import_github_repo(payload: GitHubImportRequest):
    try:
        owner, repo, url_branch, url_subpath = parse_github_url(payload.repo_url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    branch = (payload.branch or "").strip() or url_branch
    subpath = (payload.subpath or "").strip().strip("/") or url_subpath

    session = requests.Session()
    headers = _github_headers()

    try:
        repo_res = session.get(f"https://api.github.com/repos/{owner}/{repo}", headers=headers, timeout=15)
        if repo_res.status_code == 404:
            raise HTTPException(status_code=404, detail=f"Repository '{owner}/{repo}' was not found or is private.")
        if repo_res.status_code == 403:
            raise HTTPException(status_code=429, detail="GitHub API rate limit exceeded. Try again later or configure GITHUB_TOKEN.")
        if not repo_res.ok:
            raise HTTPException(status_code=502, detail=f"GitHub API error ({repo_res.status_code}).")

        default_branch = repo_res.json().get("default_branch") or "main"
        target_branch = branch or default_branch

        # Fast path: 1-call zipball download (avoids N blob API calls)
        zip_res = session.get(
            f"https://api.github.com/repos/{owner}/{repo}/zipball/{target_branch}",
            headers=headers,
            timeout=25,
        )
        if zip_res.status_code == 404:
            raise HTTPException(status_code=404, detail=f"Branch '{target_branch}' not found in '{owner}/{repo}'.")
        if zip_res.status_code == 403:
            raise HTTPException(status_code=429, detail="GitHub API rate limit exceeded while downloading repository archive.")

        if zip_res.ok and getattr(zip_res, "content", None) and zipfile.is_zipfile(io.BytesIO(zip_res.content)):
            imported_files: dict[str, str] = {}
            total_bytes = 0
            skipped_count = 0
            with zipfile.ZipFile(io.BytesIO(zip_res.content)) as zf:
                entries = []
                for info in zf.infolist():
                    if info.is_dir() or "/" not in info.filename:
                        continue
                    rel_path = info.filename.split("/", 1)[1]
                    if not rel_path:
                        continue
                    if subpath and not (rel_path == subpath or rel_path.startswith(subpath + "/")):
                        continue
                    if info.file_size > MAX_FILE_BYTES or not _is_supported_file(rel_path):
                        continue
                    entries.append((rel_path, info))

                if not entries:
                    raise HTTPException(status_code=404, detail="No supported source files found in the specified repository or path.")

                entries.sort(key=lambda item: _sort_key(item[0]))
                for rel_path, info in entries:
                    if len(imported_files) >= MAX_IMPORT_FILES or total_bytes + info.file_size > MAX_TOTAL_BYTES:
                        skipped_count += 1
                        continue
                    raw_bytes = zf.read(info.filename)
                    if b"\x00" in raw_bytes[:1024]:
                        skipped_count += 1
                        continue
                    imported_files[rel_path] = raw_bytes.decode("utf-8", errors="replace")
                    total_bytes += len(raw_bytes)

            if not imported_files:
                raise HTTPException(status_code=422, detail="Could not decode any text source files from the repository.")

            return {
                "owner": owner,
                "repo": repo,
                "branch": target_branch,
                "repo_url": f"https://github.com/{owner}/{repo}",
                "files": imported_files,
                "imported_count": len(imported_files),
                "skipped_count": skipped_count,
                "truncated": skipped_count > 0,
            }

        # Fallback: Git recursive tree + blobs
        tree_res = session.get(
            f"https://api.github.com/repos/{owner}/{repo}/git/trees/{target_branch}?recursive=1",
            headers=headers,
            timeout=20,
        )
        if tree_res.status_code == 404:
            raise HTTPException(status_code=404, detail=f"Branch '{target_branch}' not found in '{owner}/{repo}'.")
        if tree_res.status_code == 403:
            raise HTTPException(status_code=429, detail="GitHub API rate limit exceeded while fetching repository tree.")
        if not tree_res.ok:
            raise HTTPException(status_code=502, detail=f"Failed to fetch repository tree ({tree_res.status_code}).")

        tree_data = tree_res.json()
        entries = tree_data.get("tree", [])

        candidates = [
            item for item in entries
            if item.get("type") == "blob"
            and int(item.get("size") or 0) <= MAX_FILE_BYTES
            and (not subpath or item.get("path", "") == subpath or item.get("path", "").startswith(subpath + "/"))
            and _is_supported_file(item.get("path", ""))
        ]

        if not candidates:
            raise HTTPException(status_code=404, detail="No supported source files found in the specified repository or path.")

        candidates.sort(key=lambda x: _sort_key(x["path"]))
        selected = candidates[:MAX_IMPORT_FILES]

        imported_files = {}
        total_bytes = 0
        skipped_count = max(0, len(candidates) - len(selected))

        for item in selected:
            path = item["path"]
            size = int(item.get("size") or 0)
            if total_bytes + size > MAX_TOTAL_BYTES or not item.get("url"):
                skipped_count += 1
                continue
            blob_res = session.get(item["url"], headers=headers, timeout=15)
            if not blob_res.ok:
                skipped_count += 1
                continue
            blob_json = blob_res.json()
            if blob_json.get("encoding") == "base64" and blob_json.get("content"):
                try:
                    raw_bytes = base64.b64decode(blob_json["content"])
                    if b"\x00" in raw_bytes[:1024]:
                        skipped_count += 1
                        continue
                    imported_files[path] = raw_bytes.decode("utf-8", errors="replace")
                    total_bytes += len(raw_bytes)
                except Exception:
                    skipped_count += 1

        if not imported_files:
            raise HTTPException(status_code=422, detail="Could not decode any text source files from the repository.")

        return {
            "owner": owner,
            "repo": repo,
            "branch": target_branch,
            "repo_url": f"https://github.com/{owner}/{repo}",
            "files": imported_files,
            "imported_count": len(imported_files),
            "skipped_count": skipped_count,
            "truncated": bool(tree_data.get("truncated")) or skipped_count > 0,
        }
    except HTTPException:
        raise
    except requests.RequestException as exc:
        logger.warning("GitHub import network error for %s/%s: %s", owner, repo, exc)
        raise HTTPException(status_code=502, detail="Unable to reach GitHub API. Check your internet connection and try again.")
