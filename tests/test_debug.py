from unittest.mock import patch

def test_empty_code_rejected(client):
    response = client.post("/debug/", json={"code": "  "})
    assert response.status_code == 422

def test_local_syntax_diagnostics_when_no_key(client, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_TOKEN", raising=False)
    response = client.post("/debug/", json={"code": "def broken(:", "filename": "main.py"})
    assert response.status_code == 200
    data = response.json()
    assert data["provider"] == "local"
    assert data["ai_available"] is False
    assert data["issues"][0]["type"] == "SyntaxError"

def test_groq_failure_is_reported_without_leaking_secrets(client, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "fake-key")
    with patch(
        "services.groq_service.analyze_code",
        return_value={
            "error": "AI provider request timed out.",
            "hint": "Check network connectivity or retry.",
        },
    ):
        response = client.post("/debug/", json={"code": "print('hi')\n", "filename": "main.py"})

    assert response.status_code == 200
    data = response.json()
    assert data["ai_available"] is False
    assert "fake-key" not in str(data)
    assert data["error"]
