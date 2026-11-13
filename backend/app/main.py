from fastapi import FastAPI
from fastapi import HTTPException, status

from app.models.patient import Patient

app = FastAPI(
    title="MediFlow AI",
    version="0.1.0",
)

patients: dict[str, Patient] = {}


@app.get("/patients", response_model=list[Patient])
def list_patients() -> list[Patient]:
    return list(patients.values())


@app.get("/patients/{patient_id}", response_model=Patient)
def get_patient(patient_id: str) -> Patient:
    patient = patients.get(patient_id)
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
    if patient.patient_id in patients:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Patient ID already exists",
        )
    patients[patient.patient_id] = patient
    return patient