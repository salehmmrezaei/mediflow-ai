
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from app.models.patient import Patient
from app.repositories import patient_repository as repo


@pytest.fixture
def fake_table(monkeypatch):
    table = MagicMock()
    monkeypatch.setattr(repo, "get_table", lambda: table)
    return table


def test_doctor_can_get_own_patient(fake_table):
    fake_table.get_item.return_value = {
        "Item": {
            "patient_id": "TEST-002",
            "doctor_sub": "doctor-A",
        }
    }

    result = repo.get_patient("TEST-002", "doctor-A")

    assert result["patient_id"] == "TEST-002"


def test_doctor_cannot_get_another_doctors_patient(fake_table):
    fake_table.get_item.return_value = {
        "Item": {
            "patient_id": "TEST-002",
            "doctor_sub": "doctor-A",
        }
    }

    result = repo.get_patient("TEST-002", "doctor-B")

    assert result is None


def test_patient_creation_saves_doctor_identity(fake_table):
    patient = Patient(
        patient_id="TEST-002",
        first_name="Alice",
        last_name="Example",
        age=30,
        diagnosis={"diagnosis": "Synthetic test diagnosis"},
        admission_date="2026-11-13",
        status="admitted",
    )

    repo.create_patient(patient, "doctor-A")

    saved_item = fake_table.put_item.call_args.kwargs["Item"]

    assert saved_item["doctor_sub"] == "doctor-A"
    assert saved_item["patient_id"] == "TEST-002"
    assert isinstance(saved_item["admission_date"], str)


def test_duplicate_patient_is_rejected(fake_table):
    patient = Patient(
        patient_id="TEST-002",
        first_name="Alice",
        last_name="Example",
        age=30,
        diagnosis={"diagnosis": "Synthetic test diagnosis"},
        admission_date="2026-11-13",
        status="admitted",
    )

    fake_table.put_item.side_effect = ClientError(
        {
            "Error": {
                "Code": "ConditionalCheckFailedException",
                "Message": "Conditional request failed",
            }
        },
        "PutItem",
    )

    with pytest.raises(repo.PatientAlreadyExistsError):
        repo.create_patient(patient, "doctor-A")
