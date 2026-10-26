import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const headers = { 'X-Ryadom': '1' };
const password = 'Test-ai-password-long-123!';
const baseURL = process.env.RYADOM_TEST_URL || 'http://127.0.0.1:4173';
const source = 'Пациент: сон прерывистый. Аллергия на пенициллин. Врач: повторный приём через неделю.';
const plan = 'Повторный приём через неделю.';

async function setup(browser: Browser) {
 const doctor = await browser.newContext({ baseURL });
 const patient = await browser.newContext({ baseURL });
 const register = await doctor.request.post('/api/auth/register', { headers, data: { name: 'Врач ИИ Тест', login: 'ai.' + crypto.randomUUID(), password, consent: true } });
 expect(register.ok()).toBeTruthy();
 const created = await doctor.request.post('/api/patients', { headers, data: { name: 'Пациент ИИ Тест', birth: '1990-01-01', consent: true } });
 const p = await created.json();
 expect((await patient.request.post('/api/auth/activate', { headers, data: { token: p.inviteUrl.split('#')[1], password, consent: true } })).ok()).toBeTruthy();
 const v = await doctor.request.post('/api/visits', { headers, data: { patientId: p.id, scheduled: new Date().toISOString() } });
 const visitId = (await v.json()).id;
 const page = await doctor.newPage();
 await page.route('**/api/state', async route => {
  const response = await route.fetch();
  await route.fulfill({ response, json: { ...await response.json(), ai: { enabled: true } } });
 });
 return { doctor, patient, p, visitId, page };
}

function suggestion(text = source, version = 1, patientVersion = 1) {
 const field = (value: string, quote: string) => ({ value, evidence: [quote] });
 return { source: text, version, patientVersion, created: new Date().toISOString(), model: 'test-mock', suggestion: {
  visit: { notes: field('Со слов пациента: прерывистый сон.', 'Пациент: сон прерывистый.'), observation: null, diagnosis: null, plan: field(plan, 'Врач: повторный приём через неделю.') },
  card: { allergy: field('Аллергия на пенициллин.', 'Аллергия на пенициллин.'), conditions: null, medications: null, note: null, transfer: null }, warnings: ['Проверьте распознавание названия аллергена.'],
 } };
}

async function mockDraft(page: Page, visitId: string, result: () => ReturnType<typeof suggestion>) {
 await page.route(`**/api/visits/${visitId}/ai-draft`, route => route.fulfill({ json: route.request().method() === 'GET' ? { draft: null } : result() }));
}

