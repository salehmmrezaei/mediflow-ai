import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import {
  askPatientQuestion,
  ClinicalAssistantError,
  MAX_QUESTION_LENGTH,
  type ClinicalAnswer,
} from '../api/clinicalAssistant'
import type { Patient } from '../api/patients'
import './ClinicalAssistant.css'

type ClinicalAssistantProps = {
  patient: Patient | null
}

type QuestionState =
  | { status: 'idle' }
  | { status: 'loading'; question: string }
  | { status: 'success'; question: string; result: ClinicalAnswer }
  | { status: 'error'; question: string; message: string; retryable: boolean }

export function ClinicalAssistant({ patient }: ClinicalAssistantProps) {
  // A new patient gets fresh state synchronously, before effects run. This also
  // prevents a previous patient's question or answer flashing during a switch.
  return <PatientClinicalAssistant key={patient ? `patient:${patient.patient_id}` : 'no-patient'} patient={patient} />
}

function PatientClinicalAssistant({ patient }: ClinicalAssistantProps) {
  const id = useId()
  const [question, setQuestion] = useState('')
  const [state, setState] = useState<QuestionState>({ status: 'idle' })
  const inFlight = useRef<AbortController | null>(null)
  const isLoading = state.status === 'loading'
  const characterCount = Array.from(question).length
  const canSubmit = Boolean(patient && question.trim() && characterCount <= MAX_QUESTION_LENGTH && !isLoading)

  useEffect(() => () => {
    inFlight.current?.abort()
    inFlight.current = null
  }, [])

  async function submitQuestion(value: string) {
    const trimmedQuestion = value.trim()
    if (!patient || inFlight.current || !trimmedQuestion || Array.from(value).length > MAX_QUESTION_LENGTH) return

    const controller = new AbortController()
    inFlight.current = controller
    setState({ status: 'loading', question: trimmedQuestion })

    try {
      const result = await askPatientQuestion(patient.patient_id, trimmedQuestion, controller.signal)
      if (controller.signal.aborted || inFlight.current !== controller) return
      setState({ status: 'success', question: trimmedQuestion, result })
    } catch (error: unknown) {
      if (controller.signal.aborted || inFlight.current !== controller) return
      setState({
        status: 'error',
        question: trimmedQuestion,
        message: error instanceof ClinicalAssistantError
          ? error.message
          : 'The clinical assistant could not be reached. Please try again.',
        retryable: error instanceof ClinicalAssistantError ? error.retryable : true,
      })
    } finally {
      if (inFlight.current === controller) inFlight.current = null
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void submitQuestion(question)
  }

  return (
    <section id="clinical-assistant" className="clinical-assistant" aria-labelledby={`${id}-title`}>
      <div className="clinical-assistant-header">
        <div>
          <p className="eyebrow">Clinical notes</p>
          <h2 id={`${id}-title`}>AI Clinical Assistant</h2>
          <p className="muted">Ask questions grounded in your selected patient’s clinical notes.</p>
        </div>
        <span className="clinical-assistant-mark" aria-hidden="true">AI</span>
      </div>

      <div className="clinical-assistant-body">
        <div className="clinical-assistant-context">
          {patient ? (
            <>
              <span className="clinical-assistant-label">Answering about</span>
              <p className="clinical-assistant-patient">{patient.first_name} {patient.last_name}</p>
              <span className="clinical-assistant-patient-id">{patient.patient_id}</span>
            </>
          ) : (
            <p className="muted">Select a patient from the table to ask about their clinical notes.</p>
          )}
        </div>

        <form onSubmit={handleSubmit} aria-busy={isLoading}>
          <label className="clinical-assistant-input-label" htmlFor={`${id}-question`}>Clinical question</label>
          <textarea
            id={`${id}-question`}
            name="question"
            placeholder="Ask a question about this patient's clinical notes..."
            rows={3}
            maxLength={MAX_QUESTION_LENGTH}
            value={question}
            disabled={!patient || isLoading}
            aria-describedby={`${id}-question-help ${id}-question-count`}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <div className="clinical-assistant-input-help">
            <p id={`${id}-question-help`}>Answers use the selected patient’s clinical notes.</p>
            <span id={`${id}-question-count`}>{characterCount} / {MAX_QUESTION_LENGTH}</span>
          </div>
          <button className="primary-button" type="submit" disabled={!canSubmit}>
            {isLoading ? 'Asking AI…' : 'Ask AI'}
          </button>
        </form>

        {state.status === 'loading' && (
          <p className="clinical-assistant-loading" role="status">
            <span className="loading-indicator" aria-hidden="true" />
            Reviewing clinical notes…
          </p>
        )}

        {(state.status === 'success' || state.status === 'error') && (
          <div className="clinical-assistant-submitted">
            <span className="clinical-assistant-label">Submitted question</span>
            <p>{state.question}</p>
          </div>
        )}

        {state.status === 'success' && (
          <article className="clinical-assistant-answer" aria-labelledby={`${id}-answer-title`} aria-live="polite">
            <h3 id={`${id}-answer-title`}>Answer</h3>
            {state.result.insufficient_evidence && (
              <p className="clinical-assistant-evidence" role="status">
                There is not enough evidence in this patient’s clinical notes to answer this question.
              </p>
            )}
            <p className="clinical-assistant-answer-text">{state.result.answer}</p>
            {state.result.supporting_note_ids.length > 0 && (
              <div className="clinical-assistant-notes">
                <h4>Supporting clinical notes</h4>
                <ul aria-label="Supporting clinical notes">
                  {state.result.supporting_note_ids.map((noteId, index) => (
                    <li key={`${noteId}-${index}`}>{noteId}</li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        )}

        {state.status === 'error' && (
          <div className="clinical-assistant-error" role="alert">
            <h3>Unable to get an answer</h3>
            <p>{state.message}</p>
            {state.retryable && (
              <button className="secondary-button" type="button" onClick={() => { void submitQuestion(state.question) }}>
                Retry question
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
