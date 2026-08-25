import sys


def test_runtime_catalog(client):
    response = client.get('/runtime/catalog')
    assert response.status_code == 200
    data = response.json()
    assert 'runtimes' in data
    assert any(item['id'] == 'python' for item in data['runtimes'])


def test_runtime_detect_python(client):
    response = client.post('/runtime/detect', json={
        'filename': 'main.py',
        'files': {'main.py': 'print("ok")'}
    })
    assert response.status_code == 200
    data = response.json()
    assert data['language'] == 'python'


def test_runtime_detect_html(client):
    response = client.post('/runtime/detect', json={
        'filename': 'index.html',
        'files': {'index.html': '<h1>Hello</h1>'}
    })
    assert response.status_code == 200
    assert response.json()['language'] == 'html'


def test_execute_python(client):
    response = client.post('/execute/', json={
        'filename': 'main.py',
        'code': 'print("BugFalse test")'
    })
    assert response.status_code == 200
    data = response.json()
    assert data['runtime_available'] is True
    assert data['ok'] is True
    assert 'BugFalse test' in data['stdout']
