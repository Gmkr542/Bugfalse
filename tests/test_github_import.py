import io
import zipfile
from unittest.mock import MagicMock, patch
import pytest
from routes.github_import import parse_github_url


def test_parse_github_url():
    assert parse_github_url("https://github.com/Gmkr542/Bugfalse") == ("Gmkr542", "Bugfalse", None, None)
    assert parse_github_url("Gmkr542/Bugfalse") == ("Gmkr542", "Bugfalse", None, None)
    assert parse_github_url("https://github.com/Gmkr542/Bugfalse/tree/main/routes") == ("Gmkr542", "Bugfalse", "main", "routes")


def test_parse_github_url_invalid():
    with pytest.raises(ValueError):
        parse_github_url("https://gitlab.com/owner/repo")


def test_github_import_zipball(client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Gmkr542-Bugfalse-123/main.py", "print('hello studio')\n")
    repo_res = MagicMock(status_code=200, ok=True)
    repo_res.json.return_value = {"default_branch": "main"}
    zip_res = MagicMock(status_code=200, ok=True, content=buf.getvalue())

    with patch("routes.github_import.requests.Session.get", side_effect=[repo_res, zip_res]):
        res = client.post("/github/import", json={"repo_url": "https://github.com/Gmkr542/Bugfalse"})

    assert res.status_code == 200
    body = res.json()
    assert body["imported_count"] == 1
    assert body["files"]["main.py"] == "print('hello studio')\n"
