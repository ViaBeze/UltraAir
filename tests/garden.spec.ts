import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext } from '@playwright/test';
const headers = { 'X-Ryadom': '1' };
const password = 'Garden-test-password-123!';
const baseURL = process.env.RYADOM_TEST_URL || 'http://127.0.0.1:4173';

async function setup(browser: Browser) {
 const doctor = await browser.newContext({ baseURL }); const patient = await browser.newContext({ baseURL });
 expect((await doctor.request.post('/api/auth/register', { headers, data: { login: 'garden.' + crypto.randomUUID(), name: 'Врач Сад', password, consent: true } })).ok()).toBeTruthy();
 const created = await doctor.request.post('/api/patients', { headers, data: { name: 'Анна Тестовая', birth: '1995-03-12', consent: true } }); expect(created.ok()).toBeTruthy(); const access = await created.json();
 expect((await patient.request.post('/api/auth/activate', { headers, data: { token: access.inviteUrl.split('#')[1], password, consent: true } })).ok()).toBeTruthy();
 const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
 const visit = await (await doctor.request.post('/api/visits', { headers, data: { patientId: access.id, scheduled: new Date().toISOString() } })).json();
 expect((await doctor.request.put(`/api/visits/${visit.id}`, { headers, data: { version: 1, confirm: true, plan: 'План для проверки сада', prescriptions: [{ name: 'Тестовое назначение', dose: 'По назначению врача', times: ['09:00'], start: date }] } })).ok()).toBeTruthy();
 return { doctor, patient, access, date, p: await patient.newPage(), d: await doctor.newPage() };
}
async function state(context: BrowserContext) { return (await context.request.get('/api/state')).json(); }

test('patient plant, earned drops and alcohol reach the doctor and survive reload', async ({ browser }) => {
 const x = await setup(browser); const { p,d } = x;
 await p.goto('/patient/today'); await expect(p.getByRole('heading', { name: 'Мой василёк', exact: true })).toBeVisible(); await expect(p.getByRole('button', { name: /Полить|Повторить полив/ })).toHaveCount(0); await expect(p.getByRole('progressbar')).toHaveAttribute('value','0');
 await p.getByRole('button', { name: /Выбрать растение/ }).click(); await p.getByRole('button', { name: /Кактус Тихая сила/ }).click(); await p.getByRole('button', { name: 'Выбрать: Кактус', exact: true }).click();
 await expect(p.getByRole('heading', { name: 'Мой кактус', exact: true })).toBeVisible();
 await d.goto('/doctor/patients'); await expect(d.getByRole('link', { name: 'Открыть карточку: Анна Тестовая' })).toContainText('Кактус · выбор пациента');
 await p.goto('/patient/diary'); await p.getByRole('button', { name: '4 Хорошо', exact: true }).click(); await p.getByRole('button', { name: /Далее — сон/ }).click(); await p.getByLabel('Сколько часов вы спали?').fill('7.5'); await p.getByLabel('Сколько у вас энергии сейчас?').selectOption('7');
 await p.getByRole('radio', { name: 'Да, употреблял(а) алкоголь', exact: true }).check(); await p.getByLabel('Что вы пили?').fill('Вино'); await p.getByLabel('Количество, мл').fill('150'); await p.getByLabel('Крепость, %').fill('12'); await p.getByLabel('Примерное время').fill('20:30'); await p.getByLabel('Комментарий об алкоголе').fill('За ужином');
 await p.getByRole('button', { name: 'Сохранить запись', exact: true }).click(); await expect(p.getByRole('heading', { name: 'Запись сохранена' })).toBeVisible(); await expect(p.locator('.diary-reward')).toContainText('+3 капли');
 await p.getByRole('link', { name: 'К моему растению', exact: true }).first().click(); await expect(p.getByLabel('Капель роста: 3', { exact: true })).toBeVisible();
 await expect(p.getByRole('progressbar', { name: 'Рост растения в капельках' })).toHaveAttribute('value','3');
 await p.goto('/patient/plan'); await p.getByRole('button', { name: 'Пропущено', exact: true }).click(); await expect(p.getByRole('status')).toContainText('Отметка сохранена'); expect((await state(x.patient)).patients[0].garden.growth).toBe(3);
 await p.getByRole('button', { name: 'Отметить приём', exact: true }).click(); await expect.poll(async () => (await state(x.patient)).patients[0].garden.growth).toBe(4);
 await d.goto(`/doctor/patients/${x.access.id}?tab=diary`); await expect(d.locator('.alcohol-record')).toContainText('Алкоголь: есть отметка'); await expect(d.locator('.alcohol-record')).toContainText('Вино · 150 мл · 12% · около 20:30'); await expect(d.locator('.alcohol-record')).toContainText('За ужином');
 await p.goto('/patient/diary'); await p.getByRole('button', { name: /Далее — сон/ }).click(); await expect(p.getByLabel('Количество, мл')).toHaveValue('150'); await p.getByRole('radio', { name: 'Нет, сегодня не было', exact: true }).check(); await p.getByRole('button', { name: 'Сохранить запись', exact: true }).click(); await expect(p.getByRole('heading', { name: 'Запись сохранена' })).toBeVisible(); await expect(p.locator('.diary-reward')).toHaveCount(0);
 await expect(d.locator('.alcohol-record')).toContainText('Алкоголь: не было', { timeout: 12000 }); await expect(d.locator('.alcohol-record')).not.toContainText('Вино');
 await p.goto('/patient/today'); await p.reload(); await expect(p.getByRole('heading', { name: 'Мой кактус', exact: true })).toBeVisible(); await expect(p.getByRole('progressbar')).toHaveAttribute('value','4'); await expect(p.getByLabel('Капель роста: 4', { exact: true })).toBeVisible(); await expect(p.getByRole('button', { name: /Полить|Повторить полив/ })).toHaveCount(0);
 await d.goto('/doctor/patients'); await d.getByRole('button', { name: 'Список', exact: true }).click(); await expect(d.locator('.patient-row').getByRole('img', { name: 'Кактус · Семя', exact: true })).toBeVisible(); await d.getByLabel('Найти пациента').fill('несуществующее имя'); await expect(d.getByRole('heading', { name: 'Пациенты не найдены' })).toBeVisible();
 await x.patient.close(); await x.doctor.close();
});

