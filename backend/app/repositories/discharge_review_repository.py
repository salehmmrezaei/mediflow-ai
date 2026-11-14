
from datetime import datetime, timezone

from botocore.exceptions import ClientError

from app.ai.discharge_letter import (
    SECTION_NAMES,
    MISSING_TEXT,
)
from app.repositories import (
    discharge_job_repository as jobs_repo,
    clinical_note_repository,
)


class JobNotFoundError(Exception):
    pass


class DraftNotReadyError(Exception):
    pass


class ReviewConflictError(Exception):
    pass


class ReviewValidationError(Exception):
    pass


def _owned_job(job_id: str, doctor_sub: str) -> dict:
    job = jobs_repo.get_discharge_job(job_id, doctor_sub)

    if job is None:
        raise JobNotFoundError()

    return job


def _draft_view(job: dict) -> dict:
    return {
        "job_id": job["job_id"],
        "patient_id": job["patient_id"],
        "status": job["status"],
        "updated_at": job["updated_at"],
        "document_state": job.get(
            "document_state", "UNSIGNED_DRAFT"
        ),
        "draft": {
            name: job["draft"][name]
            for name in SECTION_NAMES
        },
        "missing_sections": job.get("missing_sections", []),
        "supporting_note_ids": job.get(
            "supporting_note_ids", []
        ),
        "review_note": job.get("review_note", ""),
    }


def get_discharge_draft(
    job_id: str,
    doctor_sub: str,
) -> dict:
    job = _owned_job(job_id, doctor_sub)

    if not job.get("draft"):
        raise DraftNotReadyError(
            "Discharge draft is not ready"
        )

    return _draft_view(job)


def _require_pending(job: dict):
    if (
        job.get("status") != "PENDING_REVIEW"
        or not job.get("draft")
    ):
        raise ReviewConflictError(
            "Job is not awaiting review"
        )


def _conditional_update(**kwargs) -> dict:
    try:
        response = jobs_repo.get_jobs_table().update_item(
            **kwargs
        )
        return response["Attributes"]

    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")

        if code == "ConditionalCheckFailedException":
            raise ReviewConflictError(
                "Job changed. Reload the draft and retry."
            ) from None

        raise


def edit_discharge_draft(
    job_id: str,
    doctor_sub: str,
    expected_updated_at: str,
    draft,
) -> dict:
    job = _owned_job(job_id, doctor_sub)
    _require_pending(job)

    # Check citations against the patient's authorized notes.
    notes = clinical_note_repository.list_clinical_notes(
        patient_id=job["patient_id"],
        doctor_sub=doctor_sub,
    )

    valid_ids = {
        str(note["note_id"])
        for note in notes
        if note.get("note_id")
    }

    evidence_ids = set()
    missing_sections = []

    for name in SECTION_NAMES:
        section = getattr(draft, name)

        if len(section.text) > 2000:
            raise ReviewValidationError(
                f"Section is too long: {name}"
            )

        if len(section.supporting_note_ids) > 20:
            raise ReviewValidationError(
                f"Too many evidence references: {name}"
            )

        if section.documented:
            if (
                not section.supporting_note_ids
                or section.text.strip() == MISSING_TEXT
                or not set(section.supporting_note_ids)
                <= valid_ids
            ):
                raise ReviewValidationError(
                    f"Invalid evidence in section: {name}"
                )

            evidence_ids.update(
                section.supporting_note_ids
            )

        else:
            if (
                section.text.strip() != MISSING_TEXT
                or section.supporting_note_ids
            ):
                raise ReviewValidationError(
                    f"Invalid missing section: {name}"
                )

            missing_sections.append(name)

    now = datetime.now(timezone.utc).isoformat()
    draft_data = draft.model_dump()

    updated = _conditional_update(
        Key={"job_id": job_id},
        UpdateExpression=(
            "SET #draft = :draft, "
            "updated_at = :now, "
            "missing_sections = :missing, "
            "supporting_note_ids = :evidence, "
            "draft_last_edited_by = :doctor, "
            "draft_last_edited_at = :now"
        ),
        ConditionExpression=(
            "attribute_exists(job_id) "
            "AND doctor_sub = :doctor "
            "AND #status = :pending "
            "AND updated_at = :expected "
            "AND attribute_exists(#draft)"
        ),
        ExpressionAttributeNames={
            "#status": "status",
            "#draft": "draft",
        },
        ExpressionAttributeValues={
            ":doctor": doctor_sub,
            ":pending": "PENDING_REVIEW",
            ":expected": expected_updated_at,
            ":now": now,
            ":draft": draft_data,
            ":missing": missing_sections,
            ":evidence": sorted(evidence_ids),
        },
        ReturnValues="ALL_NEW",
    )

    return _draft_view(updated)


def review_discharge_draft(
    job_id: str,
    doctor_sub: str,
    expected_updated_at: str,
    action: str,
    note: str,
    acknowledge_missing_sections: bool,
) -> dict:
    job = _owned_job(job_id, doctor_sub)
    _require_pending(job)

    note = note.strip()

    if action == "REJECT":
        if not note:
            raise ReviewValidationError(
                "A rejection reason is required"
            )

        next_status = "REJECTED"
        document_state = "REJECTED_DRAFT"

    elif action == "APPROVE":
        if (
            job.get("missing_sections")
            and not acknowledge_missing_sections
        ):
            raise ReviewValidationError(
                "Acknowledge missing sections before approval"
            )

        next_status = "APPROVED"
        document_state = "REVIEW_APPROVED_UNSIGNED"

    else:
        raise ReviewValidationError(
            "Invalid review action"
        )

    now = datetime.now(timezone.utc).isoformat()

    updated = _conditional_update(
        Key={"job_id": job_id},
        UpdateExpression=(
            "SET #status = :next_status, "
            "updated_at = :now, "
            "reviewed_at = :now, "
            "reviewed_by = :doctor, "
            "review_note = :note, "
            "document_state = :document_state"
        ),
        ConditionExpression=(
            "attribute_exists(job_id) "
            "AND doctor_sub = :doctor "
            "AND #status = :pending "
            "AND updated_at = :expected "
            "AND attribute_exists(#draft)"
        ),
        ExpressionAttributeNames={
            "#status": "status",
            "#draft": "draft",
        },
        ExpressionAttributeValues={
            ":doctor": doctor_sub,
            ":pending": "PENDING_REVIEW",
            ":expected": expected_updated_at,
            ":next_status": next_status,
            ":now": now,
            ":note": note,
            ":document_state": document_state,
        },
        ReturnValues="ALL_NEW",
    )

    return _draft_view(updated)
