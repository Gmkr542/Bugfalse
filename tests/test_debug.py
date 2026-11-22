from unittest.mock import patch


def test_debug_empty_code_returns_422(client):
    response = client.post("/debug/", json={"code": "   ", "filename": "main.py"})
    assert response.status_code == 422


def test_debug_without_api_key_falls_back_to_local_syntax(client, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_TOKEN", raising=False)
    response = client.post("/debug/", json={"code": "def broken(:\n    pass\n", "filename": "main.py"})
    assert response.status_code == 200
    data = response.json()
    assert data["ai_available"] is False
    assert any(issue["type"] == "SyntaxError" for issue in data["issues"])


def test_groq_failure_is_reported_without_leaking_secrets(client, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "fake-key")
    with patch(
        "services.groq_service.analyze_code",
        return_value={
            "error": "AI provider request timed out.",
            "hint": "Check network connectivity or retry.",
        },
    ):
        response = client.post("/debug/", json={"code": "print(\'hi\')\n", "filename": "main.py"})

    assert response.status_code == 200
    data = response.json()
    assert data["ai_available"] is False
    assert "fake-key" not in str(data)
    assert data["error"]


def test_repo_debug_overview_without_key(client, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_TOKEN", raising=False)
    response = client.post(
        "/debug/repo",
        json={
            "files": {"app.py": "print('ok')\n", "utils.py": "def helper():\n    return 1\n"},
            "mode": "overview",
            "repo_name": "owner/repo@main",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["mode"] == "overview"
    assert "2 loaded file(s)" in data["summary"]
