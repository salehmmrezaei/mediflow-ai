# MediFlow AI frontend

Local React and TypeScript doctor workspace with the Step 7.20 AI Clinical Assistant. AWS Amplify's client library connects directly to the existing Cognito User Pool. The assistant uses the deployed patient API; this frontend update requires no AWS or hosting deployment.

## Existing AWS configuration

Skip infrastructure deployment for Step 7.20 when the backend is already configured. The following commands describe the earlier Step 6 setup and should be used only when deliberately setting up that infrastructure.

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
npm install
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

**Sign in** opens Cognito's hosted login using OAuth 2.0 authorization code flow with PKCE. Amplify completes the redirect, and auth events update the application when sign-in succeeds or fails. The dashboard displays the current doctor's username and requests `GET /patients` with the session's access token in the `Authorization: Bearer …` header.

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

## Frontend tests

```sh
npm test
npm run test:watch
```

Vitest, React Testing Library, and jsdom are development-only dependencies. Tests mock authentication and API requests, so they do not require AWS credentials, a doctor account, or live AI calls. The suite covers request contracts, error handling, assistant states, and patient-switch isolation. Run `npm run build` to check TypeScript and build the application.

## Manual verification

1. Open the local URL and confirm the sign-in screen appears.
2. Choose **Sign in** and use an existing Cognito doctor account on the hosted login page.
3. Confirm the browser returns to `http://localhost:5173/` and displays the doctor's username.
4. In browser developer tools, confirm `GET /patients` returns HTTP 200 and the table contains only that doctor's synthetic records.
5. Select a patient, ask a question supported by their synthetic notes, and confirm `POST /patients/{patient_id}/ask` returns HTTP 200 with an answer and supporting note IDs.
6. Ask a question not established by the available notes and check the insufficient-evidence message when the backend returns that result.
7. Start a request, switch patients before it completes, and confirm no previous patient's question or answer appears in the new context.
8. Refresh the page and confirm the session restores while the previous assistant question and answer are cleared.
9. Choose **Sign out**, including during a pending question, and confirm patient and assistant information disappears.

These are live verification instructions for an existing doctor account; the automated suite uses mocks.

## Troubleshooting

- **Login redirect fails:** check the client ID, domain, and exact `http://localhost:5173/` callback/logout URLs. Confirm the SAM update was deployed and the client permits the authorization code flow.
- **CORS error:** confirm the API URL, deploy the CORS update, and open the app at `http://localhost:5173`. CORS does not replace JWT validation or doctor authorization.
- **HTTP 401:** sign out and sign in again. Verify that the frontend uses the deployed User Pool and client ID; the API expects an access token.
- **Empty patient table:** an HTTP 200 with `[]` means no records are assigned to this doctor. Check the synthetic records' `doctor_sub` against the doctor's Cognito `sub`; do not remove authorization filtering.
- **Request fails:** the dashboard shows an error and offers retry. Check the browser's network panel, AWS API/Lambda logs, and your connection.
- **Assistant unavailable or timed out:** retry temporary errors. For HTTP 422, edit the question; for HTTP 404, select an authorized patient. The frontend does not display internal API error details.

See Amplify's documentation for [using existing Cognito resources](https://docs.amplify.aws/react/build-a-backend/auth/use-existing-cognito-resources/) and [listening to auth events](https://docs.amplify.aws/gen1/react/build-a-backend/auth/auth-events/).
