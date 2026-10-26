import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

const headers = { 'X-Ryadom': '1' };
const baseURL = process.env.RYADOM_TEST_URL || 'http://127.0.0.1:4173';
const password = 'Audio-test-password-123!';
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(40)]);

async function setup(browser: Browser) {
 const doctor = await browser.newContext({ baseURL });
 const patient = await browser.newContext({ baseURL });
 expect((await doctor.request.post('/api/auth/register', { headers, data: { name: 'Врач Аудио', login: 'audio.' + crypto.randomUUID(), password, consent: true } })).ok()).toBeTruthy();
 const created = await doctor.request.post('/api/patients', { headers, data: { name: 'Пациент Аудио', birth: '1990-01-01', consent: true } });
 const access = await created.json();
 expect((await patient.request.post('/api/auth/activate', { headers, data: { token: access.inviteUrl.split('#')[1], password, consent: true } })).ok()).toBeTruthy();
 await patient.grantPermissions(['microphone']);
 return { doctor, patient, access, p: await patient.newPage(), d: await doctor.newPage() };
}

async function state(context: BrowserContext) { return (await context.request.get('/api/state')).json(); }
async function upload(context: BrowserContext, patientId: string, purpose = 'message', visitId = '') {
 const response = await context.request.post('/api/media', { headers, multipart: { patientId, purpose, consent: 'true', visitId, audio: { name: 'recording.wav', mimeType: 'audio/wav', buffer: wav } } });
 expect(response.ok()).toBeTruthy();
 return (await response.json()).id as string;
}
async function record(page: Page) {
 await page.getByRole('button', { name: 'Записать голосом', exact: true }).click();
 await page.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
 await expect(page.getByText('Идёт запись', { exact: true })).toBeVisible();
 await page.waitForTimeout(500);
 await page.getByRole('button', { name: 'Остановить запись', exact: true }).click();
 await expect(page.locator('.recorder audio')).toBeVisible();
}
async function confirmDelete(page: Page) {
 const modal = page.getByRole('dialog', { name: 'Удалить голосовую запись?' });
 await expect(modal.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
 await modal.getByRole('button', { name: 'Удалить запись', exact: true }).click();
 await expect(modal).toHaveCount(0);
}

test('draft audio requires confirmation, cancellation keeps it, and deleting allows another recording', async ({ browser }) => {
 const x = await setup(browser);
 await x.p.setViewportSize({width:390,height:844});
 await x.p.goto('/patient/messages');
 await x.p.getByRole('button', { name: 'Голосовое сообщение', exact: true }).click();
 await record(x.p);
 await x.p.getByRole('button', { name: 'Удалить запись', exact: true }).click();
 await x.p.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
 await expect(x.p.locator('.recorder audio')).toBeVisible();
 await expect(x.p.getByRole('button', { name: 'Отправить сообщение' })).toBeEnabled();
 await x.p.getByRole('button', { name: 'Удалить запись', exact: true }).click();
 await confirmDelete(x.p);
 await expect(x.p.locator('audio')).toHaveCount(0);
 await expect(x.p.getByRole('button', { name: 'Отправить сообщение' })).toBeDisabled();
 expect((await state(x.patient)).messages).toHaveLength(0);
 await record(x.p);
 await x.p.getByRole('button', { name: 'Отправить сообщение' }).click();
 await expect.poll(async () => (await state(x.doctor)).messages.length).toBe(1);
 await x.doctor.close(); await x.patient.close();
});

test('sent audio is deleted for both accounts and a failed deletion keeps the recording', async ({ browser }) => {
 const x = await setup(browser);
 const mediaId = await upload(x.patient, x.access.id);
 await x.patient.request.post('/api/messages', { headers, data: { id: crypto.randomUUID(), patientId: x.access.id, mediaId } });
 await x.p.goto('/patient/messages'); await x.d.goto(`/doctor/messages?patient=${x.access.id}`);
 await expect(x.d.getByRole('button', { name: 'Удалить запись', exact: true })).toHaveCount(0);
 await x.p.route(`**/api/media/${mediaId}`, async route => {
  if (route.request().method() === 'DELETE') await route.fulfill({ status: 503, json: { detail: 'Попробуйте ещё раз' } });
  else await route.continue();
 });
 await x.p.getByRole('button', { name: 'Удалить запись', exact: true }).click();
 await x.p.getByRole('dialog').getByRole('button', { name: 'Удалить запись', exact: true }).click();
 await expect(x.p.getByRole('dialog').getByRole('alert')).toHaveText('Попробуйте ещё раз');
 expect((await x.patient.request.get(`/api/media/${mediaId}`)).ok()).toBeTruthy();
 await x.p.unroute(`**/api/media/${mediaId}`);
 await x.p.getByRole('dialog').getByRole('button', { name: 'Удалить запись', exact: true }).click();
 await expect(x.p.locator('.chat-messages audio')).toHaveCount(0);
 await expect(x.d.locator('.chat-messages audio')).toHaveCount(0, { timeout: 12000 });
 await expect(x.d.getByText('Голосовая запись удалена.', { exact: true })).toBeVisible();
 expect((await x.patient.request.get(`/api/media/${mediaId}`)).status()).toBe(404);
 await x.p.reload(); await expect(x.p.getByText('Голосовая запись удалена.', { exact: true })).toBeVisible();
 await x.doctor.close(); await x.patient.close();
});

test('SOS recordings cannot be removed or replaced, including after the case is closed', async ({ browser }) => {
 const x = await setup(browser);
 const sosId = (await (await x.patient.request.post('/api/sos', { headers })).json()).id;
 await x.p.goto('/patient/sos');
 await x.p.getByRole('button', { name: 'Голосовое сообщение', exact: true }).click();
 await record(x.p);
 await expect(x.p.getByRole('button', { name: 'Удалить запись', exact: true })).toHaveCount(0);
 await expect(x.p.getByRole('button', { name: 'Записать ещё раз', exact: true })).toHaveCount(0);
 await x.p.getByRole('button', { name: 'Голосовое сообщение', exact: true }).click();
 await expect(x.p.locator('.recorder audio')).toBeVisible();
 await x.p.getByRole('button', { name: 'Отправить сообщение' }).click();
 await expect.poll(async () => (await state(x.patient)).messages.length).toBe(1);
 const mediaId = (await state(x.patient)).messages[0].mediaId;
 await x.doctor.request.post(`/api/sos/${sosId}/close`, { headers });
 await x.p.reload();
 await expect(x.p.locator('.chat-messages audio')).toBeVisible();
 await expect(x.p.getByRole('button', { name: 'Удалить запись', exact: true })).toHaveCount(0);
 expect((await x.patient.request.delete(`/api/media/${mediaId}`, { headers, data: { confirm: true } })).status()).toBe(403);
 await x.doctor.close(); await x.patient.close();
});

test('diary recording survives switching steps and can be deleted without losing answers', async ({ browser }) => {
 const x = await setup(browser);
 await x.p.goto('/patient/diary');
 await x.p.getByRole('button', { name: '4 Хорошо', exact: true }).click();
 await x.p.getByLabel('Можно рассказать своими словами').fill('Сохранить текст дневника');
 await record(x.p);
 await x.p.getByRole('button', { name: /Далее — сон/ }).click();
 await x.p.getByLabel('Сколько часов вы спали?').fill('7');
 await x.p.getByLabel('Сколько у вас энергии сейчас?').selectOption('6');
 await x.p.getByRole('button', { name: 'Назад', exact: true }).click();
 await expect(x.p.locator('.recorder audio')).toBeVisible();
 await x.p.getByRole('button', { name: /Далее — сон/ }).click();
 await x.p.getByRole('button', { name: 'Сохранить запись', exact: true }).click();
 await expect(x.p.getByRole('heading', { name: 'Запись сохранена' })).toBeVisible();
 await x.p.locator('.history-entry').getByRole('button', { name: 'Удалить запись', exact: true }).click();
 await confirmDelete(x.p);
 await expect(x.p.locator('.history-entry audio')).toHaveCount(0);
 const entry = (await state(x.patient)).entries[0];
 expect(entry.mediaId).toBeUndefined(); expect(entry.comment).toBe('Сохранить текст дневника');
 await x.p.getByRole('button', { name: 'Изменить сегодняшнюю запись', exact: true }).click();
 await expect(x.p.locator('.diary-form audio')).toHaveCount(0);
 await expect(x.p.getByLabel('Можно рассказать своими словами')).toHaveValue('Сохранить текст дневника');
 await x.doctor.close(); await x.patient.close();
});

test('visit audio removal updates the AI selector and preserves unsaved notes', async ({ browser }) => {
 const x = await setup(browser);
 const visitId = (await (await x.doctor.request.post('/api/visits', { headers, data: { patientId: x.access.id, scheduled: new Date().toISOString() } })).json()).id;
 const first = await upload(x.doctor, x.access.id, 'visit', visitId);
 const second = await upload(x.doctor, x.access.id, 'visit', visitId);
 await x.d.goto(`/doctor/visit/${visitId}`);
 await x.d.getByLabel('Жалобы, анамнез и заметки · видны только врачу').fill('Не потерять эти заметки');
 await x.d.getByLabel('Запись для заполнения').selectOption(first);
 await x.d.getByRole('button', { name: 'Удалить запись', exact: true }).first().click();
 await confirmDelete(x.d);
 await expect(x.d.getByLabel('Запись для заполнения')).toHaveValue(second);
 await expect(x.d.getByLabel('Жалобы, анамнез и заметки · видны только врачу')).toHaveValue('Не потерять эти заметки');
 await x.d.getByLabel('Или загрузите аудиофайл').setInputFiles({ name: 'recording.wav', mimeType: 'audio/wav', buffer: wav });
 await x.d.locator('.recorder').getByRole('button', { name: 'Удалить запись', exact: true }).click();
 await confirmDelete(x.d);
 await expect(x.d.getByRole('button', { name: 'Сохранить аудио приёма', exact: true })).toHaveCount(0);
 await expect(x.d.getByLabel('Или загрузите аудиофайл')).toHaveValue('');
 await x.doctor.close(); await x.patient.close();
});
