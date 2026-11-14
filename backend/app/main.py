
from fastapi import FastAPI, HTTPException, status
from mangum import Mangum
from fastapi import Depends, Request
from app.models.patient import Patient
from app.repositories import patient_repository as repo
from app.repositories.patient_repository import PatientAlreadyExistsError
from fastapi import Header
from app.models.discharge_job import DischargeJobStatus
from app.repositories import discharge_job_repository
from pydantic import BaseModel, Field
from openai import (
    APIError,
    APIConnectionError,
    APITimeoutError,
    RateLimitError,
)
from botocore.exceptions import BotoCoreError, ClientError
from app.services import discharge_workflow
from app.ai import clinical_assistant
from app.repositories import clinical_note_repository
from app.models.discharge_review import (
    EditDraftRequest,
    ReviewDecisionRequest,
)
from app.repositories import discharge_review_repository as review_repo


app = FastAPI(
    title="MediFlow AI",
    version="0.1.0",
)


def get_current_doctor(request: Request) -> str:
    event = request.scope.get("aws.event", {})

    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )

    if (
        claims.get("token_use") != "access"
        or not claims.get("sub")
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized",
        )

    return claims["sub"]



class AskPatientRequest(BaseModel):
    question: str = Field(
        min_length=1,
        max_length=500,
    )


class DischargeJobResponse(BaseModel):
    job_id: str
    patient_id: str
    status: DischargeJobStatus
    created_at: str
    updated_at: str



@app.get("/patients", response_model=list[Patient])
def list_patients(
    doctor_sub: str = Depends(get_current_doctor),
) -> list[Patient]:
    return repo.list_patients(doctor_sub)


@app.get("/patients/{patient_id}", response_model=Patient)
def get_patient(
    patient_id: str,
    doctor_sub: str = Depends(get_current_doctor),
) -> Patient:
    patient = repo.get_patient(patient_id, doctor_sub)

    if patient is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Patient not found",
        )

    return patient


@app.post(
    "/patients",
    response_model=Patient,
    status_code=status.HTTP_201_CREATED,
)
def create_patient(
    patient: Patient,
    doctor_sub: str = Depends(get_current_doctor),
) -> Patient:
    try:
        return repo.create_patient(patient, doctor_sub)
    except PatientAlreadyExistsError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Patient ID already exists",
        )


@app.post(
    "/patients/{patient_id}/ask",
    response_model=clinical_assistant.ClinicalAnswer,
)
def ask_patient(
    patient_id: str,
    payload: AskPatientRequest,
    doctor_sub: str = Depends(get_current_doctor),
):
    # 1. Verify patient ownership and retrieve notes.
    try:
        notes = clinical_note_repository.list_clinical_notes(
            patient_id=patient_id,
            doctor_sub=doctor_sub,
        )

    except clinical_note_repository.PatientAccessDeniedError:
        raise HTTPException(
            status_code=404,
            detail="Patient not found",
        )

    except (ClientError, BotoCoreError):
        raise HTTPException(
            status_code=503,
            detail="Clinical records temporarily unavailable",
        )

    # 2. Only authorized evidence reaches the AI.
    try:
        return clinical_assistant.answer_question(
            question=payload.question,
            notes=notes,
        )

    except ValueError:
        raise HTTPException(
            status_code=422,
            detail="Invalid question",
        )

    except (APITimeoutError, TimeoutError):
        raise HTTPException(
            status_code=504,
            detail="AI service timed out",
        )

    except (RateLimitError, APIConnectionError):
        raise HTTPException(
            status_code=503,
            detail="AI service temporarily unavailable",
        )

    except (APIError, RuntimeError):
        raise HTTPException(
            status_code=502,
            detail="AI service could not generate a valid answer",
        )





