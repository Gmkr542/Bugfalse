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
    with patch("routes.debug.requests.post", side_effect=__import__("requests").Timeout):
        response = client.post("/debug/", json={"code": "print(1)"})
    assert response.status_code == 200
    assert response.json()["ai_available"] is False
    assert "timed out" in response.json()["error"]
