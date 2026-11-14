import uuid
from unittest.mock import MagicMock
import pytest
from botocore.exceptions import ClientError
from app.repositories import discharge_job_repository as repo


class FakeJobsTable:
    def __init__(self):
        self.items = {}
        self.write_count = 0

    def put_item(self, Item, ConditionExpression):
        job_id = Item["job_id"]

        if job_id in self.items:
            raise ClientError(
                {
                    "Error": {
                        "Code": "ConditionalCheckFailedException",
                        "Message": "Already exists",
                    }
                },
                "PutItem",
            )

        self.items[job_id] = Item.copy()
        self.write_count += 1

    def get_item(self, Key, ConsistentRead=False):
        item = self.items.get(Key["job_id"])
        return {"Item": item} if item else {}


@pytest.fixture
def jobs_table(monkeypatch):
    table = FakeJobsTable()

    monkeypatch.setattr(
        repo,
        "get_jobs_table",
        lambda: table,
    )

    monkeypatch.setattr(
        repo.patient_repository,
        "get_patient",
        lambda patient_id, doctor_sub: {
            "patient_id": patient_id,
            "doctor_sub": doctor_sub,
        },
    )

    return table


def test_create_job(jobs_table):
    job, created = repo.create_discharge_job(
        "PATIENT-A",
        "DOCTOR-A",
        str(uuid.uuid4()),
    )

    assert created is True
    assert job["status"] == "QUEUED"
    assert job["patient_id"] == "PATIENT-A"
    assert job["doctor_sub"] == "DOCTOR-A"
    assert jobs_table.write_count == 1


def test_idempotent_retry(jobs_table):
    key = str(uuid.uuid4())

    first, first_created = repo.create_discharge_job(
        "PATIENT-A", "DOCTOR-A", key
    )

    second, second_created = repo.create_discharge_job(
        "PATIENT-A", "DOCTOR-A", key
    )

    assert first_created is True
    assert second_created is False
    assert first["job_id"] == second["job_id"]
    assert jobs_table.write_count == 1


def test_key_reuse_for_other_patient(jobs_table):
    key = str(uuid.uuid4())

    repo.create_discharge_job(
        "PATIENT-A", "DOCTOR-A", key
    )

    with pytest.raises(repo.IdempotencyConflictError):
        repo.create_discharge_job(
            "PATIENT-B", "DOCTOR-A", key
        )


def test_doctors_have_separate_jobs(jobs_table):
    key = str(uuid.uuid4())

    first, _ = repo.create_discharge_job(
        "PATIENT-A", "DOCTOR-A", key
    )

    second, _ = repo.create_discharge_job(
        "PATIENT-A", "DOCTOR-B", key
    )

    assert first["job_id"] != second["job_id"]


def test_unauthorized_patient(monkeypatch, jobs_table):
    monkeypatch.setattr(
        repo.patient_repository,
        "get_patient",
        lambda patient_id, doctor_sub: None,
    )

    with pytest.raises(repo.PatientAccessDeniedError):
        repo.create_discharge_job(
            "PATIENT-A",
            "DOCTOR-B",
            str(uuid.uuid4()),
        )

    assert jobs_table.write_count == 0


def test_job_status_owner_only(jobs_table):
    job, _ = repo.create_discharge_job(
        "PATIENT-A",
        "DOCTOR-A",
        str(uuid.uuid4()),
    )

    assert repo.get_discharge_job(
        job["job_id"], "DOCTOR-A"
    ) == job

    assert repo.get_discharge_job(
        job["job_id"], "DOCTOR-B"
    ) is None


def test_unknown_job_returns_none(jobs_table):
    assert repo.get_discharge_job(
        str(uuid.uuid4()), "DOCTOR-A"
    ) is None


def test_invalid_idempotency_key(jobs_table):
    with pytest.raises(ValueError):
        repo.create_discharge_job(
            "PATIENT-A",
            "DOCTOR-A",
            "not-a-uuid",
        )

    assert jobs_table.write_count == 0
