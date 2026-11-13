
from fastapi import FastAPI, HTTPException, status
from mangum import Mangum

from app.models.patient import Patient
from app.repositories import patient_repository as repo
from app.repositories.patient_repository import PatientAlreadyExistsError

app = FastAPI(
    title="MediFlow AI",
    version="0.1.0",
)


@app.get("/patients", response_model=list[Patient])
def list_patients() -> list[Patient]:
    return repo.list_patients()


@app.get("/patients/{patient_id}", response_model=Patient)
def get_patient(patient_id: str) -> Patient:
    patient = repo.get_patient(patient_id)

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
def create_patient(patient: Patient) -> Patient:
    try:
        return repo.create_patient(patient)
    except PatientAlreadyExistsError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Patient ID already exists",
        )


handler = Mangum(app)
