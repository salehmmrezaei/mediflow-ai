from datetime import date
from typing import Literal
from pydantic import BaseModel, Field
from .diagnosis import Diagnosis


class Patient(BaseModel):
    patient_id: str = Field(min_length=1)
    first_name: str = Field(min_length=1)
    last_name: str = Field(min_length=1)
    age: int = Field(ge=0, le=120)
    diagnosis: Diagnosis
    admission_date: date
    status: Literal["scheduled", "admitted", "discharged"]
