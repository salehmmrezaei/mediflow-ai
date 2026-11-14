import { useEffect, useRef, useState } from 'react'
import { createDemoDraft, DEMO_SECTIONS, type DemoDraft, type DemoPatient } from './fixtures'

type Phase = 'IDLE' | 'QUEUED' | 'PROCESSING' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED'
type Decision = 'approve' | 'reject'

function ReviewDialog({ decision, onCancel, onConfirm }: {
  decision: Decision
  onCancel: () => void
  onConfirm: (reason: string) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [reason, setReason] = useState('')
  const approve = decision === 'approve'

  useEffect(() => {
    const element = dialogRef.current
    if (!element) return
    // Native dialog keeps keyboard focus within the explicit review step.
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    return () => {
      if (typeof element.close === 'function' && element.open) element.close()
    }
  }, [])

  return (
    <dialog className="demo-review-dialog" ref={dialogRef} aria-labelledby="demo-review-title"
      aria-describedby="demo-review-description" aria-modal="true" onCancel={onCancel}>
      <h3 id="demo-review-title">{approve ? 'Approve sample draft?' : 'Reject sample draft?'}</h3>
      <p id="demo-review-description">{approve
        ? 'This fictional draft has 5 missing sections. Confirming records a simulated review approval only. It remains unsigned and is not an electronic or legal signature.'
        : 'Give a reason for rejecting this fictional draft. Your reason stays in page memory and is cleared on reset or reload.'}</p>
      {approve ? (
        <>
          <ul className="demo-missing-list">{DEMO_SECTIONS.filter(({ id }) => id !== 'admission_reason' && id !== 'investigations')
            .map(({ id, label }) => <li key={id}>{label}</li>)}</ul>
          <label className="demo-acknowledgement">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            I acknowledge the 5 missing sections
          </label>
        </>
      ) : (
        <>
          <label htmlFor="demo-rejection-reason">Rejection reason</label>
          <textarea id="demo-rejection-reason" rows={3} maxLength={1000} required value={reason}
            onChange={(event) => setReason(event.target.value)} />
          <p className="muted">A non-empty reason is required (maximum 1,000 characters).</p>
        </>
      )}
      <div className="demo-actions">
        <button type="button" className="secondary-button" autoFocus onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-button"
          disabled={approve ? !acknowledged : !reason.trim()}
          onClick={() => {
            if (approve ? acknowledged : !!reason.trim()) onConfirm(reason.trim())
          }}>{approve ? 'Confirm unsigned approval' : 'Confirm rejection'}</button>
      </div>
    </dialog>
  )
}

export function DemoDischargeLetter({ patient }: { patient: DemoPatient }) {
  const [phase, setPhase] = useState<Phase>('IDLE')
  const [draft, setDraft] = useState<DemoDraft | null>(null)
  const [editDraft, setEditDraft] = useState<DemoDraft | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [decision, setDecision] = useState<Decision | null>(null)
  const [rejectionReason, setRejectionReason] = useState('')
  const busy = phase === 'QUEUED' || phase === 'PROCESSING'
  const terminal = phase === 'APPROVED' || phase === 'REJECTED'

  // A local clock is the entire simulation. Patient changes/reset unmount this
  // component, cancelling the timer and destroying all of its session state.
  useEffect(() => {
    if (phase !== 'QUEUED' && phase !== 'PROCESSING') return
    const timer = window.setTimeout(() => {
      if (phase === 'QUEUED') setPhase('PROCESSING')
      else {
        setDraft(createDemoDraft(patient))
        setPhase('PENDING_REVIEW')
      }
    }, 800)
    return () => window.clearTimeout(timer)
  }, [phase, patient])

  function generate() {
    if (phase !== 'IDLE' && !terminal) return
    setDraft(null)
    setEditDraft(null)
    setSaved(false)
    setEditError(null)
    setDecision(null)
    setRejectionReason('')
    setPhase('QUEUED')
  }

  function saveChanges() {
    if (!editDraft || phase !== 'PENDING_REVIEW') return
    for (const { id, label } of DEMO_SECTIONS) {
      if (editDraft[id].documented && (!editDraft[id].text.trim() || editDraft[id].text.length > 2000)) {
        setEditError(`${label} must contain between 1 and 2,000 characters.`)
        return
      }
    }
    setDraft(editDraft)
    setEditDraft(null)
    setEditError(null)
    setSaved(true)
  }

  function confirmReview(reason: string) {
    if (phase !== 'PENDING_REVIEW' || !draft || editDraft) return
    if (decision === 'approve') setPhase('APPROVED')
    else if (decision === 'reject' && reason.trim()) {
      setRejectionReason(reason.trim())
      setPhase('REJECTED')
    }
    setDecision(null)
  }

  return (
    <section className="demo-card" id="demo-discharge" aria-labelledby="demo-discharge-title">
      <div className="demo-card-heading">
        <div>
          <p className="eyebrow">02 · Prepare and review</p>
          <h2 id="demo-discharge-title">Sample discharge letter</h2>
          <p className="muted">Follow a simulated generation and review workflow for {patient.name}.</p>
        </div>
        <span className="demo-chip">Always unsigned</span>
      </div>
      <div className="demo-card-body">
        <p className="demo-disclaimer">No real Step Functions execution, DynamoDB write, or OpenAI request occurs in demo mode.</p>
        {(phase === 'IDLE' || terminal) && (
          <button type="button" className="primary-button" onClick={generate}>
            {terminal ? 'Generate new sample discharge letter' : 'Generate sample discharge letter'}
          </button>
        )}
        {phase !== 'IDLE' && (
          <div className="demo-progress" role="status" aria-label="Discharge simulation status" aria-live="polite">
            {busy && <span className="loading-indicator" aria-hidden="true" />}
            <span className={`demo-phase demo-phase-${phase.toLowerCase()}`}>{phase}</span>
            <span>{phase === 'QUEUED' ? 'Sample generation queued locally.'
              : phase === 'PROCESSING' ? 'Preparing the prewritten sample.'
              : phase === 'PENDING_REVIEW' ? 'Ready for your simulated review.'
              : phase === 'APPROVED' ? 'Review approved — unsigned. Approval is not an electronic or legal signature.'
              : 'Draft rejected in this demo session.'}</span>
          </div>
        )}
        {phase === 'IDLE' && <p className="muted demo-help">Generate a sample to see QUEUED → PROCESSING → PENDING_REVIEW, then inspect all seven clinical sections.</p>}

        {draft && (
          <>
            <div className="demo-draft-summary">
              <h3>{patient.name} · Unsigned sample draft</h3>
              <p>2 documented sections · 5 missing sections · Supporting note IDs: N001, N002</p>
              <p className="muted">Only documented sections can be edited. Missing sections and evidence references remain fixed to the supplied fictional notes.</p>
            </div>
            {saved && <p className="demo-save-message" role="status">Changes saved locally in this page only. Reloading resets the draft.</p>}
            {rejectionReason && <p className="demo-rejection">Rejection reason: {rejectionReason}</p>}
            <div className="demo-sections">{DEMO_SECTIONS.map(({ id, label }) => {
              const section = (editDraft ?? draft)[id]
              return (
                <article className="demo-section" key={id} aria-labelledby={`demo-section-${id}`}>
                  <div className="demo-section-heading">
                    <h3 id={`demo-section-${id}`}>{label}</h3>
                    <span className={section.documented ? 'demo-documented' : 'demo-missing'}>{section.documented ? 'Documented' : 'Missing'}</span>
                  </div>
                  {editDraft && section.documented ? (
                    <>
                      <label className="sr-only" htmlFor={`demo-edit-${id}`}>{label}</label>
                      <textarea id={`demo-edit-${id}`} rows={4} maxLength={2000} required value={section.text}
                        onChange={(event) => {
                          const text = event.target.value
                          setEditDraft((current) => current ? { ...current, [id]: { ...current[id], text } } : current)
                          setEditError(null)
                          setSaved(false)
                        }} />
                    </>
                  ) : <p className="demo-clinical-text">{section.text}</p>}
                  <p className="demo-evidence">Supporting note IDs: {section.noteIds.length ? section.noteIds.join(', ') : 'None'}</p>
                </article>
              )
            })}</div>
            {phase === 'PENDING_REVIEW' && (
              <div className="demo-actions">
                {editDraft ? (
                  <>
                    <button className="primary-button" type="button" onClick={saveChanges}>Save changes locally</button>
                    <button className="secondary-button" type="button" onClick={() => { setEditDraft(null); setEditError(null) }}>Cancel editing</button>
                  </>
                ) : (
                  <>
                    <button className="secondary-button" type="button" onClick={() => { setEditDraft(structuredClone(draft)); setSaved(false) }}>Edit documented sections</button>
                    <button className="primary-button" type="button" onClick={() => setDecision('approve')}>Approve draft</button>
                    <button className="secondary-button demo-reject-button" type="button" onClick={() => setDecision('reject')}>Reject draft</button>
                  </>
                )}
              </div>
            )}
            {editError && <p className="error-message" role="alert">{editError}</p>}
          </>
        )}
        <p className="muted demo-session-note">All answers, edits and review decisions stay in memory. Reset demo or reload to start again.</p>
      </div>
      {decision && <ReviewDialog key={decision} decision={decision} onCancel={() => setDecision(null)} onConfirm={confirmReview} />}
    </section>
  )
}