test('AI text is reviewed, corrected, saved privately and confirmed with the medical card', async ({ browser }) => {
 const x = await setup(browser);
 await mockDraft(x.page, x.visitId, () => suggestion());
 await x.page.goto(`/doctor/visit/${x.visitId}`);
 const generate = x.page.getByRole('button', { name: 'Заполнить по тексту', exact: true });
 await x.page.getByLabel('Исходный текст для помощника').fill(source);
 await expect(generate).toBeDisabled();
 await x.page.getByLabel('Автоматически перенести факты в черновик карточки').uncheck();
 await x.page.getByLabel('Есть согласие пациента на обработку этих данных в OpenAI').check();
 await generate.click();
 await expect(x.page.getByRole('heading', { name: 'Проверьте предложенные поля' })).toBeVisible();
 await expect(x.page.getByText('Проверьте распознавание названия аллергена.')).toBeVisible();
 await x.page.getByLabel('Предложение: План для пациента').fill('Уточнённый врачом план');
 await x.page.getByRole('button', { name: 'Перенести выбранное в форму' }).click();
 await expect(x.page.getByLabel('Подтверждаемый план для пациента')).toHaveValue('Уточнённый врачом план');
 await expect(x.page.getByLabel('Медкарта: Аллергии и нежелательные реакции')).toHaveValue('Аллергия на пенициллин.');
 await x.page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
 await expect(x.page.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
 let privateState = await (await x.patient.request.get('/api/state')).json();
 expect(JSON.stringify(privateState)).not.toContain('Аллергия на пенициллин');
 expect(JSON.stringify(privateState)).not.toContain('Уточнённый врачом план');
 await x.page.reload();
 await expect(x.page.getByLabel('Медкарта: Аллергии и нежелательные реакции')).toHaveValue('Аллергия на пенициллин.');
 await x.page.getByRole('button', { name: 'Подтвердить и сохранить', exact: true }).click();
 await x.page.getByRole('button', { name: 'Да, подтвердить план', exact: true }).click();
 await expect(x.page.getByText('Подтверждено врачом', { exact: true })).toBeVisible();
 const doctorState = await (await x.doctor.request.get('/api/state')).json();
 expect(doctorState.patients[0].allergy).toBe('Аллергия на пенициллин.');
 privateState = await (await x.patient.request.get('/api/state')).json();
 expect(privateState.visits[0].plan).toBe('Уточнённый врачом план');
 expect(JSON.stringify(privateState)).not.toContain('clinicalDraft');
 await x.doctor.close(); await x.patient.close();
});

test('audio-to-draft preserves transcript on failure and retries without duplicate text', async ({ browser }) => {
 const x = await setup(browser);
 const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(40)]);
 const audio = await x.doctor.request.post('/api/media', { headers, multipart: { patientId: x.p.id, purpose: 'visit', visitId: x.visitId, consent: 'true', audio: { name: 'test.wav', mimeType: 'audio/wav', buffer: wav } } });
 expect(audio.ok()).toBeTruthy();
 const mediaId = (await audio.json()).id;
 await x.page.route(`**/api/media/${mediaId}/transcription`, route => route.fulfill({ json: { text: source, created: new Date().toISOString(), model: 'test' } }));
 let failures = 1;
 await x.page.route(`**/api/visits/${x.visitId}/ai-draft`, route => {
  if (route.request().method() === 'GET') return route.fulfill({ json: { draft: null } });
  if (failures-- > 0) return route.fulfill({ status: 502, json: { detail: 'Сервис временно недоступен' } });
  expect(route.request().postDataJSON().source).toBe(source);
  return route.fulfill({ json: suggestion() });
 });
 await x.page.goto(`/doctor/visit/${x.visitId}`);
 await x.page.getByLabel('Автоматически перенести факты в черновик карточки').uncheck();
 await x.page.getByLabel('Есть согласие пациента на обработку этих данных в OpenAI').check();
 await x.page.getByRole('button', { name: 'Заполнить по аудио', exact: true }).click();
 await expect(x.page.getByRole('alert')).toContainText('Сервис временно недоступен');
 await expect(x.page.getByLabel('Исходный текст для помощника')).toHaveValue(source);
 await x.page.getByRole('button', { name: 'Заполнить по аудио', exact: true }).click();
 await expect(x.page.getByRole('heading', { name: 'Проверьте предложенные поля' })).toBeVisible();
 await x.page.setViewportSize({ width: 390, height: 844 });
 expect(await x.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
 await x.doctor.close(); await x.patient.close();
});

test('existing plan and later edits are not silently overwritten', async ({ browser }) => {
 const x = await setup(browser);
 await mockDraft(x.page, x.visitId, () => suggestion());
 await x.page.goto(`/doctor/visit/${x.visitId}`);
 await x.page.getByLabel('Подтверждаемый план для пациента').fill('Мой существующий план');
 await x.page.getByLabel('Исходный текст для помощника').fill(source);
 await x.page.getByLabel('Автоматически перенести факты в черновик карточки').uncheck();
 await x.page.getByLabel('Есть согласие пациента на обработку этих данных в OpenAI').check();
 await x.page.getByRole('button', { name: 'Заполнить по тексту', exact: true }).click();
 await expect(x.page.getByRole('checkbox', { name: 'Приём · План для пациента' })).not.toBeChecked();
 await x.page.getByLabel('Жалобы, анамнез и заметки · видны только врачу').fill('Новая ручная заметка');
 await expect(x.page.getByRole('button', { name: 'Перенести выбранное в форму' })).toBeDisabled();
 await x.page.getByRole('button', { name: 'Заполнить по тексту', exact: true }).click();
 await x.page.getByRole('button', { name: 'Перенести выбранное в форму' }).click();
 await expect(x.page.getByLabel('Подтверждаемый план для пациента')).toHaveValue('Мой существующий план');
 await expect(x.page.getByLabel('Жалобы, анамнез и заметки · видны только врачу')).toHaveValue(/Новая ручная заметка/);
 await x.doctor.close(); await x.patient.close();
});

