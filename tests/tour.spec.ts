import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

const headers = { 'X-Ryadom': '1' };
const password = 'Test-tour-password-long-123!';
const baseURL = process.env.RYADOM_TEST_URL || 'http://127.0.0.1:4173';

async function state(context: BrowserContext) { return (await context.request.get('/api/state')).json(); }
async function setup(browser: Browser, populated = true) {
 const doctor = await browser.newContext({ baseURL });
 const patient = await browser.newContext({ baseURL });
 expect((await doctor.request.post('/api/auth/register', { headers, data: { name: 'Врач Обучение', login: 'tour.' + crypto.randomUUID(), password, consent: true } })).ok()).toBeTruthy();
 let visitId = '';
 if (populated) {
  const created = await doctor.request.post('/api/patients', { headers, data: { name: 'Пациент Обучение', birth: '1990-01-01', consent: true } });
  expect(created.ok()).toBeTruthy();
  const p = await created.json();
  expect((await patient.request.post('/api/auth/activate', { headers, data: { token: p.inviteUrl.split('#')[1], password, consent: true } })).ok()).toBeTruthy();
  const v = await doctor.request.post('/api/visits', { headers, data: { patientId: p.id, scheduled: new Date().toISOString() } });
  expect(v.ok()).toBeTruthy();
  const published = (await v.json()).id;
  expect((await doctor.request.put(`/api/visits/${published}`, { headers, data: { version: 1, confirm: true, plan: 'Учебный план', prescriptions: [{ name: 'Учебный препарат', dose: 'Учебная дозировка', times: ['09:00'], start: '2020-01-01' }] } })).ok()).toBeTruthy();
  const draft = await doctor.request.post('/api/visits', { headers, data: { patientId: p.id, scheduled: new Date().toISOString() } });
  expect(draft.ok()).toBeTruthy(); visitId = (await draft.json()).id;
  for (const author of [doctor, patient]) expect((await author.request.post('/api/messages', { headers, data: { id: crypto.randomUUID(), patientId: p.id, text: 'Непрочитанное сообщение для обучения' } })).ok()).toBeTruthy();
  expect((await patient.request.post('/api/sos', { headers })).ok()).toBeTruthy();
 }
 return { doctor, patient, visitId, close: async () => { await doctor.close(); await patient.close(); } };
}

