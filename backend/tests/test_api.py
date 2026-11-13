import pytest
from fastapi.testclient import TestClient

from app.main import app, patients


@pytest.fixture
def client():
    patients.clear()

    with TestClient(app) as test_client:
        yield test_client

    patients.clear()


def patient_payload(patient_id: str = "P-001") -> dict:
    return {
        "patient_id": patient_id,
        "first_name": "Ada",
        "last_name": "Lovelace",
        "age": 36,
        "diagnosis": {"diagnosis": "Pneumonia"},
        "admission_date": "2026-11-12",
        "status": "admitted",
    }


def test_list_patients(client: TestClient) -> None:
    response = client.get("/patients")

    assert response.status_code == 200


def test_create_patient(client: TestClient) -> None:
    response = client.post("/patients", json=patient_payload())

    assert response.status_code == 201


def test_get_patient(client: TestClient) -> None:
    client.post("/patients", json=patient_payload())

    response = client.get("/patients/P-001")

    assert response.status_code == 200
    assert response.json() == patient_payload()


def test_patient_not_found(client: TestClient) -> None:
    response = client.get("/patients/unknown")

    assert response.status_code == 404


def test_duplicate_patient(client: TestClient) -> None:
    client.post("/patients", json=patient_payload())

    response = client.post("/patients", json=patient_payload())

    assert response.status_code == 409
