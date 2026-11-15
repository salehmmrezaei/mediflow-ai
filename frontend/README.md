# MediFlow AI frontend

React and TypeScript frontend with two separate entry paths: a public, browser-only interactive demo at `/demo`, and the authenticated Doctor Workspace at `/`. AWS Amplify's client library connects the Doctor Workspace to the existing Cognito User Pool. Its Clinical Assistant and discharge-letter workflow use the existing protected patient API and configured `VITE_API_URL`.

## Public interactive demo

Start the frontend without adding or changing environment variables:

```sh
cd frontend
npm ci
npm run dev
```

Open **http://localhost:5173/demo** directly, including in a private window with no Cognito session. The `/demo` entry does not load Amplify authentication, restore a doctor session, or import the production API clients. No AWS or OpenAI request is made by demo interactions, and there is no fallback to authenticated APIs.

The demo displays **PUBLIC DEMO — SIMULATED DATA — NOT FOR CLINICAL USE** throughout. Select fictional Alice Example or Bob Example to inspect their invented notes. Selectable example questions cover admission symptoms, investigations, and insufficient evidence; answers are deterministic, prewritten simulations with supporting note IDs, not live AI output. No unrestricted question entry is provided.

Choose **Generate sample discharge letter** to observe the local `QUEUED → PROCESSING → PENDING_REVIEW` progression. The initial letter has seven sections: Admission reason and Investigations are documented with N001/N002 references; Hospital course, Discharge diagnosis, Discharge medications, Discharge date, and Follow-up remain missing. Edit documented sections and save locally before review. Approval requires explicit confirmation and acknowledgement of the five missing sections and remains unsigned. Rejection requires a nonempty reason. No real Step Functions execution, DynamoDB write, or OpenAI request occurs.

All demo state is held in React memory. **Reset demo**, switching patients, reloading, or leaving the page clears the simulated workflow. Questions and drafts are never saved to localStorage, sessionStorage, external analytics, or remote logging. **Return to Home** opens `/`; **Doctor Sign In** leaves demo mode for `/?signin=1`, where the existing Cognito hosted-login action runs. Demo mode never creates credentials or tokens.

To verify locally, select both patients and all example questions, generate and edit a letter, try approval before and after acknowledging missing sections, and generate a fresh sample to try rejection with an empty reason and then a supplied reason. Refresh `/demo` and confirm the initial state returns. Inspect the browser Network and Application panels to confirm no API/AI requests or stored demo drafts/questions. The existing authenticated application requires its normal configuration as described below.

### Direct access on Vercel

The existing `vercel.json` rewrite sends all frontend paths to `/index.html`, including `/demo` and `/demo/`. Preserve it and the existing Vercel environment variables and Cognito settings. After an explicit deployment through the existing Vercel project, open the deployment's `/demo` URL directly in a private browser window and refresh it. For production, that URL will be **https://mediflow.salehmmrezaei.com/demo** after this branch is deployed; a preview uses its own hostname plus `/demo`. No deployment or infrastructure change is part of this implementation.

## Existing AWS configuration

The Doctor Workspace calls the remote API configured by `VITE_API_URL`. The discharge job history table requires the updated Patient API Lambda and the new `GET /patients/{patient_id}/discharge-letters` API Gateway route. Rebuild and deploy the SAM stack with the commands below before testing history against an older backend; starting Vite or rebuilding the frontend does not publish backend changes. Skip deployment when those changes are already deployed.

Draft editing requires API Gateway CORS to permit `PUT` as well as `GET`, `POST`, and `OPTIONS`, and the `Authorization`, `Content-Type`, and `Idempotency-Key` headers for `http://localhost:5173`.

A read-only preflight check on 14 November 2026 identified that the deployed API omitted `PUT`. The API's CORS configuration was then updated to allow `GET, POST, OPTIONS, PUT`, preserving its existing origin and headers; `infrastructure/template.yaml` contains the matching fix. No live discharge job or review request was made during implementation.

The SAM template adds Cognito's classic hosted login, authorization code flow, `openid`, and CORS for `http://localhost:5173`. It preserves the existing password authentication flows and API JWT authorizer.

From the project root:

```sh
cd infrastructure
sam validate --lint
sam build
sam deploy \
  --profile mediflow-dev \
  --region eu-south-1 \
  --parameter-overrides CognitoDomainPrefix=mediflow-saleh-dev-2026
```

This development stack uses `mediflow-saleh-dev-2026`. Reuse that prefix for subsequent deployments of this stack. A separate stack needs its own unique prefix. The repository's SAM configuration requests confirmation of the proposed change set before applying it.