async function start(page: Page, full = true) {
 await page.getByRole('button', { name: 'Обучение по сайту', exact: true }).click();
 await page.getByRole('button', { name: full ? 'Пройти весь сайт' : 'Показать этот экран', exact: true }).click();
 await expect(page.locator('.tour-dialog')).toBeVisible();
}
async function jump(page: Page, title: string) {
 const select = page.getByRole('combobox', { name: 'Шаг обучения', exact: true });
 const value = await select.locator('option').filter({ hasText: title }).first().getAttribute('value');
 await select.selectOption(value!);
 await expect(page.locator('#tour-title')).toHaveText(title);
}
async function fits(page: Page) {
 await expect.poll(async () => page.evaluate(() => {
  const card = document.querySelector('.tour-card')?.getBoundingClientRect();
  const target = document.querySelector('.tour-outline')?.getBoundingClientRect();
  return !!card && !!target && card.x >= 0 && card.y >= 0 && card.right <= innerWidth + 1 && card.bottom <= innerHeight + 1 && target.width > 10 && target.height > 10 && target.x >= 0 && target.y >= 0 && target.right <= innerWidth + 1 && target.bottom <= innerHeight + 1;
 })).toBe(true);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
function watchMutations(page: Page) {
 const writes: string[] = [];
 page.on('request', request => { if (request.url().includes('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(request.method() + ' ' + new URL(request.url()).pathname); });
 return writes;
}
async function allSteps(page: Page) {
 const titles = await page.getByRole('combobox', { name: 'Шаг обучения', exact: true }).locator('option').allTextContents();
 for (let i = 0; i < titles.length; i++) {
  await expect(page.locator('.tour-card-header')).toContainText(`Шаг ${i + 1} из ${titles.length}`);
  await expect(page.locator('#tour-title')).toHaveText(titles[i].replace(/^\d+\. /, ''));
  await fits(page);
  await page.locator('[data-tour-next]').click();
 }
 await expect(page.locator('.tour-dialog')).toHaveCount(0);
 return titles.join('\n');
}

test('doctor tour covers the working screens without changing records or receipts', async ({ browser }, testInfo) => {
 const x = await setup(browser);
 try {
  const before = await state(x.doctor);
  const page = await x.doctor.newPage(); await page.goto('/doctor/overview');
  const writes = watchMutations(page);
  await start(page);
  await jump(page, 'Диагнозы и препараты от ИИ');
  await expect(page).toHaveURL(new RegExp('/doctor/visit/' + x.visitId + '$'));
  await fits(page);
  await page.screenshot({ path: testInfo.outputPath('doctor-tour.png') });
  await jump(page, 'Добро пожаловать в обучение');
  const titles = await allSteps(page);
  for (const title of ['Создание карточки', 'Медицинские сведения', 'Выбрать лекарство', 'Текст и голосовые сообщения', 'Ответ и завершение SOS', 'Уведомления на телефон']) expect(titles).toContain(title);
  await expect(page).toHaveURL(/\/doctor\/overview$/);
  await expect(page.getByRole('button', { name: 'Обучение по сайту', exact: true })).toBeFocused();
  expect(writes).toEqual([]);
  const after = await state(x.doctor);
  for (const key of ['patients', 'visits', 'prescriptions', 'entries', 'marks', 'sosEvents', 'messages', 'settings', 'notifications']) expect(after[key]).toEqual(before[key]);
 } finally { await x.close(); }
});

test('skipping from chat or SOS returns home before releasing read receipts', async ({ browser }) => {
 const x = await setup(browser);
 try {
  const page = await x.doctor.newPage(); await page.goto('/doctor/overview');
  const writes = watchMutations(page);
  for (const title of ['Переписка', 'Ответ и завершение SOS']) {
   await start(page); await jump(page, title);
   await expect(page).toHaveURL(title === 'Переписка' ? /\/doctor\/messages$/ : /\/doctor\/sos$/);
   await page.getByRole('button', { name: 'Пропустить', exact: true }).click();
   await expect(page).toHaveURL(/\/doctor\/overview$/);
   await expect(page.locator('.tour-dialog')).toHaveCount(0);
  }
  expect(writes).toEqual([]);
  const s = await state(x.doctor);
  expect(s.sosEvents[0].delivered).toBeNull();
  expect(s.messages.every((m: { readAt: string | null }) => m.readAt === null)).toBe(true);
  // Normal work still marks a deliberately opened SOS as read.
  await page.goto('/doctor/sos');
  await expect.poll(async () => (await state(x.doctor)).sosEvents[0].delivered).not.toBeNull();
 } finally { await x.close(); }
});

test('current screen tour keeps unsaved visit text and works with keyboard and restart', async ({ browser }) => {
 const x = await setup(browser);
 try {
  const page = await x.doctor.newPage(); await page.goto(`/doctor/visit/${x.visitId}`);
  await page.getByLabel('Жалобы, анамнез и заметки · видны только врачу').fill('Несохранённая заметка врача');
  await page.getByLabel('Подтверждаемый план для пациента').fill('Несохранённый план');
  await page.getByLabel('Исходный текст для помощника').fill('Несохранённый исходный текст');
  const writes = watchMutations(page);
  await page.getByRole('button', { name: 'Обучение по сайту', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Пройти весь сайт', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Показать этот экран', exact: true }).click();
  await page.locator('[data-tour-next]').click();
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.locator('#tour-title')).toHaveText('Итоги и внутренние заметки');
  for (let i = 0; i < 9; i++) {
   await page.keyboard.press('Tab');
   expect(await page.evaluate(() => document.querySelector('.tour-dialog')?.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('.tour-dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Обучение по сайту', exact: true })).toBeFocused();
  await expect(page).toHaveURL(new RegExp('/doctor/visit/' + x.visitId + '$'));
  await expect(page.getByLabel('Жалобы, анамнез и заметки · видны только врачу')).toHaveValue('Несохранённая заметка врача');
  await expect(page.getByLabel('Подтверждаемый план для пациента')).toHaveValue('Несохранённый план');
  await expect(page.getByLabel('Исходный текст для помощника')).toHaveValue('Несохранённый исходный текст');
  await start(page, false);
  await page.getByRole('button', { name: 'Закрыть обучение', exact: true }).click();
  expect(writes).toEqual([]);
 } finally { await x.close(); }
});

test('mobile patient tour covers every section without diary, medication, SOS or message changes', async ({ browser }, testInfo) => {
 const x = await setup(browser);
 try {
  const before = await state(x.patient);
  const page = await x.patient.newPage(); await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/patient/today');
  const writes = watchMutations(page);
  await start(page);
  await jump(page, 'Отметки о приёме'); await expect(page).toHaveURL(/\/patient\/plan$/);
  await fits(page); await page.screenshot({ path: testInfo.outputPath('patient-tour-mobile.png') });
  await page.setViewportSize({ width: 320, height: 568 }); await fits(page);
  await page.setViewportSize({ width: 844, height: 390 }); await fits(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await jump(page, 'Добро пожаловать в обучение');
  const titles = await allSteps(page);
  for (const title of ['Дневник самочувствия', 'Голосовая заметка', 'Назначения врача', 'Ваша динамика', 'Текст и голосовые сообщения', 'SOS · нужна помощь']) expect(titles).toContain(title);
  await expect(page).toHaveURL(/\/patient\/today$/);
  expect(writes).toEqual([]);
  const after = await state(x.patient);
  for (const key of ['patients', 'entries', 'marks', 'sosEvents', 'messages', 'settings', 'notifications']) expect(after[key]).toEqual(before[key]);
 } finally { await x.close(); }
});

test('empty account tour explains unavailable sections and creates no patient or visit', async ({ browser }) => {
 const x = await setup(browser, false);
 try {
  const page = await x.doctor.newPage(); await page.goto('/doctor/overview');
  await page.getByRole('button', { name: 'Обучение по сайту', exact: true }).click();
  await page.getByRole('button', { name: 'Пропустить обучение', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const writes = watchMutations(page);
  await start(page);
  const titles = await allSteps(page);
  expect(titles).toContain('Голос и заполнение карточки');
  expect(writes).toEqual([]);
  const s = await state(x.doctor); expect(s.patients).toEqual([]); expect(s.visits).toEqual([]);
 } finally { await x.close(); }
});