test('doctor can transcribe a voice message with consent, patient does not see the transcript', async ({ browser }) => {
 const x = await setup(browser);
 const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(40)]);
 const uploaded = await x.patient.request.post('/api/media', { headers, multipart: { patientId: x.p.id, purpose: 'message', consent: 'true', audio: { name: 'test.wav', mimeType: 'audio/wav', buffer: wav } } });
 const mediaId = (await uploaded.json()).id;
 expect((await x.patient.request.post('/api/messages', { headers, data: { id: crypto.randomUUID(), patientId: x.p.id, mediaId } })).ok()).toBeTruthy();
 await x.page.route(`**/api/media/${mediaId}/transcription`, route => route.fulfill({ json: route.request().method() === 'GET' ? { transcript: null } : { text: source, created: new Date().toISOString(), model: 'test' } }));
 await x.page.goto(`/doctor/messages?patient=${x.p.id}`);
 await x.page.getByRole('button', { name: 'Расшифровать голосовое', exact: true }).click();
 const modal = x.page.getByRole('dialog', { name: 'Расшифровать голосовое?' });
 await expect(modal.getByRole('button', { name: 'Передать и расшифровать' })).toBeDisabled();
 await modal.getByRole('checkbox').check();
 await modal.getByRole('button', { name: 'Передать и расшифровать' }).click();
 await expect(x.page.getByText(source, { exact: true })).toBeVisible();
 const patientPage = await x.patient.newPage(); await patientPage.goto('/patient/messages');
 await expect(patientPage.getByRole('button', { name: 'Расшифровать голосовое' })).toHaveCount(0);
 await expect(patientPage.getByText(source, { exact: true })).toHaveCount(0);
 await x.doctor.close(); await x.patient.close();
});