Use the stack outputs `UserPoolId`, `UserPoolClientId`, `CognitoDomain`, and `PatientApiUrl` for the frontend configuration. The hosted login domain has this form:

```text
https://mediflow-saleh-dev-2026.auth.eu-south-1.amazoncognito.com
```

## Configure and run locally

From the project root:

```sh
cd frontend
npm ci
cp -n .env.example .env.local
```

If `.env.local` already contains this stack's configuration, keep it instead of overwriting it. Otherwise replace the four placeholders:

```dotenv
VITE_USER_POOL_ID=YOUR_USER_POOL_ID
VITE_CLIENT_ID=YOUR_USER_POOL_CLIENT_ID
VITE_COGNITO_DOMAIN=YOUR_UNIQUE_PREFIX.auth.eu-south-1.amazoncognito.com
VITE_API_URL=YOUR_PATIENT_API_URL
```

`VITE_COGNITO_DOMAIN` is a hostname without `https://`. `VITE_API_URL` is the API base URL without `/patients`. These values are public browser configuration. Never put AWS access keys, client secrets, passwords, or private tokens in a `VITE_` variable. `.env.local` is ignored by Git.

```sh
npm run dev
```

Open **http://localhost:5173/**. Use `localhost`, not `127.0.0.1`: the origin must match Cognito's callback/logout URLs and API Gateway's CORS configuration exactly. Vite uses port 5173 with `strictPort`, so it fails if that port is busy rather than silently choosing a different callback origin. Restart Vite after changing `.env.local`.

```sh
npm run build
```

The build checks TypeScript and creates `dist/`. Keep the frontend local for this step; no Vercel, Sites hosting, or custom domain is needed.

## Login and patient records

**Doctor Sign In** opens Cognito's hosted login using OAuth 2.0 authorization code flow with PKCE. Amplify completes the redirect, and auth events update the application when sign-in succeeds or fails. The dashboard displays the current doctor's username and requests `GET /patients` with the session's access token in the `Authorization: Bearer …` header.

The API returns a patient array containing `patient_id`, `first_name`, `last_name`, `age`, nested `diagnosis.diagnosis`, `admission_date`, and `status`. The backend selects records belonging to the authenticated doctor's Cognito `sub`. The dashboard includes loading, empty, request error, retry, and refresh states. Sign-out hides the patient dashboard immediately and ends the Cognito session.

## AI Clinical Assistant

Select a patient from the table, enter a question of up to 500 characters, and choose **Ask AI**. The assistant identifies the selected patient, displays the returned answer as text, and lists supporting clinical note IDs. An insufficient-evidence response is clearly identified. Asking is disabled until a patient is selected and while a request is pending.

The API client sends `POST /patients/{encoded_patient_id}/ask` to `VITE_API_URL`, with the current Cognito access token and JSON body `{ "question": "..." }`. The existing backend returns:

```typescript
interface ClinicalAnswer {
  answer: string
  supporting_note_ids: string[]
  insufficient_evidence: boolean
}
```

The frontend handles expired sessions, unavailable or unauthorized patients, invalid questions, AI service errors, network failures, and request timeouts with readable messages. Temporary failures offer retry; requests have a 35-second client timeout. Switching patients clears the previous question, answer, and error, and cancels pending browser requests. Late responses cannot populate another patient's assistant.

Questions and answers stay in React memory and are cleared on patient changes or sign-out. They are not saved to localStorage or logged. React never calls OpenAI directly and needs no OpenAI API key or additional Vite environment variables. The selected patient ID and authenticated session are sent to the backend, which remains responsible for patient authorization.

## Discharge letters

Select a patient and choose **Generate Discharge Letter**. The panel creates an asynchronous job, displays its queued or processing status, and checks progress approximately every three seconds. It automatically retrieves the draft when review is pending. Generation uses a UUIDv4 `Idempotency-Key`; retrying an uncertain submission reuses that key so it can recover the original job. An intentionally new generation uses a new key. Duplicate submissions are blocked while a request is running.

**Generate New Discharge Letter** stays visible when a job is open, including a draft awaiting review. It creates a separate job and keeps previous jobs in history. Save or cancel unsaved edits first.

The letter displays all seven sections, documented and missing information, and supporting note IDs. It remains clearly marked **AI-generated draft — Requires doctor review — Not signed**. Evidence references identify supplied source notes; they do not establish that the clinical text is factually correct.

