from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import app, patients

client = TestClient(app)


@pytest.fixture(autouse=True)
def clear_patients() -> Iterator[None]:
    patients.clear()
    yield
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


def test_list_patients_returns_empty_list() -> None:
    response = client.get("/patients")

    assert response.status_code == 200
    assert response.json() == []


def test_create_patient_returns_created_patient() -> None:
    response = client.post("/patients", json=patient_payload())

    assert response.status_code == 201
    assert response.json() == patient_payload()


def test_get_patient_returns_patient_by_id() -> None:
    client.post("/patients", json=patient_payload())

    response = client.get("/patients/P-001")

    assert response.status_code == 200
    assert response.json() == patient_payload()


def test_get_nonexistent_patient_returns_not_found() -> None:
    response = client.get("/patients/unknown")

    assert response.status_code == 404


def test_create_duplicate_patient_returns_conflict() -> None:
    client.post("/patients", json=patient_payload())

    response = client.post("/patients", json=patient_payload())

    assert response.status_code == 409


def test_create_invalid_patient_returns_unprocessable_entity() -> None:
    invalid_payload = patient_payload()
    invalid_payload["age"] = 121

    response = client.post("/patients", json=invalid_payload)

    assert response.status_code == 422
