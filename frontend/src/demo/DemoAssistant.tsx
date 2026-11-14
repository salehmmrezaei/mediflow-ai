import { useState } from 'react'
import { DEMO_QUESTIONS, type DemoPatient, type DemoQuestionId } from './fixtures'

export function DemoAssistant({ patient }: { patient: DemoPatient }) {
  const [questionId, setQuestionId] = useState<DemoQuestionId | null>(null)
  const answer = questionId ? patient.answers[questionId] : null

  return (
    <section className="demo-card" id="demo-assistant" aria-labelledby="demo-assistant-title">
      <div className="demo-card-heading">
        <div>
          <p className="eyebrow">01 · Explore the evidence</p>
          <h2 id="demo-assistant-title">Simulated clinical assistant</h2>
          <p className="muted">Choose a question about {patient.name}. Each answer is a prewritten simulated example, not a live OpenAI generation.</p>
        </div>
        <span className="demo-chip">Local simulation</span>
      </div>
      <div className="demo-card-body">
        <div className="demo-question-list" aria-label="Example questions">
          {DEMO_QUESTIONS.map((question) => (
            <button key={question.id} type="button" className="secondary-button"
              aria-pressed={questionId === question.id} onClick={() => setQuestionId(question.id)}>
              {question.label}
            </button>
          ))}
        </div>
        {answer ? (
          <section className="demo-answer" aria-label="Simulated answer" aria-live="polite">
            <p className="eyebrow">Simulated example answer</p>
            {answer.insufficient && <p className="demo-missing">Insufficient evidence in the supplied notes</p>}
            <p>{answer.text}</p>
            <p className="demo-evidence">Supporting note IDs: {answer.noteIds.length ? answer.noteIds.join(', ') : 'None — no supporting evidence for a medication plan.'}</p>
          </section>
        ) : <p className="muted demo-help">Select an example to see an answer and its evidence references. Questions stay in this page.</p>}
      </div>
    </section>
  )
}
