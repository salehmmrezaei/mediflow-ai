
import uuid
from app.services import discharge_workflow
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from app.main import app, get_current_doctor
from app.repositories import discharge_job_repository as repo


client = TestClient(app)

CREATE_URL = "/patients/PATIENT-A/discharge-letters"


class FakeJobsTable:
    def __init__(self):
        self.items = {}
        self.write_count = 0

    def put_item(self, Item, ConditionExpression):
        assert ConditionExpression == (
            "attribute_not_exists(job_id)"
        )

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


@pytest.fixture(autouse=True)
def fake_database(monkeypatch):
    # Never start real AWS workflows during unit tests.
    monkeypatch.setattr(
        discharge_workflow,
        "start_discharge_workflow",
        lambda job_id: f"mock-execution:{job_id}",
    )
    table = FakeJobsTable()

    owners = {
        "PATIENT-A": "DOCTOR-A",
        "PATIENT-B": "DOCTOR-A",
        "PATIENT-C": "DOCTOR-B",
    }

    def get_patient(patient_id, doctor_sub):
        if owners.get(patient_id) != doctor_sub:
            return None

        return {
            "patient_id": patient_id,
            "doctor_sub": doctor_sub,
        }

    monkeypatch.setattr(
        repo, "get_jobs_table", lambda: table
    )

    monkeypatch.setattr(
        repo.patient_repository,
        "get_patient",
        get_patient,
    )

    app.dependency_overrides.clear()

    yield table

    app.dependency_overrides.clear()


def authenticate(doctor_sub):
    app.dependency_overrides[get_current_doctor] = (
        lambda: doctor_sub
    )


def create_job(patient_id="PATIENT-A", key=None):
    return client.post(
        f"/patients/{patient_id}/discharge-letters",
        headers={
            "Idempotency-Key": key or str(uuid.uuid4())
        },
    )


def test_create_job_returns_202(fake_database):
    authenticate("DOCTOR-A")

    response = create_job()

    assert response.status_code == 202

    job = response.json()

    assert job["status"] == "QUEUED"
    assert job["patient_id"] == "PATIENT-A"
    assert job["job_id"]
    assert job["created_at"]
    assert job["updated_at"]
    assert "doctor_sub" not in job
    assert fake_database.write_count == 1


def test_duplicate_request_is_idempotent(fake_database):
    authenticate("DOCTOR-A")
    key = str(uuid.uuid4())

    first = create_job(key=key)
    second = create_job(key=key)

    assert first.status_code == 202
    assert second.status_code == 202

    assert (
        first.json()["job_id"]
        == second.json()["job_id"]
    )
    assert fake_database.write_count == 1


def test_key_reuse_for_other_patient_returns_409():
    authenticate("DOCTOR-A")
    key = str(uuid.uuid4())

    first = create_job("PATIENT-A", key)
    second = create_job("PATIENT-B", key)

    assert first.status_code == 202
    assert second.status_code == 409


def test_unauthorized_patient_returns_404(fake_database):
    authenticate("DOCTOR-B")

    response = create_job("PATIENT-A")

    assert response.status_code == 404
    assert fake_database.write_count == 0


def test_unknown_patient_returns_404(fake_database):
    authenticate("DOCTOR-A")

    response = create_job("UNKNOWN-PATIENT")

    assert response.status_code == 404
    assert fake_database.write_count == 0


def test_missing_idempotency_key_returns_422():
    authenticate("DOCTOR-A")

    response = client.post(CREATE_URL)

    assert response.status_code == 422


def test_invalid_idempotency_key_returns_422():
    authenticate("DOCTOR-A")

    response = client.post(
        CREATE_URL,
        headers={"Idempotency-Key": "invalid-key"},
    )

    assert response.status_code == 422


def test_job_status_is_owner_only():
    authenticate("DOCTOR-A")

    created = create_job()
    assert created.status_code == 202

    job_id = created.json()["job_id"]

    owner_response = client.get(
        f"/discharge-jobs/{job_id}"
    )

    assert owner_response.status_code == 200
    assert owner_response.json()["status"] == "QUEUED"

    authenticate("DOCTOR-B")

    other_doctor_response = client.get(
        f"/discharge-jobs/{job_id}"
    )

    assert other_doctor_response.status_code == 404