test('mobile automatic growth, all species and retry after a lost diary response', async ({ browser }) => {
 const x = await setup(browser); const { p,d } = x;
 await p.setViewportSize({ width: 390, height: 844 });
 let loseResponse = true;
 await p.route('**/api/diary', async route => {
  if (loseResponse) { loseResponse = false; await route.fetch(); await route.abort('connectionfailed'); }
  else await route.continue();
 });
 await p.goto('/patient/diary'); await p.getByRole('button', { name: '4 Хорошо', exact: true }).click(); await p.getByRole('button', { name: /Далее — сон/ }).click(); await p.getByLabel('Сколько часов вы спали?').fill('7'); await p.getByLabel('Сколько у вас энергии сейчас?').selectOption('6');
 await p.getByRole('button', { name: 'Сохранить запись', exact: true }).click(); await expect(p.locator('.diary-form').getByRole('alert')).toContainText('Нет связи');
 await p.getByRole('button', { name: 'Сохранить запись', exact: true }).click(); await expect(p.getByRole('heading', { name: 'Запись сохранена' })).toBeVisible(); expect((await state(x.patient)).patients[0].garden.growth).toBe(3);
 const prior = new Date(); prior.setDate(prior.getDate()-1); const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(prior);
 expect((await x.patient.request.put('/api/diary', { headers, data: { date, score: 4, sleep: 6, energy: 3 } })).ok()).toBeTruthy();
 await p.goto('/patient/today'); await expect(p.getByRole('progressbar')).toHaveAttribute('value','6'); await expect(p.getByRole('img', { name: 'Василёк · Росток', exact: true })).toBeVisible();
 await expect(p.getByRole('button', { name: /Полить|Повторить полив/ })).toHaveCount(0);
 const before = (await state(x.patient)).patients[0].garden;
 expect((await x.patient.request.post('/api/garden/water', { headers, data: { id: crypto.randomUUID() } })).status()).toBe(410);
 expect((await state(x.patient)).patients[0].garden).toEqual(before);
 for (const name of ['Кактус','Ромашка','Монстера','Василёк']) {
  await p.getByRole('button', { name: /Выбрать растение/ }).click(); await p.locator('.plant-choice').filter({ has: p.getByText(name, { exact: true }) }).click(); await p.getByRole('button', { name: `Выбрать: ${name}`, exact: true }).click(); await expect(p.getByRole('dialog')).toHaveCount(0);
  expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
 }
 await p.getByRole('button', { name: 'Как растёт растение', exact: true }).click(); await expect(p.getByRole('dialog')).toBeVisible(); await p.getByRole('button', { name: 'Всё понятно' }).click();
 await p.goto('/patient/diary'); await p.getByRole('button', { name: /Далее — сон/ }).click(); await p.getByRole('radio', { name: 'Да, употреблял(а) алкоголь' }).check(); expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
 await p.screenshot({ path: 'test-results/garden-mobile-diary.png', fullPage: true });
 await d.setViewportSize({ width: 390, height: 844 }); await d.goto('/doctor/patients'); await expect(d.locator('.patient-flower')).toHaveCount(1); await expect(d.getByRole('img', { name: 'Василёк · Росток', exact: true })).toBeVisible(); expect(await d.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
 await p.goto('/patient/today'); await p.screenshot({ path: 'test-results/garden-mobile-patient.png', fullPage: true }); await d.screenshot({ path: 'test-results/garden-mobile-doctor.png', fullPage: true });
 await p.setViewportSize({ width: 1440, height: 1024 }); await p.screenshot({ path: 'test-results/garden-desktop-patient.png', fullPage: true });
 await d.setViewportSize({ width: 1440, height: 1024 }); await d.goto('/doctor/overview'); await d.screenshot({ path: 'test-results/garden-desktop-doctor.png', fullPage: true });
 await x.patient.close(); await x.doctor.close();
});
