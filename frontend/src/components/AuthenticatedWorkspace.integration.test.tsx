import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAuthSession } from 'aws-amplify/auth'
import {
  MISSING_TEXT, SECTION_NAMES,
  type DischargeDraft, type DischargeDraftResponse, type EditDraftRequest,
} from '../api/dischargeLetters'
import { PatientDashboard } from './PatientDashboard'

// Exercise the real workspace and all its existing clients. Only Cognito's
// session lookup and the HTTP transport are replaced; AWS is never contacted.
vi.mock('aws-amplify/auth', () => ({ fetchAuthSession: vi.fn() }))

const fetchMock = vi.fn<typeof fetch>()
const patient = {
  patient_id: 'AUTHENTICATED-TEST-PATIENT', first_name: 'Alice', last_name: 'Example', age: 32,
  diagnosis: { diagnosis: 'Synthetic admission' }, admission_date: '2026-11-14', status: 'admitted',
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('VITE_API_URL', 'https://authenticated-workspace.test')
  fetchMock.mockReset()
  vi.mocked(fetchAuthSession).mockReset().mockResolvedValue({
    tokens: { accessToken: { toString: () => 'synthetic-authenticated-access-token' } },
  } as Awaited<ReturnType<typeof fetchAuthSession>>)
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('authenticated workspace after adding the public demo', () => {
  it('retains real patient, assistant, polling, draft-save and review clients with Cognito bearer authorization', async () => {
    const draft = Object.fromEntries(SECTION_NAMES.map((name) => [name, {
      text: name === 'admission_reason' ? 'Fictional admission for observation.' : MISSING_TEXT,
      documented: name === 'admission_reason',
      supporting_note_ids: name === 'admission_reason' ? ['N001'] : [],
    }])) as DischargeDraft
    const job = {
      job_id: 'authenticated-test-job', patient_id: patient.patient_id, status: 'PENDING_REVIEW',
      created_at: '2026-11-14T10:00:00Z', updated_at: '2026-11-14T10:01:00Z',
    }
    let document: DischargeDraftResponse = {
      ...job, status: 'PENDING_REVIEW', document_state: 'UNSIGNED_DRAFT', draft,
      missing_sections: SECTION_NAMES.slice(1), supporting_note_ids: ['N001'], review_note: '',
    }
    const requests: { path: string; method: string; headers: Headers; body: unknown }[] = []
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname
      const method = init?.method ?? 'GET'
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ path, method, headers: new Headers(init?.headers), body })
      if (path === '/patients' && method === 'GET') return json([patient])
      if (path === `/patients/${patient.patient_id}/ask` && method === 'POST') {
        return json({ answer: 'A deterministic authenticated API answer.', supporting_note_ids: ['N001'], insufficient_evidence: false })
      }
      if (path === `/patients/${patient.patient_id}/discharge-letters` && method === 'POST') {
        return json({ ...job, status: 'QUEUED' }, 202)
      }
      if (path === `/discharge-jobs/${job.job_id}` && method === 'GET') return json(job)
      if (path === `/discharge-jobs/${job.job_id}/draft` && method === 'GET') return json(document)
      if (path === `/discharge-jobs/${job.job_id}/draft` && method === 'PUT') {
        document = { ...document, draft: (body as EditDraftRequest).draft, updated_at: '2026-11-14T10:02:00Z' }
        return json(document)
      }
      if (path === `/discharge-jobs/${job.job_id}/review` && method === 'POST') {
        document = { ...document, status: 'APPROVED', document_state: 'REVIEW_APPROVED_UNSIGNED', updated_at: '2026-11-14T10:03:00Z' }
        return json(document)
      }
      throw new Error(`Unexpected authenticated test request: ${method} ${path}`)
    })

    render(<PatientDashboard username="existing-doctor" onSignOut={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: `Select Alice Example (${patient.patient_id})` }))
    expect(screen.getByText('existing-doctor')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Clinical question' }), { target: { value: 'Why was Alice admitted?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }))
    await screen.findByText('A deterministic authenticated API answer.')
    fireEvent.click(screen.getByRole('button', { name: 'Generate Discharge Letter' }))
    // The existing production component polls its existing client after 3s.
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Draft' }, { timeout: 4500 }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Admission reason' }), {
      target: { value: 'Edited fictional admission evidence.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Edited fictional admission evidence.')
    fireEvent.click(screen.getByRole('button', { name: 'Approve Draft' }))
    const confirmation = screen.getByRole('dialog', { name: 'Approve discharge draft?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: 'I acknowledge the missing sections' }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirm approval' }))
    await screen.findByText('Review approved — unsigned. Approval is not an electronic or legal signature.')

    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /patients',
      `POST /patients/${patient.patient_id}/ask`,
      `POST /patients/${patient.patient_id}/discharge-letters`,
      `GET /discharge-jobs/${job.job_id}`,
      `GET /discharge-jobs/${job.job_id}/draft`,
      `PUT /discharge-jobs/${job.job_id}/draft`,
      `POST /discharge-jobs/${job.job_id}/review`,
    ])
    expect(fetchAuthSession).toHaveBeenCalledTimes(requests.length)
    for (const request of requests) {
      expect(request.headers.get('Authorization')).toBe('Bearer synthetic-authenticated-access-token')
    }
    expect(requests[1].body).toEqual({ question: 'Why was Alice admitted?' })
    expect(requests[2].headers.get('Idempotency-Key')).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i)
    expect(requests[5].body).toMatchObject({ expected_updated_at: job.updated_at })
    expect(requests[6].body).toMatchObject({ action: 'APPROVE', expected_updated_at: '2026-11-14T10:02:00Z', acknowledge_missing_sections: true })
  }, 8000)
})
