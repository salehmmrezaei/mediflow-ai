import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  createDischargeJob, createIdempotencyKey, DischargeLetterError, getDischargeDraft,
  getDischargeJob, MAX_REVIEW_NOTE_LENGTH, MAX_SECTION_LENGTH, reviewDischargeDraft,
  saveDischargeDraft, SECTION_LABELS, SECTION_NAMES, validateDischargeDraft,
  type DischargeDraft, type DischargeDraftResponse, type DischargeJob, type DischargeStatus,
} from '../api/dischargeLetters'
import type { Patient } from '../api/patients'
import './DischargeLetter.css'

type Props = { patient: Patient | null }
type Operation = 'create' | 'status' | 'draft' | 'save' | 'review'
type PanelError = { message: string; status?: number; retryable: boolean; operation: Operation }
type Confirmation = 'APPROVE' | 'REJECT' | 'reload' | null
const statusLabels: Record<DischargeStatus, string> = {
  QUEUED: 'Queued', PROCESSING: 'Processing', PENDING_REVIEW: 'Pending review',
  APPROVED: 'Approved', REJECTED: 'Rejected', FAILED: 'Failed',
}
const isProcessing = (status?: DischargeStatus) => status === 'QUEUED' || status === 'PROCESSING'

// Keyed state is replaced during render, before effects, just as in the assistant.
export function DischargeLetter({ patient }: Props) {
  return <PatientDischargeLetter key={patient ? `patient:${patient.patient_id}` : 'no-patient'} patient={patient} />
}

function ConfirmationDialog({ title, children, busy, onClose }: {
  title: string; children: ReactNode; busy: boolean; onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current!
    const previousFocus = document.activeElement
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])
  return (
    <dialog ref={ref} className="discharge-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
      <h3 id={titleId}>{title}</h3>
      {children}
      <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
    </dialog>
  )
}