Choose **Edit Draft** to edit documented-section text and **Save changes** to save it. Saving progress, failures, and success feedback appear beside the edit controls. Evidence references and documented flags are preserved. Missing sections retain the backend's required `Not documented in the supplied notes.` placeholder and cannot be filled with unsupported information through this text-only editor. Saves include the latest server `updated_at` value. A version conflict offers a reload of the latest draft; temporary failures retain unsaved edits.

**Approve Draft** opens an explicit confirmation dialog. If sections are missing, their acknowledgement is required. Approval records a doctor review decision and leaves the document unsigned; it is not an electronic or legal signature. **Reject Draft** requires a nonempty reason. Approved and rejected drafts are read-only. Unsaved edits must be resolved before reviewing the saved version.

All requests use the current doctor's Cognito access token and the existing API base URL:

| Request | Purpose |
| --- | --- |
| `GET /patients/{patient_id}/discharge-letters` | List the signed-in doctor's jobs for the selected patient, newest first |
| `POST /patients/{patient_id}/discharge-letters` | Create or recover a generation job with its idempotency key |
| `GET /discharge-jobs/{job_id}` | Monitor job status |
| `GET /discharge-jobs/{job_id}/draft` | Retrieve or reload the draft |
| `PUT /discharge-jobs/{job_id}/draft` | Save all seven sections and `expected_updated_at` |
| `POST /discharge-jobs/{job_id}/review` | Explicitly approve or reject with `expected_updated_at`, note, and missing-section acknowledgement |

Patient changes clear the previous draft, editor, review form, errors, and job tracking immediately. Pending requests are cancelled and late responses are ignored. Sign-out unmounts the workspace and clears patient-specific state. Drafts and job tracking remain in React memory; the frontend does not store drafts or access tokens in localStorage. Amplify retains its existing authentication configuration.

Selecting a patient displays their **Discharge letter jobs** table under Discharge Planning, scoped to the signed-in doctor. It shows job IDs, statuses, creation dates, and last updates. Click the table heading to collapse its rows, and click again to expand them. Collapsing keeps the open letter and job history intact. Choose **Open job** to resume tracking or review a saved letter, or **Refresh jobs** to reload history. Resolve unsaved edits or an uncertain generation retry before opening another job. Backend jobs continue when patients change or the page reloads; select the patient again to retrieve their history.

## Frontend tests

```sh
npm test
npm run test:watch
npm run lint
npx tsc -b
npm run build
```

Vitest, React Testing Library, and jsdom are development-only dependencies. Tests mock authentication and API requests, so they do not require AWS credentials, a doctor account, or live AI calls. The suite covers both feature contracts, generation retries, polling, editing, review confirmation, error handling, and patient isolation. No automated test approves or rejects a live AWS record. The build also checks TypeScript and creates `dist/`.

The public demo tests cover direct public startup, patient selection, deterministic answers and insufficient evidence, simulated generation, local editing, approval confirmation, missing-section acknowledgement, rejection validation, and reset/remount behavior. Isolation checks trap `fetch`, Amplify authentication, production API calls, and browser storage writes. The authenticated regression in [`AuthenticatedWorkspace.integration.test.tsx`](src/components/AuthenticatedWorkspace.integration.test.tsx) keeps the real workspace and API clients: it checks patient loading, asking, job creation and polling, draft retrieval and saving, and unsigned review approval, asserting the Cognito bearer header for every HTTP operation. Its HTTP server and session are synthetic; this verifies frontend compatibility without making live backend requests.

## Manual verification

1. Open the local URL and confirm the sign-in screen appears.
2. Choose **Doctor Sign In** and use an existing Cognito doctor account on the hosted login page.
3. Confirm the browser returns to `http://localhost:5173/` and displays the doctor's username.
4. In browser developer tools, confirm `GET /patients` returns HTTP 200 and the table contains only that doctor's synthetic records.
5. Select a patient, ask a question supported by their synthetic notes, and confirm `POST /patients/{patient_id}/ask` returns HTTP 200 with an answer and supporting note IDs.
6. Ask a question not established by the available notes and check the insufficient-evidence message when the backend returns that result.
7. Start a request, switch patients before it completes, and confirm no previous patient's question or answer appears in the new context.
8. Select a synthetic patient and confirm their discharge job history loads. Open an existing job or choose **Generate Discharge Letter**. For a new generation, confirm the creation request sends a UUIDv4 `Idempotency-Key`, status advances from queued/processing to review pending, and all seven sections appear with missing-information warnings and source note IDs.
9. Edit a documented section, save it, and confirm `PUT /discharge-jobs/{job_id}/draft` succeeds with the latest `expected_updated_at`. Check that the saved text remains visible. If browser preflight fails, check the CORS `PUT` prerequisite above.
10. On a disposable synthetic draft, open approval, confirm the missing-section count, and verify acknowledgement is required when applicable. Only deliberately confirm an actual synthetic review decision. Verify approved output is read-only and remains unsigned. Use a separate synthetic generation to verify rejection requires and displays a reason.
11. During generation or draft retrieval, switch patients and confirm neither the previous discharge letter nor the previous assistant answer appears. Repeat during saving/review on synthetic data if needed; cancelling a browser request does not undo a request already accepted by the server.
12. Refresh the page and confirm the session restores while the previous assistant question, answer, and active discharge job are cleared. Select the patient again and confirm saved jobs can be reopened from history.
13. Choose **Sign out**, including during a pending request, and confirm all patient information disappears. Sign in as a different doctor and confirm only their assigned synthetic patients appear.

