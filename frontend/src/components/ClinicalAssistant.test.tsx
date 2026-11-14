import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { askPatientQuestion, ClinicalAssistantError, type ClinicalAnswer } from '../api/clinicalAssistant'
import type { Patient } from '../api/patients'
import { ClinicalAssistant } from './ClinicalAssistant'

vi.mock('../api/clinicalAssistant', async () => {
  const original = await vi.importActual<typeof import('../api/clinicalAssistant')>('../api/clinicalAssistant')
  return { ...original, askPatientQuestion: vi.fn() }
})

const askQuestion = vi.mocked(askPatientQuestion)
const alice: Patient = {
  patient_id: 'PATIENT-A', first_name: 'Alice', last_name: 'Example', age: 30,
  diagnosis: { diagnosis: 'Synthetic diagnosis' }, admission_date: '2026-11-14', status: 'admitted',
}
const bob: Patient = { ...alice, patient_id: 'PATIENT-B', first_name: 'Bob' }
const question = 'Why was this patient admitted?'
const answer: ClinicalAnswer = {
  answer: 'Admitted for assessment of fever and cough.',
  supporting_note_ids: ['N001', 'N002'],
  insufficient_evidence: false,
}

function deferredAnswer() {
  let resolve!: (value: ClinicalAnswer) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<ClinicalAnswer>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function enterQuestion(value = question) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Clinical question' }), { target: { value } })
}

function ask() {
  fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }))
}

beforeEach(() => {
  askQuestion.mockReset()
})