function PatientDischargeLetter({ patient }: Props) {
  const id = useId()
  const [job, setJob] = useState<DischargeJob | null>(null)
  const [document, setDocument] = useState<DischargeDraftResponse | null>(null)
  const [editor, setEditor] = useState<DischargeDraft | null>(null)
  const [busy, setBusy] = useState<Operation | null>(null)
  const [loadingDraft, setLoadingDraft] = useState(false)
  const [error, setError] = useState<PanelError | null>(null)
  const [success, setSuccess] = useState('')
  const [monitorVersion, setMonitorVersion] = useState(0)
  const [confirmation, setConfirmation] = useState<Confirmation>(null)
  const [reviewNote, setReviewNote] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [hasSubmissionKey, setHasSubmissionKey] = useState(false)
  const submissionKey = useRef<string | null>(null)
  const inFlight = useRef<AbortController | null>(null)
  const monitor = useRef<AbortController | null>(null)
  const active = isProcessing(job?.status)
  const pending = document?.status === 'PENDING_REVIEW' && job?.status === 'PENDING_REVIEW'
  const missingCount = document?.missing_sections.length ?? 0
  const editError = editor ? validateDischargeDraft(editor) : null
  const noteLength = Array.from(reviewNote).length
  const locked = Boolean(busy || loadingDraft)

  useEffect(() => () => {
    inFlight.current?.abort()
    monitor.current?.abort()
  }, [])

  function ensureIdentity(value: { patient_id: string; job_id: string }, expectedJob?: string) {
    if (!patient || value.patient_id !== patient.patient_id || (expectedJob && value.job_id !== expectedJob)) {
      throw new DischargeLetterError('This discharge job is unavailable for the selected patient.', false, 404)
    }
  }

  function showError(cause: unknown, operation: Operation) {
    setError(cause instanceof DischargeLetterError
      ? { message: cause.message, status: cause.status, retryable: cause.retryable, operation }
      : { message: 'Unable to reach the discharge service. Please try again.', retryable: true, operation })
  }

  function applyDocument(value: DischargeDraftResponse) {
    setDocument(value)
    setEditor(null)
    setJob((current) => current && current.job_id === value.job_id
      ? { ...current, status: value.status, updated_at: value.updated_at } : current)
  }

  // One request at a time, with a synchronous lock even before React renders.
  async function perform(operation: Operation, action: (signal: AbortSignal) => Promise<void>) {
    if (inFlight.current) return
    const controller = new AbortController()
    inFlight.current = controller
    setBusy(operation)
    setError(null)
    setSuccess('')
    try {
      await action(controller.signal)
    } catch (cause) {
      if (!controller.signal.aborted) showError(cause, operation)
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null
        if (!controller.signal.aborted) setBusy(null)
      }
    }
  }

  const jobId = job?.job_id
  const jobStatus = job?.status
  const patientId = patient?.patient_id
  useEffect(() => {
    if (!jobId || !jobStatus || !patientId || jobStatus === 'FAILED') return
    if (!isProcessing(jobStatus) && document?.job_id === jobId
      && document.status === jobStatus && document.updated_at === job?.updated_at) return
    const controller = new AbortController()
    monitor.current = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    const checkIdentity = (value: { patient_id: string; job_id: string }) => {
      if (value.patient_id !== patientId || value.job_id !== jobId) {
        throw new DischargeLetterError('This discharge job is unavailable for the selected patient.', false, 404)
      }
    }
    async function poll() {
      try {
        const value = await getDischargeJob(jobId!, controller.signal)
        if (controller.signal.aborted) return
        checkIdentity(value)
        setJob(value)
        // A status change restarts this effect; unchanged statuses use this timer.
        if (isProcessing(value.status) && value.status === jobStatus) timer = setTimeout(() => { void poll() }, 3000)
      } catch (cause) {
        if (!controller.signal.aborted) showError(cause, 'status')
      }
    }
    async function loadDraft() {
      setLoadingDraft(true)
      try {
        const value = await getDischargeDraft(jobId!, controller.signal)
        if (controller.signal.aborted) return
        checkIdentity(value)
        applyDocument(value)
      } catch (cause) {
        if (!controller.signal.aborted) showError(cause, 'draft')
      } finally {
        if (!controller.signal.aborted) setLoadingDraft(false)
      }
    }
    if (isProcessing(jobStatus)) timer = setTimeout(() => { void poll() }, 3000)
    else void loadDraft()
    return () => {
      clearTimeout(timer)
      controller.abort()
      if (monitor.current === controller) monitor.current = null
    }
  }, [jobId, jobStatus, patientId, monitorVersion, document?.job_id, document?.status, document?.updated_at, job?.updated_at])

  function generate(retry = false) {
    if (!patient || inFlight.current || active || pending) return
    if (!retry && submissionKey.current) return
    void perform('create', async (signal) => {
      submissionKey.current ??= createIdempotencyKey()
      setHasSubmissionKey(true)
      let value: DischargeJob
      try {
        value = await createDischargeJob(patient.patient_id, submissionKey.current, signal)
      } catch (cause) {
        // Only a definitive first-attempt rejection proves no job was created.
        // Once a submission is uncertain, every retry retains the original key.
        if (!retry && cause instanceof DischargeLetterError && [403, 404, 422].includes(cause.status ?? 0)) {
          submissionKey.current = null
          if (!signal.aborted) setHasSubmissionKey(false)
        }
        throw cause
      }
      if (signal.aborted) return
      ensureIdentity(value)
      submissionKey.current = null
      setHasSubmissionKey(false)
      setDocument(null)
      setEditor(null)
      setJob(value)
    })
  }

  function save() {
    if (!document || !editor || !pending || validateDischargeDraft(editor)) return
    void perform('save', async (signal) => {
      const value = await saveDischargeDraft(document.job_id, {
        expected_updated_at: document.updated_at, draft: editor,
      }, signal)
      if (signal.aborted) return
      ensureIdentity(value, document.job_id)
      applyDocument(value)
      setSuccess('Draft saved. The latest version is ready for review.')
    })
  }

  function reloadLatest() {
    if (!job) return
    setConfirmation(null)
    // Invalidate any old monitor before replacing data with an explicit reload.
    monitor.current?.abort()
    void perform('draft', async (signal) => {
      const value = await getDischargeJob(job.job_id, signal)
      if (signal.aborted) return
      ensureIdentity(value, job.job_id)
      if (!isProcessing(value.status) && value.status !== 'FAILED') {
        const latest = await getDischargeDraft(job.job_id, signal)
        if (signal.aborted) return
        ensureIdentity(latest, job.job_id)
        setJob({ ...value, status: latest.status, updated_at: latest.updated_at })
        setDocument(latest)
        setEditor(null)
      } else {
        setJob(value)
        setDocument(null)
        setEditor(null)
      }
      setMonitorVersion((version) => version + 1)
      setSuccess('Latest discharge data loaded.')
    })
  }

  function submitReview(action: 'APPROVE' | 'REJECT') {
    if (!document || !pending || editor || confirmation !== action || noteLength > MAX_REVIEW_NOTE_LENGTH
      || (action === 'REJECT' && !reviewNote.trim()) || (action === 'APPROVE' && missingCount > 0 && !acknowledged)) return
    void perform('review', async (signal) => {
      const value = await reviewDischargeDraft(document.job_id, {
        action, expected_updated_at: document.updated_at, note: reviewNote.trim(),
        acknowledge_missing_sections: action === 'APPROVE' && missingCount > 0 && acknowledged,
      }, signal)
      if (signal.aborted) return
      ensureIdentity(value, document.job_id)
      applyDocument(value)
      setConfirmation(null)
      setSuccess(action === 'APPROVE' ? 'Draft approved for review. Not signed.' : 'Draft rejected.')
    })
  }

  function openReview(action: 'APPROVE' | 'REJECT') {
    setError(null)
    setReviewNote('')
    setAcknowledged(false)
    setConfirmation(action)
  }

  const reloadControl = job && (
    <button type="button" className="secondary-button" disabled={locked}
      onClick={() => editor ? setConfirmation('reload') : reloadLatest()}>Reload latest draft</button>
  )

  const errorMessage = error && confirmation !== 'APPROVE' && confirmation !== 'REJECT' && (
    <div className="discharge-error" role="alert">
      <p>{error.message}</p>
      {error.status === 401 && <p>Use Sign out above, then Sign in with your existing doctor account.</p>}
      {error.status === 409 && <p>The draft or job changed. Reload the latest data before continuing; your unsaved edits are still here.</p>}
      {(error.status === 409 || ['save', 'review'].includes(error.operation)) && reloadControl}
      {error.operation === 'create' && (error.retryable || error.status === 409) && (
        <button className="secondary-button" type="button" disabled={locked} onClick={() => generate(true)}>Retry generation</button>
      )}
      {error.operation === 'create' && error.retryable && <p>Retry uses the same request key to avoid a duplicate job. A previous submission may already have been accepted.</p>}
      {['status', 'draft'].includes(error.operation) && error.retryable && (
        <button className="secondary-button" type="button" disabled={locked} onClick={() => {
          setError(null); setMonitorVersion((version) => version + 1)
        }}>{error.operation === 'status' ? 'Retry status check' : 'Retry loading draft'}</button>
      )}
    </div>
  )

  return (
    <section id="discharge-letter" className="discharge-letter" aria-labelledby={`${id}-title`}>
      <div className="discharge-header">
        <div><p className="eyebrow">Discharge planning</p><h2 id={`${id}-title`}>Discharge Letter</h2>
          <p className="muted">Generate an evidence-linked draft from the selected patient’s clinical notes.</p></div>
        <span className="discharge-mark" aria-hidden="true">DL</span>
      </div>
      <div className="discharge-body">
        {patient ? (
          <div className="discharge-context"><span className="clinical-assistant-label">Selected patient</span>
            <strong>{patient.first_name} {patient.last_name}</strong><span className="patient-id">{patient.patient_id}</span></div>
        ) : <p className="muted">Select a patient to generate a discharge letter.</p>}
        <p className="discharge-disclaimer">AI-generated draft — Requires doctor review — Not signed</p>
        {(!job || ['FAILED', 'APPROVED', 'REJECTED'].includes(job.status)) && (
          <button type="button" className="primary-button" onClick={() => generate()}
            disabled={!patient || locked || hasSubmissionKey}>
            {busy === 'create' ? 'Generating…' : job ? 'Generate New Discharge Letter' : 'Generate Discharge Letter'}
          </button>
        )}
        {job && <div className="discharge-progress" role="status">
          <span className={`discharge-status discharge-status-${job.status.toLowerCase()}`}>{statusLabels[job.status]}</span>
          {active && <><span className="loading-indicator" aria-hidden="true" />
            <span>{error?.operation === 'status' ? 'Monitoring paused. Retry to check progress.' : 'Preparing the draft. Checking progress every three seconds…'}</span></>}
          {loadingDraft && <span>Loading discharge draft…</span>}
        </div>}
        {job?.status === 'FAILED' && <p className="error-message" role="alert">Discharge generation failed. No draft is available for review. You can start a new generation.</p>}
        {(!editor || error?.operation !== 'save') && errorMessage}
        {document && <>
          <div className="discharge-summary">
            <h3>Clinical sections</h3><p>{7 - missingCount} documented · {missingCount} missing</p>
            {missingCount > 0 && <p className="discharge-warning">Missing information: {document.missing_sections.map((name) => SECTION_LABELS[name]).join(', ')}.</p>}
            <p className="muted">Supporting note IDs identify sources for review; they do not establish clinical accuracy.</p>
            {document.status === 'APPROVED' && <p>Review approved — unsigned. Approval is not an electronic or legal signature.</p>}
            {document.status === 'REJECTED' && <p>Rejected draft — read-only.</p>}
            {document.review_note && <p className="discharge-review-note">{document.status === 'REJECTED' ? 'Rejection reason' : 'Review note'}: {document.review_note}</p>}
          </div>
          <div className="discharge-sections">
            {SECTION_NAMES.map((name) => {
              const section = (editor ?? document.draft)[name]
              return <article className="discharge-section" key={name} aria-labelledby={`${id}-${name}-title`}>
                <div className="discharge-section-heading"><h4 id={`${id}-${name}-title`}>{SECTION_LABELS[name]}</h4>
                  <span className={section.documented ? 'discharge-documented' : 'discharge-warning'}>{section.documented ? 'Documented' : 'Missing information'}</span></div>
                {editor && section.documented ? <>
                  <label className="sr-only" htmlFor={`${id}-${name}`}>{SECTION_LABELS[name]}</label>
                  <textarea id={`${id}-${name}`} value={section.text} disabled={locked} rows={4}
                    aria-describedby={`${id}-${name}-help`} aria-invalid={Array.from(section.text).length > MAX_SECTION_LENGTH || !section.text.trim()}
                    onChange={(event) => {
                      const text = event.target.value
                      setEditor((current) => current && ({ ...current, [name]: { ...current[name], text } }))
                    }} />
                  <p id={`${id}-${name}-help`} className="muted">{Array.from(section.text).length} / {MAX_SECTION_LENGTH} characters. Preserve facts supported by the cited notes.</p>
                </> : <p className="discharge-clinical-text">{section.text}</p>}
                {!section.documented && <p className="discharge-warning">Not documented. No supporting evidence supplied; this section remains unchanged.</p>}
                <p className="discharge-evidence">Supporting note IDs: {section.supporting_note_ids.length ? section.supporting_note_ids.join(', ') : 'None'}</p>
              </article>
            })}
          </div>
          {pending && <div className="discharge-actions" aria-busy={busy === 'save'}>
            {editor ? <>
              <p className="muted">Unsaved edits. Save before approving or rejecting. Documented status and evidence references are preserved.</p>
              {editError && <p className="error-message" role="alert">{editError}</p>}
              {error?.operation === 'save' && errorMessage}
              {busy === 'save' && <p className="muted" role="status">Saving draft changes…</p>}
              <button className="primary-button" type="button" disabled={locked || Boolean(editError) || error?.status === 409} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>
              <button className="secondary-button" type="button" disabled={locked} onClick={() => { setEditor(null); setError(null) }}>Cancel edits</button>
            </> : <>
              <button className="secondary-button" type="button" disabled={locked} onClick={() => { setEditor(structuredClone(document.draft)); setSuccess('') }}>Edit Draft</button>
              <button className="primary-button" type="button" disabled={locked || error?.status === 409} onClick={() => openReview('APPROVE')}>Approve Draft</button>
              <button className="discharge-reject secondary-button" type="button" disabled={locked || error?.status === 409} onClick={() => openReview('REJECT')}>Reject Draft</button>
            </>}
          </div>}
        </>}
        {success && <p className="discharge-success" role="status">{success}</p>}
        <p className="discharge-session-note muted">Active tracking lasts while this patient stays selected. Switching patients, signing out, or reloading clears it. Background jobs may continue; job history is not available yet.</p>
      </div>
      {confirmation === 'reload' && <ConfirmationDialog title="Reload latest draft?" busy={locked} onClose={() => setConfirmation(null)}>
        <p>Reloading will discard your unsaved edits and retrieve the latest server version.</p>
        <button className="primary-button" type="button" disabled={locked} onClick={reloadLatest}>Discard edits and reload</button>
      </ConfirmationDialog>}
      {(confirmation === 'APPROVE' || confirmation === 'REJECT') && <ConfirmationDialog
        title={confirmation === 'APPROVE' ? 'Approve discharge draft?' : 'Reject discharge draft?'} busy={locked} onClose={() => setConfirmation(null)}>
        <form onSubmit={(event) => { event.preventDefault(); submitReview(confirmation) }}>
          <p>{patient?.first_name} {patient?.last_name} · {patient?.patient_id}</p>
          <p>{missingCount} missing sections. Approval is a review decision, not an electronic or legal signature. The document remains unsigned.</p>
          {confirmation === 'APPROVE' && missingCount > 0 && <label className="discharge-acknowledgement">
            <input type="checkbox" checked={acknowledged} disabled={locked} onChange={(event) => setAcknowledged(event.target.checked)} />
            I acknowledge the missing sections
          </label>}
          <label htmlFor={`${id}-review-note`}>{confirmation === 'REJECT' ? 'Rejection reason' : 'Review note (optional)'}</label>
          <textarea id={`${id}-review-note`} value={reviewNote} required={confirmation === 'REJECT'} disabled={locked} rows={3}
            aria-describedby={`${id}-review-help`} onChange={(event) => setReviewNote(event.target.value)} />
          <p id={`${id}-review-help`} className={noteLength > MAX_REVIEW_NOTE_LENGTH ? 'discharge-warning' : 'muted'}>{noteLength} / {MAX_REVIEW_NOTE_LENGTH} characters</p>
          {error?.operation === 'review' && <div className="discharge-error" role="alert">
            <p>{error.message}</p>
            {error.status === 401 && <p>Cancel this dialog, then use Sign out and Sign in with your doctor account.</p>}
            {error.status === 409 && <p>The draft changed. Reload the latest version before submitting a review.</p>}
            {reloadControl}
          </div>}
          <button className="primary-button" type="submit" disabled={locked || error?.status === 409 || noteLength > MAX_REVIEW_NOTE_LENGTH
            || (confirmation === 'REJECT' ? !reviewNote.trim() : missingCount > 0 && !acknowledged)}>
            {busy === 'review' ? 'Submitting review…' : confirmation === 'APPROVE' ? 'Confirm approval' : 'Confirm rejection'}
          </button>
        </form>
      </ConfirmationDialog>}
    </section>
  )
}
