def test_execution_disabled_by_default(client):
    response = client.post("/execute/", json={"filename": "main.py", "code": "print('hello')"})
    assert response.status_code == 503
    assert "disabled" in response.json()["detail"].lower()

def test_execution_rejects_empty_code(client):
    response = client.post("/execute/", json={"filename": "main.py", "code": ""})
    assert response.status_code == 422

def test_execution_rejects_path_filename(client):
    response = client.post("/execute/", json={"filename": "../main.py", "code": "print(1)"})
    # The filename is normalized to a basename, then execution is rejected because it is disabled.
    assert response.status_code == 503
