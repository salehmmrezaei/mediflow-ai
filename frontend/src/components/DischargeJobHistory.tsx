import { useEffect, useId, useState } from 'react'
import { DischargeLetterError, listDischargeJobs, type DischargeJob, type DischargeStatus } from '../api/dischargeLetters'

export const DISCHARGE_STATUS_LABELS: Record<DischargeStatus, string> = {
  QUEUED: 'Queued', PROCESSING: 'Processing', PENDING_REVIEW: 'Pending review',
  APPROVED: 'Approved', REJECTED: 'Rejected', FAILED: 'Failed',
}

function mergeJobs(current: DischargeJob[], incoming: DischargeJob[]): DischargeJob[] {
  const jobs = new Map(current.map((job) => [job.job_id, job]))
  for (const job of incoming) {
    const previous = jobs.get(job.job_id)
    // A history request can finish after polling or a review updates a row.
    if (!previous || Date.parse(job.updated_at) >= Date.parse(previous.updated_at)) jobs.set(job.job_id, job)
  }
  return [...jobs.values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
    || b.job_id.localeCompare(a.job_id))
}

function JobTime({ value }: { value: string }) {
  const date = new Date(value)
  return <time dateTime={value}>{Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })}</time>
}

type Props = {
  patientId: string
  currentJob: DischargeJob | null
  disabled: boolean
  editing: boolean
  pendingSubmission: boolean
  onOpen: (job: DischargeJob) => void
}

export function DischargeJobHistory({ patientId, currentJob, disabled, editing, pendingSubmission, onOpen }: Props) {
  const id = useId()
  const [jobs, setJobs] = useState<DischargeJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void listDischargeJobs(patientId, controller.signal).then((value) => {
      if (!controller.signal.aborted) setJobs((current) => mergeJobs(current, value))
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof DischargeLetterError
        ? cause.message : 'Unable to load discharge letter jobs. Please try again.')
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [patientId, version])

  useEffect(() => {
    if (currentJob?.patient_id === patientId) setJobs((current) => mergeJobs(current, [currentJob]))
  }, [currentJob, patientId])

  return (
    <div className="discharge-history" aria-labelledby={`${id}-title`}>
      <div className="discharge-history-heading">
        <div className="discharge-history-heading-content">
          <h3 id={`${id}-title`}>
            <button type="button" className="discharge-history-toggle" aria-label="Discharge letter jobs"
              aria-expanded={expanded} aria-controls={`${id}-table`} onClick={() => setExpanded((value) => !value)}>
              <span className="discharge-history-toggle-title">
                <svg className="discharge-history-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Discharge letter jobs
              </span>
              <span className="discharge-history-toggle-hint" aria-hidden="true">{expanded ? 'Hide jobs' : 'Show jobs'}</span>
            </button>
          </h3>
          <p className="muted">Your jobs for this patient, newest first. Open a job to track progress or review its letter.</p>
        </div>
        <button type="button" className="secondary-button" disabled={loading}
          onClick={() => setVersion((value) => value + 1)}>Refresh jobs</button>
      </div>
      {loading && <p className="discharge-history-message muted" role="status">Loading discharge letter jobs…</p>}
      {error && <p className="discharge-error" role="alert">{error}</p>}
      {editing && <p className="discharge-history-message muted">Save or cancel your edits before opening another job.</p>}
      {pendingSubmission && <p className="discharge-history-message muted">Resolve the current generation request before opening another job. If it failed, use Retry generation below.</p>}
      <div id={`${id}-table`} className="table-scroll" hidden={!expanded} tabIndex={0}
        role="region" aria-label="Discharge letter jobs table" aria-busy={loading}>
        <table className="patient-table discharge-jobs-table">
          <caption className="sr-only">Discharge letter jobs</caption>
          <thead><tr><th scope="col">Job ID</th><th scope="col">Status</th><th scope="col">Created</th>
            <th scope="col">Last updated</th><th scope="col">Action</th></tr></thead>
          <tbody>{jobs.map((job) => (
            <tr key={job.job_id} className={currentJob?.job_id === job.job_id ? 'is-selected' : undefined}>
              <th scope="row"><span className="discharge-job-id">{job.job_id}</span></th>
              <td><span className={`discharge-status discharge-status-${job.status.toLowerCase()}`}>{DISCHARGE_STATUS_LABELS[job.status]}</span></td>
              <td><JobTime value={job.created_at} /></td><td><JobTime value={job.updated_at} /></td>
              <td><button type="button" className="secondary-button" aria-label={`Open job ${job.job_id}`}
                aria-pressed={currentJob?.job_id === job.job_id}
                disabled={disabled || editing || pendingSubmission || currentJob?.job_id === job.job_id} onClick={() => onOpen(job)}>
                {currentJob?.job_id === job.job_id ? 'Selected' : 'Open job'}</button></td>
            </tr>
          ))}
          {!jobs.length && <tr><td colSpan={5} className="discharge-history-empty">
            {loading ? 'Retrieving your jobs for this patient…' : error ? 'Job history could not be loaded. Use Refresh jobs to try again.'
              : 'No discharge letter jobs yet for you and this patient. Generate a discharge letter to get started.'}
          </td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
