import { useEffect, useState } from 'react'
import { getPatients, type Patient } from '../api/patients'
import { ClinicalAssistant } from './ClinicalAssistant'
import { DischargeLetter } from './DischargeLetter'

type PatientDashboardProps = {
  username: string
  onSignOut: () => void
}

type PatientState =
  | { status: 'loading' }
  | { status: 'ready'; patients: Patient[] }
  | { status: 'error'; message: string }

const statusLabels: Record<Patient['status'], string> = {
  scheduled: 'Scheduled',
  admitted: 'Admitted',
  discharged: 'Discharged',
}

function formatAdmissionDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return value
  // Admission is a calendar date; local time avoids a UTC day shift.
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  }).format(new Date(year, month - 1, day))
}

export function PatientDashboard({ username, onSignOut }: PatientDashboardProps) {
  const [state, setState] = useState<PatientState>({ status: 'loading' })
  const [requestVersion, setRequestVersion] = useState(0)
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    void getPatients(controller.signal)
      .then((patients) => {
        if (!controller.signal.aborted) {
          setState({ status: 'ready', patients })
          setSelectedPatientId((current) => (
            patients.some((patient) => patient.patient_id === current) ? current : null
          ))
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unable to load patients. Please try again.',
          })
        }
      })
    return () => controller.abort()
  }, [requestVersion])

  const refreshPatients = () => setRequestVersion((version) => version + 1)
  const selectedPatient = state.status === 'ready'
    ? state.patients.find((patient) => patient.patient_id === selectedPatientId) ?? null
    : null

  return (
    <section className="dashboard" aria-labelledby="dashboard-title">
      <div className="dashboard-heading">
        <div>
          <p className="eyebrow">Doctor workspace</p>
          <h1 id="dashboard-title">Your patients</h1>
          <p className="muted">The patient records assigned to your account, in one place.</p>
        </div>
        <div className="doctor-session">
          <div className="doctor-identity">
            <span className="session-label">Signed in as</span>
            <strong>{username}</strong>
          </div>
          <button className="secondary-button" type="button" onClick={onSignOut}>Sign out</button>
        </div>
      </div>

      <div className="patient-card" aria-busy={state.status === 'loading'}>
        <div className="patient-list-header">
          <div>
            <div className="patient-list-title">
              <h2>Patient records</h2>
              {state.status === 'ready' && (
                <span className="record-count" aria-label={`${state.patients.length} patients`}>
                  {state.patients.length}
                </span>
              )}
            </div>
            <p className="muted">Select a patient to ask about their notes or prepare a discharge draft.</p>
          </div>
          <button className="secondary-button refresh-button" type="button"
            onClick={refreshPatients} disabled={state.status === 'loading'}>Refresh</button>
        </div>

        {state.status === 'loading' && (
          <div className="patient-state" role="status">
            <span className="loading-indicator" aria-hidden="true" />
            <h3>Loading your patients</h3>
            <p className="muted">Retrieving the records assigned to your account.</p>
          </div>
        )}

        {state.status === 'error' && (
          <div className="patient-state">
            <div role="alert">
              <h3>Patient records couldn’t be loaded</h3>
              <p className="error-message">{state.message}</p>
            </div>
            <button className="primary-button" type="button" onClick={refreshPatients}>Try again</button>
          </div>
        )}

        {state.status === 'ready' && state.patients.length === 0 && (
          <div className="patient-state" role="status">
            <span className="empty-state-icon" aria-hidden="true">+</span>
            <h3>No patients assigned yet</h3>
            <p className="muted">Your assigned synthetic patient records will appear here.</p>
          </div>
        )}

        {state.status === 'ready' && state.patients.length > 0 && (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Patient records table">
            <table className="patient-table">
              <caption className="sr-only">Synthetic patient records assigned to the signed-in doctor</caption>
              <thead><tr>
                <th scope="col">Patient</th><th scope="col">Age</th><th scope="col">Diagnosis</th>
                <th scope="col">Admission date</th><th scope="col">Status</th>
              </tr></thead>
              <tbody>
                {state.patients.map((patient) => (
                  <tr key={patient.patient_id}
                    className={selectedPatientId === patient.patient_id ? 'is-selected' : undefined}>
                    <th scope="row">
                      <button type="button" className="patient-name patient-select"
                        aria-label={`Select ${patient.first_name} ${patient.last_name} (${patient.patient_id})`}
                        aria-pressed={selectedPatientId === patient.patient_id}
                        aria-controls="clinical-assistant discharge-letter"
                        onClick={() => setSelectedPatientId(patient.patient_id)}>
                        {patient.first_name} {patient.last_name}
                      </button>
                      <span className="patient-id">{patient.patient_id}</span>
                      {selectedPatientId === patient.patient_id && (
                        <span className="patient-selection-label">Selected</span>
                      )}
                    </th>
                    <td>{patient.age}</td>
                    <td className="diagnosis-cell">{patient.diagnosis.diagnosis}</td>
                    <td><time dateTime={patient.admission_date}>{formatAdmissionDate(patient.admission_date)}</time></td>
                    <td><span className={`status-badge status-${patient.status}`}>
                      <span aria-hidden="true" />{statusLabels[patient.status]}
                    </span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ClinicalAssistant patient={selectedPatient} />
      <DischargeLetter patient={selectedPatient} />
    </section>
  )
}
