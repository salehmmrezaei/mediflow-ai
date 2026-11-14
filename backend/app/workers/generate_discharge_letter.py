
import os
import uuid
from datetime import datetime, timezone
from app.ai.discharge_letter import SECTION_NAMES
import boto3
from botocore.exceptions import ClientError

from app.ai.discharge_letter import generate_discharge_draft
from app.repositories import (
    patient_repository,
    clinical_note_repository,
)


def get_jobs_table():
    return boto3.resource("dynamodb").Table(
        os.environ["DISCHARGE_JOBS_TABLE"]
    )


def lambda_handler(event, context):
    """Generate and persist a reviewable discharge draft."""

    job_id = event.get("job_id") if isinstance(event, dict) else None

    try:
        if (
            not isinstance(job_id, str)
            or str(uuid.UUID(job_id)) != job_id
        ):
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise ValueError("Invalid job ID") from None

    table = get_jobs_table()

    # Read the authoritative job record.
    job = table.get_item(
        Key={"job_id": job_id},
        ConsistentRead=True,
    ).get("Item")

    if not job:
        raise ValueError("Discharge job not found")

    # A successful earlier invocation may already
    # have saved the draft.
    if job.get("status") == "PENDING_REVIEW" and job.get("draft"):
        return {
            "job_id": job_id,
            "status": "PENDING_REVIEW",
            "already_generated": True,
        }

    if job.get("status") != "PROCESSING":
        raise ValueError("Job is not ready for generation")

    patient_id = job["patient_id"]
    doctor_sub = job["doctor_sub"]

    # Verify ownership again in the worker.
    patient = patient_repository.get_patient(
        patient_id,
        doctor_sub,
    )

    if patient is None:
        raise ValueError("Patient authorization failed")

    # This repository checks patient ownership
    # before querying clinical notes.
    notes = clinical_note_repository.list_clinical_notes(
        patient_id=patient_id,
        doctor_sub=doctor_sub,
    )

    if not notes:
        raise ValueError("No clinical evidence available")

    # Generate and structurally validate the draft.
    draft = generate_discharge_draft(notes)
    draft_data = {name: draft[name] for name in SECTION_NAMES}

    # Collect all cited note IDs.
    evidence_ids = sorted({
        note_id
        for section_name, section in draft.items()
        if section_name != "missing_sections"
        for note_id in section["supporting_note_ids"]
    })

    now = datetime.now(timezone.utc).isoformat()

    # Atomically save the draft and change status.
    try:
        table.update_item(
            Key={"job_id": job_id},
            UpdateExpression=(
                "SET #status = :pending, "
                "updated_at = :now, "
                "#draft = :draft, "
                "draft_generated_at = :now, "
                "supporting_note_ids = :evidence, "
                "missing_sections = :missing, "
                "document_state = :unsigned"
            ),
            ConditionExpression=(
                "attribute_exists(job_id) "
                "AND #status = :processing "
                "AND patient_id = :patient_id "
                "AND doctor_sub = :doctor_sub"
            ),
            ExpressionAttributeNames={
                "#status": "status",
                "#draft": "draft",
            },
            ExpressionAttributeValues={
                ":processing": "PROCESSING",
                ":pending": "PENDING_REVIEW",
                ":patient_id": patient_id,
                ":doctor_sub": doctor_sub,
                ":draft": draft_data,
                ":evidence": evidence_ids,
                ":missing": draft["missing_sections"],
                ":unsigned": "UNSIGNED_DRAFT",
                ":now": now,
            },
        )

    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")

        if code == "ConditionalCheckFailedException":
            latest = table.get_item(
                Key={"job_id": job_id},
                ConsistentRead=True,
            ).get("Item")

            if (
                latest
                and latest.get("status") == "PENDING_REVIEW"
                and latest.get("draft")
            ):
                return {
                    "job_id": job_id,
                    "status": "PENDING_REVIEW",
                    "already_generated": True,
                }

        raise

    return {
        "job_id": job_id,
        "status": "PENDING_REVIEW",
        "already_generated": False,
        "missing_sections": draft["missing_sections"],
    }