These are manual live verification instructions for an existing doctor account. The implementation and automated tests do not perform live generation, approval, or rejection. A browser session against the deployed backend is still required to verify Cognito, CORS, and end-to-end asynchronous processing.

### Final verification checklist

The UI scenarios are covered by automated tests with synthetic data and mocked API requests. The live browser items below remain unchecked until performed in a signed-in doctor workspace; a mocked response does not establish persistence in AWS.

The combined workflow is verified in [`DischargeLetter.integration.test.tsx`](src/components/DischargeLetter.integration.test.tsx), using the real components and API clients with a stateful mock HTTP server. It saves and retrieves an edit, confirms approval, rejects a distinct generated job, and switches from Alice to Bob.

- [ ] Edit a documented section and click **Save changes**. Confirm the edited text remains visible and a subsequent draft retrieval returns it.
- [ ] Click **Approve Draft**. Verify the confirmation dialog appears and missing-information acknowledgement is required when sections are missing.
- [ ] Generate a separate synthetic job, click **Reject Draft**, and verify a nonempty rejection reason is required and displayed after rejection.
- [ ] Switch from Alice to Bob and verify Alice's draft disappears immediately.
- [x] Run frontend tests, TypeScript checks, and the production build: `npm test`, `npx tsc -b`, and `npm run build`.

## Troubleshooting

- **Login redirect fails:** check the client ID, domain, and exact `http://localhost:5173/` callback/logout URLs. Confirm the SAM update was deployed and the client permits the authorization code flow.
- **CORS error:** confirm the API URL and open the app at `http://localhost:5173`. Ensure deployed API Gateway CORS allows `PUT` for draft saves and the `Idempotency-Key` header for generation. Deploy a deliberately reviewed configuration update if needed. CORS does not replace JWT validation or doctor authorization.
- **HTTP 401:** sign out and sign in again. Verify that the frontend uses the deployed User Pool and client ID; the API expects an access token.
- **Empty patient table:** an HTTP 200 with `[]` means no records are assigned to this doctor. Check the synthetic records' `doctor_sub` against the doctor's Cognito `sub`; do not remove authorization filtering.
- **Request fails:** the dashboard shows an error and offers retry. Check the browser's network panel, AWS API/Lambda logs, and your connection.
- **Discharge history cannot load:** confirm the updated Lambda and `GET /patients/{patient_id}/discharge-letters` route have been deployed to the API in `VITE_API_URL`. A missing API Gateway route can appear as a browser network/CORS error. After deployment, choose **Refresh jobs**.
- **Assistant unavailable or timed out:** retry temporary errors. For HTTP 422, edit the question; for HTTP 404, select an authorized patient. The frontend does not display internal API error details.
- **Generation response lost or HTTP 503:** use **Retry generation** to reuse the original idempotency key. Creating a deliberately new generation can create another backend job.
- **Draft conflict (HTTP 409):** reload the latest draft before editing or reviewing again. Reloading replaces local unsaved edits after confirmation.
- **Missing section cannot be edited:** the current text-only editor preserves documented status and evidence references. Missing information must be addressed in the clinical source workflow before a new generation; the frontend cannot establish new evidence.
- **Discharge job failed:** the panel reports failure and allows a deliberately new generation. The failed job remains visible in the patient's discharge job history.

See Amplify's documentation for [using existing Cognito resources](https://docs.amplify.aws/react/build-a-backend/auth/use-existing-cognito-resources/) and [listening to auth events](https://docs.amplify.aws/gen1/react/build-a-backend/auth/auth-events/).
