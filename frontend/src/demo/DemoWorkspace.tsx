import { useState } from 'react'
import { DEMO_PATIENTS } from './fixtures'
import { DemoAssistant } from './DemoAssistant'
import { DemoDischargeLetter } from './DemoDischargeLetter'
import '../App.css'
import './DemoWorkspace.css'

export function DemoWorkspace() {
  const [selectedId, setSelectedId] = useState(DEMO_PATIENTS[0].id)
  const [revision, setRevision] = useState(0)
  const patient = DEMO_PATIENTS.find((record) => record.id === selectedId) ?? DEMO_PATIENTS[0]

  function resetDemo() {
    setSelectedId(DEMO_PATIENTS[0].id)
    setRevision((value) => value + 1)
  }

  return (
    <main className="app-shell demo-shell">
      <div className="demo-banner">PUBLIC DEMO — SIMULATED DATA — NOT FOR CLINICAL USE</div>
      <header className="app-header">
        <a className="brand" href="/" aria-label="MediFlow AI home">
          <span className="brand-mark" aria-hidden="true">+</span>
          <span><span className="brand-name">MediFlow <span>AI</span></span><span className="brand-caption">Public interactive demo</span></span>
        </a>
        <nav className="demo-navigation" aria-label="Demo navigation">
          <a className="demo-home" href="/">Return to Home</a>
          <a className="secondary-button" href="/?signin=1">Doctor Sign In <span aria-hidden="true">↗</span></a>
        </nav>
      </header>

      <section className="dashboard" aria-labelledby="demo-title">
        <div className="dashboard-heading">
          <div>
            <p className="eyebrow">Explore MediFlow AI</p>
            <h1 id="demo-title">Your demo workspace</h1>
            <p className="muted">Two fictional patients. Traceable example answers. A discharge draft you can review.</p>
          </div>
          <button className="secondary-button" type="button" onClick={resetDemo}>Reset demo</button>
        </div>
        <div className="patient-card">
          <div className="patient-list-header">
            <div>
              <div className="patient-list-title"><h2>Fictional patient records</h2><span className="record-count">2</span></div>
              <p className="muted">Select a patient to explore. Switching patients resets the assistant and draft.</p>
            </div>
            <span className="demo-chip">No sign-in required</span>
          </div>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Fictional patient records table">
            <table className="patient-table">
              <caption className="sr-only">Invented patients for the public demo; no real patient information</caption>
              <thead><tr><th scope="col">Patient</th><th scope="col">Age</th><th scope="col">Presentation</th><th scope="col">Admission date</th><th scope="col">Status</th></tr></thead>
              <tbody>{DEMO_PATIENTS.map((record) => (
                <tr key={record.id} className={patient.id === record.id ? 'is-selected' : undefined}>
                  <th scope="row">
                    <button className="patient-name patient-select" type="button"
                      aria-label={`Select ${record.name} (${record.id})`} aria-pressed={patient.id === record.id}
                      aria-controls="demo-patient" onClick={() => setSelectedId(record.id)}>{record.name}</button>
                    <span className="patient-id">{record.id}</span>
                    {patient.id === record.id && <span className="patient-selection-label">Selected</span>}
                  </th>
                  <td>{record.age}</td><td className="diagnosis-cell">{record.presentation}</td>
                  <td><time dateTime={record.admissionDate}>{record.admissionDate}</time></td>
                  <td><span className="status-badge status-admitted"><span aria-hidden="true" />Fictional admission</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>

        <div id="demo-patient" key={`${patient.id}-${revision}`}>
          <section className="demo-patient-context" aria-labelledby="demo-selected-title">
            <p className="eyebrow">Currently selected fictional patient</p>
            <h2 id="demo-selected-title">{patient.name}</h2>
            <p className="muted">{patient.id} · Age {patient.age} · {patient.presentation}</p>
            <details className="demo-source-notes">
              <summary>Inspect the fictional source notes</summary>
              <p className="muted">Note IDs belong to the selected patient only. These two notes deliberately leave five discharge sections undocumented.</p>
              <div className="demo-notes-grid">{patient.notes.map((note) => (
                <article key={note.id}>
                  <h3><span className="demo-note-id">{note.id}</span> {note.title}</h3>
                  <p>{note.text}</p>
                </article>
              ))}</div>
            </details>
          </section>
          <DemoAssistant patient={patient} />
          <DemoDischargeLetter patient={patient} />
        </div>
      </section>
      <footer className="footer-note">MediFlow AI · Public simulation · Changes stay in memory and reset when this page reloads.</footer>
    </main>
  )
}

export default DemoWorkspace