@app.post(
    "/patients/{patient_id}/discharge-letters",
    status_code=202,
    response_model=DischargeJobResponse,
)
def create_discharge_letter(
    patient_id: str,
    idempotency_key: str = Header(
        ...,
        alias="Idempotency-Key",
    ),
    doctor_sub: str = Depends(get_current_doctor),
):
    # 1. Create or retrieve an authorized job.
    try:
        job, created = (
            discharge_job_repository.create_discharge_job(
                patient_id=patient_id,
                doctor_sub=doctor_sub,
                idempotency_key=idempotency_key,
            )
        )

    except discharge_job_repository.PatientAccessDeniedError:
        raise HTTPException(
            status_code=404,
            detail="Patient not found",
        )

    except discharge_job_repository.IdempotencyConflictError:
        raise HTTPException(
            status_code=409,
            detail="Idempotency key already used",
        )

    except ValueError:
        raise HTTPException(
            status_code=422,
            detail="Invalid Idempotency-Key. Expected UUIDv4.",
        )

    except (ClientError, BotoCoreError):
        raise HTTPException(
            status_code=503,
            detail="Discharge job storage unavailable",
        )

    # 2. Start the workflow if the job is still queued.
    # This includes existing QUEUED jobs, so a retry can
    # recover from a previous failed StartExecution call.
    if job["status"] == DischargeJobStatus.QUEUED.value:
        try:
            discharge_workflow.start_discharge_workflow(
                job["job_id"]
            )

        except discharge_workflow.WorkflowExecutionAlreadyExistsError:
            # The deterministic execution name was already used.
            # Do not start another workflow for this job.
            pass

        except (ClientError, BotoCoreError, RuntimeError):
            # Job was saved, but dispatch was not confirmed.
            # The client must retry with the SAME key.
            raise HTTPException(
                status_code=503,
                detail=(
                    "Discharge job saved, but workflow start "
                    "was not confirmed. Retry with the same "
                    "Idempotency-Key."
                ),
            )

    # 3. Return the persisted job.
    # Never approve a generated draft automatically.
    return job




@app.get(
    "/discharge-jobs/{job_id}",
    response_model=DischargeJobResponse,
)
def get_discharge_job_status(
    job_id: str,
    doctor_sub: str = Depends(get_current_doctor),
):
    try:
        job = discharge_job_repository.get_discharge_job(
            job_id=job_id,
            doctor_sub=doctor_sub,
        )

    except (ClientError, BotoCoreError):
        raise HTTPException(
            status_code=503,
            detail="Discharge job storage unavailable",
        )

    if job is None:
        raise HTTPException(
            status_code=404,
            detail="Discharge job not found",
        )

    return job



def review_api_error(exc):
    if isinstance(exc, review_repo.JobNotFoundError):
        raise HTTPException(
            status_code=404,
            detail="Discharge job not found",
        )

    if isinstance(exc, review_repo.DraftNotReadyError):
        raise HTTPException(
            status_code=409,
            detail="Discharge draft is not ready",
        )

    if isinstance(exc, review_repo.ReviewConflictError):
        raise HTTPException(
            status_code=409,
            detail=str(exc),
        )

    if isinstance(exc, review_repo.ReviewValidationError):
        raise HTTPException(
            status_code=422,
            detail=str(exc),
        )

    if isinstance(exc, (ClientError, BotoCoreError)):
        raise HTTPException(
            status_code=503,
            detail="Discharge review storage unavailable",
        )

    raise exc


@app.get("/discharge-jobs/{job_id}/draft")
def get_discharge_letter_draft(
    job_id: str,
    doctor_sub: str = Depends(get_current_doctor),
):
    try:
        return review_repo.get_discharge_draft(
            job_id, doctor_sub
        )
    except (
        review_repo.JobNotFoundError,
        review_repo.DraftNotReadyError,
        ClientError,
        BotoCoreError,
    ) as exc:
        review_api_error(exc)


@app.put("/discharge-jobs/{job_id}/draft")
def edit_discharge_letter_draft(
    job_id: str,
    payload: EditDraftRequest,
    doctor_sub: str = Depends(get_current_doctor),
):
    try:
        return review_repo.edit_discharge_draft(
            job_id=job_id,
            doctor_sub=doctor_sub,
            expected_updated_at=payload.expected_updated_at,
            draft=payload.draft,
        )
    except (
        review_repo.JobNotFoundError,
        review_repo.ReviewConflictError,
        review_repo.ReviewValidationError,
        clinical_note_repository.PatientAccessDeniedError,
        ClientError,
        BotoCoreError,
    ) as exc:
        if isinstance(
            exc,
            clinical_note_repository.PatientAccessDeniedError,
        ):
            raise HTTPException(
                status_code=404,
                detail="Discharge job not found",
            )
        review_api_error(exc)


@app.post("/discharge-jobs/{job_id}/review")
def review_discharge_letter(
    job_id: str,
    payload: ReviewDecisionRequest,
    doctor_sub: str = Depends(get_current_doctor),
):
    try:
        return review_repo.review_discharge_draft(
            job_id=job_id,
            doctor_sub=doctor_sub,
            expected_updated_at=payload.expected_updated_at,
            action=payload.action,
            note=payload.note,
            acknowledge_missing_sections=(
                payload.acknowledge_missing_sections
            ),
        )
    except (
        review_repo.JobNotFoundError,
        review_repo.ReviewConflictError,
        review_repo.ReviewValidationError,
        ClientError,
        BotoCoreError,
    ) as exc:
        review_api_error(exc)


handler = Mangum(app)
