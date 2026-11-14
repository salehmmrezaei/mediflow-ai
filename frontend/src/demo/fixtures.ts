// Deliberately independent of production API types and clients. These invented
// records are bundled with the public demo; nothing is fetched or persisted.
export const DEMO_QUESTIONS = [
  { id: 'admission', label: 'What symptoms led to admission?' },
  { id: 'investigations', label: 'What investigations are documented?' },
  { id: 'medications', label: 'What is the discharge medication plan?' },
] as const

export type DemoQuestionId = typeof DEMO_QUESTIONS[number]['id']
export type DemoAnswer = {
  text: string
  noteIds: readonly string[]
  insufficient: boolean
}
export type DemoPatient = {
  id: string
  name: string
  age: number
  admissionDate: string
  presentation: string
  notes: readonly { id: string; title: string; text: string }[]
  answers: Record<DemoQuestionId, DemoAnswer>
  admissionText: string
  investigationsText: string
}

export const DEMO_PATIENTS: readonly DemoPatient[] = [
  {
    id: 'DEMO-ALICE', name: 'Alice Example', age: 42, admissionDate: '2026-10-12',
    presentation: 'Fever and cough',
    notes: [
      { id: 'N001', title: 'Admission note · 12 Oct 2026', text: 'Fictional Alice Example, age 42, was admitted for assessment after three days of fever, dry cough and fatigue. No discharge plan is recorded.' },
      { id: 'N002', title: 'Investigation note · 12 Oct 2026', text: 'White cell count 12.4 × 10⁹/L; CRP 48 mg/L. Chest radiograph reported no focal air-space opacity. These are investigation findings only; no final diagnosis, hospital course or discharge details are supplied.' },
    ],
    answers: {
      admission: { text: 'Alice Example was admitted for assessment after three days of fever, dry cough and fatigue.', noteIds: ['N001'], insufficient: false },
      investigations: { text: 'The recorded investigations are a white cell count of 12.4 × 10⁹/L, CRP of 48 mg/L and a chest radiograph with no focal air-space opacity. No final diagnosis is established in the supplied notes.', noteIds: ['N002'], insufficient: false },
      medications: { text: 'Insufficient evidence. The supplied notes do not document a discharge medication plan. A medication or dose cannot be inferred from these findings.', noteIds: [], insufficient: true },
    },
    admissionText: 'Alice Example was admitted for assessment after three days of fever, dry cough and fatigue.',
    investigationsText: 'White cell count 12.4 × 10⁹/L and CRP 48 mg/L. Chest radiograph: no focal air-space opacity. No final diagnosis is documented.',
  },
  {
    id: 'DEMO-BOB', name: 'Bob Example', age: 58, admissionDate: '2026-10-14',
    presentation: 'Dizziness and palpitations',
    notes: [
      { id: 'N001', title: 'Admission note · 14 Oct 2026', text: 'Fictional Bob Example, age 58, was admitted for assessment of intermittent dizziness and palpitations beginning that morning. No discharge plan is recorded.' },
      { id: 'N002', title: 'Investigation note · 14 Oct 2026', text: 'ECG recorded sinus rhythm at 88 beats per minute. Haemoglobin 139 g/L; potassium 4.1 mmol/L. These are investigation findings only; no final diagnosis, hospital course or discharge details are supplied.' },
    ],
    answers: {
      admission: { text: 'Bob Example was admitted for assessment of intermittent dizziness and palpitations that began that morning.', noteIds: ['N001'], insufficient: false },
      investigations: { text: 'The recorded investigations are an ECG showing sinus rhythm at 88 beats per minute, haemoglobin of 139 g/L and potassium of 4.1 mmol/L. The notes do not establish a final diagnosis.', noteIds: ['N002'], insufficient: false },
      medications: { text: 'Insufficient evidence. Bob Example’s notes contain no discharge medication plan. A medication or dose cannot be inferred from the recorded investigations.', noteIds: [], insufficient: true },
    },
    admissionText: 'Bob Example was admitted for assessment of intermittent dizziness and palpitations that began that morning.',
    investigationsText: 'ECG: sinus rhythm at 88 beats per minute. Haemoglobin 139 g/L and potassium 4.1 mmol/L. No final diagnosis is documented.',
  },
]

// Keep the same clinical headings as the real workspace without importing its
// authenticated client module, including for constants or validation helpers.
export const DEMO_SECTIONS = [
  { id: 'admission_reason', label: 'Admission reason' },
  { id: 'hospital_course', label: 'Hospital course' },
  { id: 'investigations', label: 'Investigations' },
  { id: 'discharge_diagnosis', label: 'Discharge diagnosis' },
  { id: 'discharge_medications', label: 'Discharge medications' },
  { id: 'discharge_date', label: 'Discharge date' },
  { id: 'follow_up', label: 'Follow-up' },
] as const
export type DemoSectionId = typeof DEMO_SECTIONS[number]['id']
export type DemoDraft = Record<DemoSectionId, { text: string; noteIds: string[]; documented: boolean }>
export const DEMO_MISSING_TEXT = 'Not documented in the supplied notes.'

export function createDemoDraft(patient: DemoPatient): DemoDraft {
  return Object.fromEntries(DEMO_SECTIONS.map(({ id }) => [id, {
    text: id === 'admission_reason' ? patient.admissionText
      : id === 'investigations' ? patient.investigationsText : DEMO_MISSING_TEXT,
    noteIds: id === 'admission_reason' ? ['N001'] : id === 'investigations' ? ['N002'] : [],
    documented: id === 'admission_reason' || id === 'investigations',
  }])) as DemoDraft
}