def test_unknown_job_returns_404():
    authenticate("DOCTOR-A")

    response = client.get(
        f"/discharge-jobs/{uuid.uuid4()}"
    )

    assert response.status_code == 404


@pytest.mark.parametrize(
    "method,path",
    [
        (
            "post",
            "/patients/PATIENT-A/discharge-letters",
        ),
        (
            "get",
            "/discharge-jobs/some-job-id",
        ),
    ],
)
def test_unauthenticated_requests_rejected(method, path):
    headers = {
        "Idempotency-Key": str(uuid.uuid4())
    }

    response = getattr(client, method)(
        path,
        headers=headers,
    )

    assert response.status_code == 401


def test_database_error_during_creation_returns_503(
    fake_database,
    monkeypatch,
):
    authenticate("DOCTOR-A")

    def fail_write(**kwargs):
        raise ClientError(
            {
                "Error": {
                    "Code": "InternalServerError",
                    "Message": "Simulated database failure",
                }
            },
            "PutItem",
        )

    monkeypatch.setattr(
        fake_database, "put_item", fail_write
    )

    response = create_job()

    assert response.status_code == 503


def test_database_error_during_status_returns_503(
    fake_database,
    monkeypatch,
):
    authenticate("DOCTOR-A")

    created = create_job()
    assert created.status_code == 202

    job_id = created.json()["job_id"]

    def fail_read(**kwargs):
        raise ClientError(
            {
                "Error": {
                    "Code": "InternalServerError",
                    "Message": "Simulated database failure",
                }
            },
            "GetItem",
        )

    monkeypatch.setattr(
        fake_database, "get_item", fail_read
    )

    response = client.get(
        f"/discharge-jobs/{job_id}"
    )

    assert response.status_code == 503



def test_failed_dispatch_can_be_retried(
    fake_database,
    monkeypatch,
):
    authenticate("DOCTOR-A")

    key = str(uuid.uuid4())
    attempts = []

    def simulated_dispatch(job_id):
        attempts.append(job_id)

        if len(attempts) == 1:
            raise ClientError(
                {
                    "Error": {
                        "Code": "ServiceUnavailable",
                        "Message": "Simulated failure",
                    }
                },
                "StartExecution",
            )

        return f"mock-execution:{job_id}"

    monkeypatch.setattr(
        discharge_workflow,
        "start_discharge_workflow",
        simulated_dispatch,
    )

    # The job is persisted, but dispatch fails.
    first = create_job(key=key)

    assert first.status_code == 503
    assert fake_database.write_count == 1

    # Retry the exact same request.
    second = create_job(key=key)

    assert second.status_code == 202
    assert second.json()["status"] == "QUEUED"

    # No new DynamoDB job was created.
    assert fake_database.write_count == 1

    # Both attempts used the same job ID.
    assert len(attempts) == 2
    assert attempts[0] == attempts[1]
    assert second.json()["job_id"] == attempts[0]


def test_existing_execution_does_not_fail_retry(
    fake_database,
    monkeypatch,
):
    authenticate("DOCTOR-A")

    key = str(uuid.uuid4())
    attempts = []

    def simulated_dispatch(job_id):
        attempts.append(job_id)

        if len(attempts) == 2:
            raise (
                discharge_workflow
                .WorkflowExecutionAlreadyExistsError(
                    "Execution already exists"
                )
            )

        return f"mock-execution:{job_id}"

    monkeypatch.setattr(
        discharge_workflow,
        "start_discharge_workflow",
        simulated_dispatch,
    )

    first = create_job(key=key)
    second = create_job(key=key)

    assert first.status_code == 202
    assert second.status_code == 202
    assert (
        first.json()["job_id"]
        == second.json()["job_id"]
    )

    assert fake_database.write_count == 1
    assert attempts[0] == attempts[1]
