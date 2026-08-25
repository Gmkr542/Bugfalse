from unittest.mock import patch

def test_debug_rejects_empty_code(client):
    response = client.post("/debug/", json={"code": "   "})
    assert response.status_code == 422
    assert "must not be empty" in response.json()["detail"]

def test_debug_normalizes_result(client):
    mocked = {
        "errors": [{"message": "bad"}],
        "explanation": "analysis",
        "fixed_code": "print('ok')",
    }
    with patch("routes.debug.groq_service.analyze_code", return_value=mocked):
        response = client.post("/debug/", json={"code": "print("})
    assert response.status_code == 200
    data = response.json()
    assert data["provider"] == "groq"
    assert "issues" in data
    assert "analysis" in data
    assert "errors" not in data
    assert "explanation" not in data

def test_debug_accepts_api_key_alias(client):
    with patch("routes.debug.groq_service.analyze_code", return_value={"issues": []}) as mock:
        response = client.post("/debug/", json={"code": "x = 1", "api_key": "test-key"})
    assert response.status_code == 200
    mock.assert_called_once_with("x = 1", "test-key")


def test_debug_preserves_fixed_code(client):
    mocked = {"fixed_code": "print('fixed')", "analysis": "Fixed", "issues": []}
    with patch("routes.debug.groq_service.analyze_code", return_value=mocked):
        response = client.post("/debug/", json={"code": "print('bad')", "mode": "fix", "filename": "main.py", "language": "python"})
    assert response.status_code == 200
    assert response.json()["fixed_code"] == "print('fixed')"

def test_debug_reports_provider_error(client):
    mocked = {"error": "Groq API token is invalid.", "hint": "Check GROQ_TOKEN."}
    with patch("routes.debug.groq_service.analyze_code", return_value=mocked):
        response = client.post("/debug/", json={"code": "print(1)", "mode": "improve", "filename": "main.py", "language": "python"})
    assert response.status_code == 200
    data = response.json()
    assert data["error"] == "Groq API token is invalid."
    assert data["hint"] == "Check GROQ_TOKEN."