test('auto-fill, clinical hypotheses and a chosen reference medicine stay private until confirmation', async ({ browser }) => {
 const x = await setup(browser);
 const reason = { value: 'Требуется оценить тревогу и нарушение сна.', evidence: ['Пациент: сон прерывистый.'] };
 await x.page.route(`**/api/visits/${x.visitId}/ai-draft`, route => {
  if (route.request().method() === 'GET') return route.fulfill({ json: { draft: null } });
  expect(route.request().postDataJSON().includeClinicalContext).toBe(true);
  const value = suggestion();
  return route.fulfill({ json: { ...value, suggestion: { ...value.suggestion, contextUsed: true,
   diagnoses: [{ name: 'Диагностическая гипотеза', icd10: null, rationale: reason, against: [], missing: ['Длительность симптомов'] }],
   medications: [{ name: 'Авиандр', inn: 'Маритупирдин', rationale: reason, cautions: ['Проверить показания и противопоказания'] }],
   questions: ['Как долго нарушен сон?'], redFlags: [],
  } } });
 });
 await x.page.route('**/api/medicines/search', route => {
  expect(route.request().postDataJSON()).toEqual({ query: 'Авиандр', source: 'Видаль' });
  return route.fulfill({ json: { items: [{ name: 'Авиандр', inn: 'Маритупирдин', form: 'Таблетки', strength: '20 мг', manufacturer: null, url: 'https://www.vidal.ru/drugs/aviandr' }], source: 'Видаль', query: 'Авиандр', mode: 'public_search', checkedAt: new Date().toISOString() } });
 });
 await x.page.goto(`/doctor/visit/${x.visitId}`);
 await expect(x.page.getByLabel('Автоматически перенести факты в черновик карточки')).toBeChecked();
 await x.page.getByLabel('Исходный текст для помощника').fill(source);
 await x.page.getByLabel('Учесть сохранённую медкарту и действующие назначения').check();
 await x.page.getByLabel('Есть согласие пациента на обработку этих данных в OpenAI').check();
 await x.page.getByRole('button', { name: 'Заполнить по тексту', exact: true }).click();
 await expect(x.page.getByLabel('Медкарта: Аллергии и нежелательные реакции')).toHaveValue('Аллергия на пенициллин.');
 await expect(x.page.getByLabel('Подтверждаемый план для пациента')).toHaveValue(plan);
 await expect(x.page.getByLabel('Диагноз / статус наблюдения · для пациента')).toHaveValue('');
 await expect(x.page.getByLabel('Препарат 1', { exact: true })).toHaveCount(0);
 await x.page.setViewportSize({ width: 390, height: 844 });
 expect(await x.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
 expect(JSON.stringify(await (await x.patient.request.get('/api/state')).json())).not.toContain('Диагностическая гипотеза');
 await x.page.getByRole('button', { name: 'Выбрать диагноз в черновик', exact: true }).click();
 await expect(x.page.getByLabel('Диагноз / статус наблюдения · для пациента')).toHaveValue('Диагностическая гипотеза');
 await x.page.getByRole('button', { name: 'Проверить Авиандр в справочнике', exact: true }).click();
 await expect(x.page.getByLabel('Название или МНН')).toHaveValue('Авиандр');
 await x.page.getByLabel('База лекарств').selectOption('Видаль');
 await x.page.getByRole('button', { name: 'Использовать эту базу по умолчанию', exact: true }).click();
 await expect(x.page.getByRole('status').filter({ hasText: 'База лекарств сохранена' })).toBeVisible();
 await x.page.getByRole('button', { name: 'Найти препарат', exact: true }).click();
 await expect(x.page.getByRole('link', { name: 'Карточка и инструкция · Видаль' })).toHaveAttribute('href', 'https://www.vidal.ru/drugs/aviandr');
 await x.page.getByRole('button', { name: 'Выбрать Авиандр', exact: true }).click();
 await expect(x.page.getByLabel('Препарат 1', { exact: true })).toHaveValue('Авиандр');
 await expect(x.page.getByLabel('Дозировка', { exact: true })).toHaveValue('');
 await expect(x.page.getByLabel('Время приёма · через запятую')).toHaveValue('');
 await x.page.getByLabel('Дозировка', { exact: true }).fill('Проверенная врачом доза');
 await x.page.getByLabel('Время приёма · через запятую').fill('09:00');
 await x.page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
 await expect(x.page.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
 let patientState = await (await x.patient.request.get('/api/state')).json();
 expect(patientState.prescriptions).toEqual([]);
 expect(JSON.stringify(patientState)).not.toContain('Диагностическая гипотеза');
 await x.page.getByRole('button', { name: 'Подтвердить и сохранить', exact: true }).click();
 await x.page.getByRole('button', { name: 'Да, подтвердить план', exact: true }).click();
 await expect(x.page.getByText('Подтверждено врачом', { exact: true })).toBeVisible();
 patientState = await (await x.patient.request.get('/api/state')).json();
 expect(patientState.visits[0].diagnosis).toBe('Диагностическая гипотеза');
 expect(patientState.prescriptions[0].name).toBe('Авиандр');
 const doctorState = await (await x.doctor.request.get('/api/state')).json();
 expect(doctorState.patients[0].allergy).toBe('Аллергия на пенициллин.');
 expect(doctorState.settings.source).toBe('Видаль');
 await x.doctor.close(); await x.patient.close();
});

test('auto-fill preserves manual changes made while the model is responding', async ({ browser }) => {
 const x = await setup(browser);
 let release: (() => void) | undefined;
 const barrier = new Promise<void>(resolve => { release = resolve; });
 await x.page.route(`**/api/visits/${x.visitId}/ai-draft`, async route => {
  if (route.request().method() === 'GET') return route.fulfill({ json: { draft: null } });
  await barrier;
  await route.fulfill({ json: suggestion() });
 });
 await x.page.goto(`/doctor/visit/${x.visitId}`);
 await x.page.getByLabel('Исходный текст для помощника').fill(source);
 await x.page.getByLabel('Есть согласие пациента на обработку этих данных в OpenAI').check();
 const started = x.page.waitForRequest(r => r.url().endsWith('/ai-draft') && r.method() === 'POST');
 await x.page.getByRole('button', { name: 'Заполнить по тексту', exact: true }).click();
 await started;
 await x.page.getByLabel('Жалобы, анамнез и заметки · видны только врачу').fill('Ручные данные во время ожидания');
 release!();
 await expect(x.page.getByRole('heading', { name: 'Проверьте предложенные поля' })).toBeVisible();
 await expect(x.page.getByLabel('Жалобы, анамнез и заметки · видны только врачу')).toHaveValue('Ручные данные во время ожидания');
 await expect(x.page.getByLabel('Медкарта: Аллергии и нежелательные реакции')).toHaveCount(0);
 await x.doctor.close(); await x.patient.close();
});

test('empty medication suggestions explain why and can be reviewed separately without changing the form', async ({ browser }) => {
 const x = await setup(browser);
 let calls = 0;
 await x.page.route(`**/api/visits/${x.visitId}/ai-draft`, route => {
  if (route.request().method() === 'GET') return route.fulfill({ json: { draft: null } });
  calls++;
  const data = route.request().postDataJSON();
  expect(data.reviewMedications).toBe(calls > 1);
  expect(data.source).toBe(source);
  const value = suggestion();
  return route.fulfill({ json: { ...value, suggestion: { ...value.suggestion,
   medicationAssessment: { reason: calls === 1 ? 'Для обсуждения лекарств нужно уточнить характер нарушения сна.' : 'Вариант для рассмотрения врачом после уточнения ограничений.', missing: calls === 1 ? ['Как долго нарушен сон?'] : [] },
   medications: calls === 1 ? [] : [{ name: 'Авиандр', inn: 'Маритупирдин', rationale: { value: 'Для обсуждения врачом.', evidence: [source] }, cautions: ['Проверить показания'] }],
  } } });
 });
 await x.page.goto(`/doctor/visit/${x.visitId}`);
 const medications = x.page.getByRole('button', { name: 'Предложить препараты', exact: true });
 await x.page.getByLabel('Исходный текст для помощника').fill(source);
 await expect(medications).toBeDisabled();
 await x.page.getByLabel('Есть согласие пациента на обработку этих данных в OpenAI').check();
 await x.page.getByRole('button', { name: 'Заполнить по тексту', exact: true }).click();
 const section = x.page.getByRole('region', { name: 'Варианты препаратов', exact: true });
 await expect(section.getByRole('heading', { name: 'Варианты препаратов' })).toBeVisible();
 await expect(section.getByText('Для обсуждения лекарств нужно уточнить характер нарушения сна.')).toBeVisible();
 await expect(section.getByText('Как долго нарушен сон?')).toBeVisible();
 await x.page.getByLabel('Жалобы, анамнез и заметки · видны только врачу').fill('Ручные заметки врача');
 await x.page.getByLabel('Подтверждаемый план для пациента').fill('Сохранить мой план');
 await medications.click();
 await expect(section.getByRole('button', { name: 'Проверить Авиандр в справочнике' })).toBeVisible();
 await expect(x.page.getByLabel('Жалобы, анамнез и заметки · видны только врачу')).toHaveValue('Ручные заметки врача');
 await expect(x.page.getByLabel('Подтверждаемый план для пациента')).toHaveValue('Сохранить мой план');
 await expect(x.page.getByLabel('Препарат 1', { exact: true })).toHaveCount(0);
 expect((await (await x.patient.request.get('/api/state')).json()).prescriptions).toEqual([]);
 await x.doctor.close(); await x.patient.close();
});

test('an old saved draft offers an explicit refresh and retains its source', async ({ browser }) => {
 const x = await setup(browser);
 await x.page.route(`**/api/visits/${x.visitId}/ai-draft`, route => route.fulfill({ json: { draft: { ...suggestion(), needsRefresh: true } } }));
 await x.page.goto(`/doctor/visit/${x.visitId}`);
 await expect(x.page.getByText('Помощник обновлён.', { exact: false })).toBeVisible();
 await expect(x.page.getByLabel('Исходный текст для помощника')).toHaveValue(source);
 await expect(x.page.getByRole('heading', { name: 'Варианты препаратов', exact: true })).toBeVisible();
 await expect(x.page.getByRole('button', { name: 'Перенести выбранное в форму' })).toBeDisabled();
 await x.page.getByLabel('Есть согласие пациента на обработку этих данных в OpenAI').check();
 await expect(x.page.getByRole('button', { name: 'Предложить препараты', exact: true })).toBeEnabled();
 await x.doctor.close(); await x.patient.close();
});
