def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
    assert "X-Request-ID" in response.headers
    assert response.headers["X-Content-Type-Options"] == "nosniff"

def test_status(client):
    response = client.get("/status")
    assert response.status_code == 200
    assert response.json()["execution_enabled"] is False

def test_home(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "BugFalse" in response.text

def test_ready(client):
    response = client.get("/ready")
    assert response.status_code == 200
    assert "ai_configured" in response.json()
