from datetime import date

import pytest
from pydantic import ValidationError

from app.models.patient import Diagnosis, Patient


def test_patient_accepts_valid_data_and_related_diagnosis() -> None:
    patient = Patient(
        patient_id="P-001",
        first_name="Ada",
        last_name="Lovelace",
        age=36,
        diagnosis={"diagnosis": "Pneumonia"},
        admission_date=date(2026, 11, 12),
        status="admitted",
    )

    assert patient.diagnosis == Diagnosis(diagnosis="Pneumonia")
    assert patient.admission_date == date(2026, 11, 12)


@pytest.mark.parametrize("field", ["patient_id", "first_name", "last_name"])
def test_patient_rejects_empty_identity_fields(field: str) -> None:
    data = {
        "patient_id": "P-001",
        "first_name": "Ada",
        "last_name": "Lovelace",
        "age": 36,
        "diagnosis": {"diagnosis": "Pneumonia"},
        "admission_date": date(2026, 11, 12),
        "status": "scheduled",
    }
    data[field] = ""

    with pytest.raises(ValidationError):
        Patient(**data)


def test_diagnosis_is_a_related_model_and_rejects_empty_value() -> None:
    with pytest.raises(ValidationError):
        Diagnosis(diagnosis="")

    assert Patient.model_fields["diagnosis"].annotation is Diagnosis


@pytest.mark.parametrize("age", [-1, 121])
def test_patient_rejects_age_outside_allowed_range(age: int) -> None:
    with pytest.raises(ValidationError):
        Patient(
            patient_id="P-001",
            first_name="Ada",
            last_name="Lovelace",
            age=age,
            diagnosis={"diagnosis": "Pneumonia"},
            admission_date=date(2026, 11, 12),
            status="scheduled",
        )


def test_patient_rejects_unknown_status() -> None:
    with pytest.raises(ValidationError):
        Patient(
            patient_id="P-001",
            first_name="Ada",
            last_name="Lovelace",
            age=36,
            diagnosis={"diagnosis": "Pneumonia"},
            admission_date=date(2026, 11, 12),
            status="pending",
        )