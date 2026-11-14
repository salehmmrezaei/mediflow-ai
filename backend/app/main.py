
from fastapi import FastAPI, HTTPException, status
from mangum import Mangum
from fastapi import Depends, Request
from app.models.patient import Patient
from app.repositories import patient_repository as repo
from app.repositories.patient_repository import PatientAlreadyExistsError

from pydantic import BaseModel, Field
from openai import (
    APIError,
    APIConnectionError,
    APITimeoutError,
    RateLimitError,
)
from botocore.exceptions import BotoCoreError, ClientError

from app.ai import clinical_assistant
from app.repositories import clinical_note_repository


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


handler = Mangum(app)
