
import os
import uuid
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

from app.models.discharge_job import DischargeJobStatus
from app.repositories import patient_repository


class PatientAccessDeniedError(Exception):
    pass


class IdempotencyConflictError(Exception):
    pass


def get_jobs_table():
    table_name = os.environ["DISCHARGE_JOBS_TABLE"]
    return boto3.resource("dynamodb").Table(table_name)


def create_discharge_job(
    patient_id: str,
    doctor_sub: str,
    idempotency_key: str,
) -> tuple[dict, bool]:

    # 1. Validate the client-generated UUIDv4 key.
    try:
        request_uuid = uuid.UUID(idempotency_key)
        if request_uuid.version != 4:
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise ValueError(
            "Idempotency-Key must be a valid UUIDv4"
        ) from None

    # 2. Verify the doctor owns the patient.
    patient = patient_repository.get_patient(
        patient_id,
        doctor_sub,
    )

    if patient is None:
        raise PatientAccessDeniedError(
            "Patient not found or access denied"
        )

    # 3. Deterministic ID for the doctor + request key.
    # Retrying the same request produces the same job ID.
    job_id = str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"mediflow:discharge:v1:"
            f"{doctor_sub}:{request_uuid}",
        )
    )

    now = datetime.now(timezone.utc).isoformat()

    job = {
        "job_id": job_id,
        "patient_id": patient_id,
        "doctor_sub": doctor_sub,
        "status": DischargeJobStatus.QUEUED.value,
        "created_at": now,
        "updated_at": now,
    }

    table = get_jobs_table()

    # 4. Atomically create the job if absent.
    try:
        table.put_item(
            Item=job,
            ConditionExpression="attribute_not_exists(job_id)",
        )
        return job, True

    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")

        if code != "ConditionalCheckFailedException":
            raise

    # 5. An existing job uses this idempotency key.
    existing = table.get_item(
        Key={"job_id": job_id},
        ConsistentRead=True,
    ).get("Item")

    if (
        existing is not None
        and existing.get("doctor_sub") == doctor_sub
        and existing.get("patient_id") == patient_id
    ):
        return existing, False

    raise IdempotencyConflictError(
        "Idempotency key already used for another patient"
    )


def get_discharge_job(
    job_id: str,
    doctor_sub: str,
) -> dict | None:

    table = get_jobs_table()

    response = table.get_item(
        Key={"job_id": job_id},
        ConsistentRead=True,
    )

    job = response.get("Item")

    if job is None:
        return None

    if job.get("doctor_sub") != doctor_sub:
        return None

    return job