describe('ClinicalAssistant', () => {
  it('requires a patient before enabling the question form', () => {
    render(<ClinicalAssistant patient={null} />)

    expect(screen.getByText('Select a patient from the table to ask about their clinical notes.')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Ask AI' }) as HTMLButtonElement).disabled).toBe(true)
    expect(askQuestion).not.toHaveBeenCalled()
  })

  it('shows the selected patient and rejects whitespace or overlong questions even when the form is submitted directly', () => {
    render(<ClinicalAssistant patient={alice} />)
    expect(screen.getByText('Alice Example')).toBeTruthy()
    expect(screen.getByText('PATIENT-A')).toBeTruthy()
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(input.maxLength).toBe(500)
    expect(input.placeholder).toBe("Ask a question about this patient's clinical notes...")

    enterQuestion('   ')
    fireEvent.submit(input.closest('form')!)
    expect((screen.getByRole('button', { name: 'Ask AI' }) as HTMLButtonElement).disabled).toBe(true)
    enterQuestion('x'.repeat(501))
    fireEvent.submit(input.closest('form')!)
    expect(screen.getByText('501 / 500')).toBeTruthy()
    expect(askQuestion).not.toHaveBeenCalled()
  })

  it('submits a trimmed question with the selected patient ID and blocks duplicate submissions while loading', async () => {
    const request = deferredAnswer()
    askQuestion.mockReturnValue(request.promise)
    render(<ClinicalAssistant patient={alice} />)
    enterQuestion(`  ${question}  `)
    ask()

    expect(screen.getByRole('status').textContent).toContain('Reviewing clinical notes')
    expect((screen.getByRole('button', { name: 'Asking AI…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    fireEvent.submit(screen.getByRole('textbox').closest('form')!)
    expect(askQuestion).toHaveBeenCalledTimes(1)
    expect(askQuestion).toHaveBeenCalledWith('PATIENT-A', question, expect.any(AbortSignal))

    await act(async () => { request.resolve(answer) })
    expect(screen.getByRole('heading', { name: 'Answer' })).toBeTruthy()
  })

  it('renders the returned answer, submitted question and supporting note IDs', async () => {
    askQuestion.mockResolvedValue(answer)
    render(<ClinicalAssistant patient={alice} />)
    enterQuestion()
    ask()

    expect(await screen.findByText(answer.answer)).toBeTruthy()
    expect(screen.getByText('Submitted question').parentElement?.textContent).toContain(question)
    expect(screen.getByRole('list', { name: 'Supporting clinical notes' }).textContent).toContain('N001')
    expect(screen.getByText('N002')).toBeTruthy()
    expect(screen.queryByText(/not enough evidence/)).toBeNull()
    enterQuestion('A different question')
    expect(screen.getByText('Submitted question').parentElement?.textContent).toContain(question)
    expect(screen.getByText(answer.answer)).toBeTruthy()
  })

  it('clearly marks insufficient evidence using the backend response', async () => {
    askQuestion.mockResolvedValue({ answer: 'No relevant notes were found.', supporting_note_ids: [], insufficient_evidence: true })
    render(<ClinicalAssistant patient={alice} />)
    enterQuestion()
    ask()

    expect(await screen.findByText('No relevant notes were found.')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('not enough evidence')
    expect(screen.queryByRole('list', { name: 'Supporting clinical notes' })).toBeNull()
  })

  it('retries the failed question, even if the input has since been edited', async () => {
    askQuestion
      .mockRejectedValueOnce(new ClinicalAssistantError('The service is temporarily unavailable. Please try again.', true, 503))
      .mockResolvedValueOnce(answer)
    render(<ClinicalAssistant patient={alice} />)
    enterQuestion()
    ask()

    expect((await screen.findByRole('alert')).textContent).toContain('temporarily unavailable')
    enterQuestion('A different question')
    fireEvent.click(screen.getByRole('button', { name: 'Retry question' }))
    expect(await screen.findByText(answer.answer)).toBeTruthy()
    expect(askQuestion).toHaveBeenNthCalledWith(2, 'PATIENT-A', question, expect.any(AbortSignal))
  })

  it.each([
    [401, 'Your session has expired. Please sign in again.'],
    [404, 'Patient not found or access denied. Select an authorized patient.'],
    [422, 'Enter a valid clinical question.'],
  ])('shows safe non-retryable messages for HTTP %s', async (status, message) => {
    askQuestion.mockRejectedValue(new ClinicalAssistantError(message, false, status))
    render(<ClinicalAssistant patient={alice} />)
    enterQuestion()
    ask()

    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(screen.queryByRole('button', { name: 'Retry question' })).toBeNull()
  })

  it('does not display internal details from unexpected exceptions', async () => {
    askQuestion.mockRejectedValue(new Error('Internal error: Authorization: Bearer private-token'))
    render(<ClinicalAssistant patient={alice} />)
    enterQuestion()
    ask()

    expect((await screen.findByRole('alert')).textContent).toContain('could not be reached')
    expect(screen.queryByText(/private-token/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry question' })).toBeTruthy()
  })

  it('clears the question and result when selecting another patient or clearing selection', async () => {
    askQuestion.mockResolvedValue(answer)
    const { rerender } = render(<ClinicalAssistant patient={alice} />)
    enterQuestion()
    ask()
    await screen.findByText(answer.answer)

    rerender(<ClinicalAssistant patient={bob} />)
    expect(screen.getByText('Bob Example')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByText(answer.answer)).toBeNull()
    expect(screen.queryByText(question)).toBeNull()
    rerender(<ClinicalAssistant patient={null} />)
    expect(screen.queryByText('Bob Example')).toBeNull()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('aborts and ignores a previous patient request even if it resolves after the new request', async () => {
    const oldRequest = deferredAnswer()
    const newRequest = deferredAnswer()
    askQuestion.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise)
    const { rerender } = render(<ClinicalAssistant patient={alice} />)
    enterQuestion()
    ask()
    const oldSignal = askQuestion.mock.calls[0][2]!

    rerender(<ClinicalAssistant patient={bob} />)
    expect(oldSignal.aborted).toBe(true)
    expect(screen.queryByRole('status')).toBeNull()
    enterQuestion('What treatment was recorded?')
    ask()
    await act(async () => { oldRequest.resolve(answer) })
    expect(screen.queryByText(answer.answer)).toBeNull()
    expect((screen.getByRole('button', { name: 'Asking AI…' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { newRequest.resolve({ ...answer, answer: 'New patient answer.' }) })
    expect(screen.getByText('New patient answer.')).toBeTruthy()
    expect(screen.queryByText(answer.answer)).toBeNull()
  })

  it('clears previous errors on patient change and ignores an old rejected request', async () => {
    const oldRequest = deferredAnswer()
    askQuestion.mockReturnValueOnce(oldRequest.promise).mockRejectedValueOnce(new ClinicalAssistantError('Service unavailable.', true, 503))
    const { rerender } = render(<ClinicalAssistant patient={alice} />)
    enterQuestion()
    ask()
    rerender(<ClinicalAssistant patient={bob} />)
    await act(async () => { oldRequest.reject(new Error('Old patient failure')) })
    expect(screen.queryByRole('alert')).toBeNull()
    enterQuestion()
    ask()
    await screen.findByRole('alert')
    rerender(<ClinicalAssistant patient={alice} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
  })

  it('aborts an in-flight request when the assistant unmounts', async () => {
    const request = deferredAnswer()
    askQuestion.mockReturnValue(request.promise)
    const { unmount } = render(<ClinicalAssistant patient={alice} />)
    enterQuestion()
    ask()
    const signal = askQuestion.mock.calls[0][2]!
    unmount()

    expect(signal.aborted).toBe(true)
    await act(async () => { request.resolve(answer) })
  })

  it('renders model output and note IDs as text instead of executable HTML', async () => {
    const html = '<img src="x" onerror="alert(1)">'
    askQuestion.mockResolvedValue({ answer: html, supporting_note_ids: ['<script>bad()</script>'], insufficient_evidence: false })
    const { container } = render(<ClinicalAssistant patient={alice} />)
    enterQuestion()
    ask()

    expect(await screen.findByText(html)).toBeTruthy()
    expect(screen.getByText('<script>bad()</script>')).toBeTruthy()
    expect(container.querySelector('img, script')).toBeNull()
    await waitFor(() => expect((screen.getByRole('button', { name: 'Ask AI' }) as HTMLButtonElement).disabled).toBe(false))
  })
})
