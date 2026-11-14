import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAuthSession } from 'aws-amplify/auth'
import {
  getDischargeDraft, MISSING_TEXT, SECTION_NAMES,
  type DischargeDraft, type DischargeDraftResponse, type DischargeJob,
  type EditDraftRequest, type ReviewDecisionRequest,
} from '../api/dischargeLetters'
import type { Patient } from '../api/patients'
import { PatientDashboard } from './PatientDashboard'

// Keep the real API clients and components; only authentication and HTTP are
// mocked. No request can reach AWS or make a real clinical review decision.
vi.mock('aws-amplify/auth', () => ({ fetchAuthSession: vi.fn() }))

const alice: Patient = {
  patient_id: 'SYNTHETIC-ALICE', first_name: 'Alice', last_name: 'Example', age: 30,
  diagnosis: { diagnosis: 'Synthetic diagnosis' }, admission_date: '2026-11-14', status: 'admitted',
}
const bob: Patient = { ...alice, patient_id: 'SYNTHETIC-BOB', first_name: 'Bob' }
const fetchMock = vi.fn<typeof fetch>()

function syntheticServer() {
  const jobs = new Map<string, { job: DischargeJob; document: DischargeDraftResponse }>()
  const keys = new Map<string, string>()
  const requests: { method: string; path: string; body: unknown; key: string | null }[] = []
  let clock = 0
  const timestamp = () => new Date(Date.UTC(2026, 10, 14, 10, 0, clock++)).toISOString()
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  fetchMock.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    const key = new Headers(init?.headers).get('Idempotency-Key')
    requests.push({ method, path, body, key })

    if (method === 'GET' && path === '/patients') return json([alice, bob])
    if (method === 'POST' && path === `/patients/${alice.patient_id}/discharge-letters`) {
      if (!key) return json({ detail: 'Idempotency-Key is required' }, 422)
      const existing = keys.get(key)
      if (existing) return json(jobs.get(existing)!.job, 202)
      const jobId = jobs.size === 0 ? 'synthetic-job-approve' : 'synthetic-job-reject'
      const now = timestamp()
      const draft = Object.fromEntries(SECTION_NAMES.map((name) => [name, name === 'admission_reason'
        ? { text: `Synthetic admission evidence for ${jobId}.`, documented: true, supporting_note_ids: ['N001'] }
        : { text: MISSING_TEXT, documented: false, supporting_note_ids: [] },
      ])) as DischargeDraft
      const job: DischargeJob = {
        job_id: jobId, patient_id: alice.patient_id, status: 'PENDING_REVIEW', created_at: now, updated_at: now,
      }
      const document: DischargeDraftResponse = {
        job_id: jobId, patient_id: alice.patient_id, status: 'PENDING_REVIEW', updated_at: now,
        document_state: 'UNSIGNED_DRAFT', draft, missing_sections: SECTION_NAMES.slice(1),
        supporting_note_ids: ['N001'], review_note: '',
      }
      jobs.set(jobId, { job, document })
      keys.set(key, jobId)
      return json(job, 202)
    }

    const route = /^\/discharge-jobs\/([^/]+)(?:\/(draft|review))?$/.exec(path)
    const stored = route ? jobs.get(route[1]) : undefined
    if (!stored || !route) return json({ detail: 'Discharge job not found' }, 404)
    if (method === 'GET') return json(route[2] === 'draft' ? stored.document : stored.job)

    const mutation = body as EditDraftRequest | ReviewDecisionRequest
    if (stored.document.status !== 'PENDING_REVIEW' || mutation.expected_updated_at !== stored.document.updated_at) {
      return json({ detail: 'Job changed. Reload the draft and retry.' }, 409)
    }
    if (method === 'PUT' && route[2] === 'draft') {
      stored.document.draft = structuredClone((mutation as EditDraftRequest).draft)
    } else if (method === 'POST' && route[2] === 'review') {
      const decision = mutation as ReviewDecisionRequest
      if (decision.action === 'APPROVE' && stored.document.missing_sections.length && !decision.acknowledge_missing_sections) {
        return json({ detail: 'Acknowledge missing sections before approval' }, 422)
      }
      if (decision.action === 'REJECT' && !decision.note.trim()) return json({ detail: 'A rejection reason is required' }, 422)
      stored.document.status = decision.action === 'APPROVE' ? 'APPROVED' : 'REJECTED'
      stored.document.document_state = decision.action === 'APPROVE' ? 'REVIEW_APPROVED_UNSIGNED' : 'REJECTED_DRAFT'
      stored.document.review_note = decision.note.trim()
      stored.job.status = stored.document.status
    } else {
      return json({ detail: 'Unsupported synthetic request' }, 405)
    }
    const now = timestamp()
    stored.document.updated_at = now
    stored.job.updated_at = now
    return json(stored.document)
  })
  return { jobs, requests }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('VITE_API_URL', 'https://discharge-checklist.test')
  vi.mocked(fetchAuthSession).mockResolvedValue({
    tokens: { accessToken: { toString: () => 'synthetic-test-token' } },
  } as Awaited<ReturnType<typeof fetchAuthSession>>)
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('discharge checklist with the real HTTP client and synthetic server state', () => {
  it('persists an edit, confirms approval, rejects a distinct job with a reason, and clears Alice when selecting Bob', async () => {
    const server = syntheticServer()
    render(<PatientDashboard username="synthetic-doctor" onSignOut={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: `Select Alice Example (${alice.patient_id})` }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate Discharge Letter' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Draft' }))
    const firstJob = server.jobs.get('synthetic-job-approve')!
    const originalTimestamp = firstJob.document.updated_at
    const editedText = 'Edited synthetic admission reason, retained by the server.'
    fireEvent.change(screen.getByRole('textbox', { name: 'Admission reason' }), { target: { value: editedText } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText(editedText)

    const save = server.requests.find((request) => request.method === 'PUT')!
    expect(save.path).toBe('/discharge-jobs/synthetic-job-approve/draft')
    expect(save.body).toEqual({ expected_updated_at: originalTimestamp, draft: firstJob.document.draft })
    expect(firstJob.document.updated_at).not.toBe(originalTimestamp)
    // A fresh GET through the real client must read the saved server version,
    // independently of the component's local state or the PUT response.
    const persisted = await getDischargeDraft('synthetic-job-approve')
    expect(persisted.draft.admission_reason.text).toBe(editedText)
    expect(persisted.updated_at).toBe(firstJob.document.updated_at)
    expect(server.requests.filter((request) => request.method === 'GET'
      && request.path === '/discharge-jobs/synthetic-job-approve/draft')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Approve Draft' }))
    const approval = screen.getByRole('dialog', { name: 'Approve discharge draft?' })
    expect(approval.textContent).toContain('6 missing sections')
    const confirmApproval = within(approval).getByRole('button', { name: 'Confirm approval' }) as HTMLButtonElement
    expect(confirmApproval.disabled).toBe(true)
    fireEvent.click(confirmApproval)
    expect(server.requests.filter((request) => request.path.endsWith('/review'))).toHaveLength(0)
    fireEvent.click(within(approval).getByRole('checkbox', { name: 'I acknowledge the missing sections' }))
    fireEvent.click(confirmApproval)
    await screen.findByText('Review approved — unsigned. Approval is not an electronic or legal signature.')
    const approveRequest = server.requests.find((request) => request.path.endsWith('/review'))!
    expect(approveRequest.path).toBe('/discharge-jobs/synthetic-job-approve/review')
    expect(approveRequest.body).toMatchObject({
      action: 'APPROVE', expected_updated_at: persisted.updated_at, acknowledge_missing_sections: true,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Generate New Discharge Letter' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reject Draft' }))
    const creationRequests = server.requests.filter((request) => request.path.endsWith('/discharge-letters'))
    expect(creationRequests).toHaveLength(2)
    expect(creationRequests[1].key).not.toBe(creationRequests[0].key)
    expect(server.jobs.size).toBe(2)
    const rejection = screen.getByRole('dialog', { name: 'Reject discharge draft?' })
    const reason = within(rejection).getByRole('textbox', { name: 'Rejection reason' })
    const confirmRejection = within(rejection).getByRole('button', { name: 'Confirm rejection' }) as HTMLButtonElement
    expect(confirmRejection.disabled).toBe(true)
    fireEvent.change(reason, { target: { value: '   ' } })
    fireEvent.click(confirmRejection)
    expect(server.requests.filter((request) => request.path.endsWith('/review'))).toHaveLength(1)
    const rejectionReason = 'Additional synthetic evidence is required.'
    fireEvent.change(reason, { target: { value: rejectionReason } })
    fireEvent.click(confirmRejection)
    await screen.findByText(`Rejection reason: ${rejectionReason}`)
    const reviewRequests = server.requests.filter((request) => request.path.endsWith('/review'))
    expect(reviewRequests).toHaveLength(2)
    expect(reviewRequests[1].path).toBe('/discharge-jobs/synthetic-job-reject/review')
    expect(reviewRequests[1].body).toMatchObject({ action: 'REJECT', note: rejectionReason, acknowledge_missing_sections: false })
    expect(server.jobs.get('synthetic-job-approve')!.document.status).toBe('APPROVED')
    expect(server.jobs.get('synthetic-job-reject')!.document.status).toBe('REJECTED')
    expect(screen.queryByRole('button', { name: 'Edit Draft' })).toBeNull()

    const aliceDraftText = 'Synthetic admission evidence for synthetic-job-reject.'
    expect(screen.getByText(aliceDraftText)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `Select Bob Example (${bob.patient_id})` }))
    // Immediate assertions: no await permits an effect to hide a stale flash.
    expect(screen.queryByText(aliceDraftText)).toBeNull()
    expect(screen.queryByText(`Rejection reason: ${rejectionReason}`)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit Draft' })).toBeNull()
    expect(within(document.getElementById('discharge-letter')!).getByText('Bob Example')).toBeTruthy()
    await waitFor(() => expect(server.requests.filter((request) => request.path.endsWith('/review'))).toHaveLength(2))
  })
})
