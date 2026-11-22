import base64
import io
import zipfile
from unittest.mock import MagicMock, patch
import pytest
from routes.github_import import parse_github_url


def test_parse_github_url_formats():
    assert parse_github_url("https://github.com/Gmkr542/Bugfalse") == ("Gmkr542", "Bugfalse", None, None)
    assert parse_github_url("https://github.com/Gmkr542/Bugfalse.git") == ("Gmkr542", "Bugfalse", None, None)
    assert parse_github_url("Gmkr542/Bugfalse") == ("Gmkr542", "Bugfalse", None, None)
    assert parse_github_url("https://github.com/Gmkr542/Bugfalse/tree/main/routes") == ("Gmkr542", "Bugfalse", "main", "routes")


def test_parse_github_url_rejects_non_github():
    with pytest.raises(ValueError):
        parse_github_url("https://evil.example.com/owner/repo")


def test_github_import_endpoint_zipball_success(client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Gmkr542-Bugfalse-abc123/main.py", "print('from zipball')\n")
        zf.writestr("Gmkr542-Bugfalse-abc123/logo.png", b"\x89PNG\r\n\x1a\n")

    mock_repo_res = MagicMock(status_code=200, ok=True)
    mock_repo_res.json.return_value = {"default_branch": "main"}

    mock_zip_res = MagicMock(status_code=200, ok=True, content=buf.getvalue())

    with patch("routes.github_import.requests.Session.get", side_effect=[mock_repo_res, mock_zip_res]):
        res = client.post("/github/import", json={"repo_url": "https://github.com/Gmkr542/Bugfalse"})

    assert res.status_code == 200
    data = res.json()
    assert data["owner"] == "Gmkr542"
    assert data["repo"] == "Bugfalse"
    assert data["imported_count"] == 1
    assert data["files"]["main.py"] == "print('from zipball')\n"


def test_github_import_invalid_url(client):
    res = client.post("/github/import", json={"repo_url": "https://gitlab.com/user/project"})
    assert res.status_code == 422
