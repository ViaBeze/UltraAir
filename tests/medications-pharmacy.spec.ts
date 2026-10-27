import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';

const headers = { 'X-Ryadom': '1' };
const password = 'Test-password-long-123!';
const baseURL = process.env.RYADOM_TEST_URL || 'http://127.0.0.1:4173';
async function pair(browser: Browser) {
 const doctor = await browser.newContext({ baseURL }); const patient = await browser.newContext({ baseURL });
 const registered = await doctor.request.post('/api/auth/register', { headers, data: { login: `pharmacy.${crypto.randomUUID()}`, password, name: 'Врач Аптека', consent: true } });
 expect(registered.ok()).toBeTruthy();
 const created = await doctor.request.post('/api/patients', { headers, data: { name: 'Пациент Аптека', birth: '1990-02-12', consent: true } });
 expect(created.ok()).toBeTruthy(); const access = await created.json();
 expect((await patient.request.post('/api/auth/activate', { headers, data: { token: access.inviteUrl.split('#')[1], password, consent: true } })).ok()).toBeTruthy();
 return { doctor, patient, id: access.id, d: await doctor.newPage(), p: await patient.newPage() };
}

test('card edits and prescriptions with quotations work without creating a visit', async ({ browser }) => {
 const x = await pair(browser);
 await x.d.goto(`/doctor/patients/${x.id}`);
 await x.d.getByRole('link', { name: 'Изменить данные', exact: true }).click();
 await x.d.getByLabel('Телефон', { exact: true }).fill('+7 999 111 22 33');
 await x.d.getByRole('button', { name: 'Сохранить данные' }).click();
 await expect(x.d.getByText('+7 999 111 22 33', { exact: true })).toBeVisible();
 await x.d.locator('.card').filter({ has: x.d.getByRole('heading', { name: 'Диагнозы и лечение', exact: true }) }).getByRole('link', { name: 'Изменить' }).click();
 await x.d.getByLabel('Диагноз и статус', { exact: true }).fill('Тестовый диагноз вне приёма');
 await x.d.getByLabel('Аллергии и нежелательные реакции', { exact: true }).fill('Тестовая запись об аллергии');
 await x.d.getByRole('button', { name: 'Сохранить карточку', exact: true }).click();
 await expect(x.d.getByText('Тестовый диагноз вне приёма', { exact: true })).toBeVisible();
 await expect(x.d.getByText('Тестовая запись об аллергии', { exact: true })).toBeVisible();
 await x.d.getByRole('link', { name: 'Редактировать препараты' }).click();
 await x.d.getByRole('button', { name: '+ Добавить препарат', exact: true }).click();
 await x.d.getByLabel('Препарат 1', { exact: true }).fill('Тестовый препарат');
 await x.d.getByLabel('Дозировка', { exact: true }).fill('Назначенная врачом доза');
 await x.d.getByLabel('Область применения', { exact: true }).fill('Тестовая цель назначения');
 await x.d.getByLabel('Побочные эффекты', { exact: true }).fill('Описание из инструкции');
 await x.d.getByLabel('Совместимость с другими препаратами', { exact: true }).fill('Проверить сочетание с текущими препаратами');
 await x.d.getByText('+ Прикрепить цитату', { exact: true }).click();
 await x.d.getByLabel('Название документа', { exact: true }).fill('Тестовая инструкция');
 await x.d.getByLabel('Прямая ссылка на документ').fill('https://www.rlsnet.ru/drugs/test');
 await x.d.getByLabel('Раздел или страница').fill('Взаимодействия');
 await x.d.getByLabel('Дословная цитата').fill('Тестовая цитата для проверки сохранения.');
 await x.d.getByRole('button', { name: 'Прикрепить цитату к записи' }).click();
 await x.d.getByRole('button', { name: 'Сохранить назначения', exact: true }).click();
 await expect(x.d).toHaveURL(new RegExp(`/doctor/patients/${x.id}$`));
 await expect(x.d.getByText('Тестовая цель назначения', { exact: true })).toBeVisible();
 await x.d.reload();
 await expect(x.d.getByText('Тестовая цитата для проверки сохранения.', { exact: true })).toBeVisible();
 const state = await (await x.doctor.request.get('/api/state')).json();
 expect(state.visits).toEqual([]); expect(state.prescriptions[0].visitId).toBeNull();
 await x.p.goto('/patient/plan');
 await expect(x.p.getByRole('heading', { name: 'Тестовый препарат', exact: true })).toBeVisible();
 await x.p.getByText('О препарате и взаимодействиях').click();
 await expect(x.p.getByText('Описание из инструкции', { exact: true })).toBeVisible();
 await expect(x.p.getByRole('link', { name: 'Открыть цитату в источнике' })).toHaveAttribute('href', /^https:\/\/www\.rlsnet\.ru\/drugs\/test#:~:text=/);
 await x.p.getByRole('button', { name: 'Отметить приём', exact: true }).click();
 await expect(x.p.getByText('Приём отмечен', { exact: true })).toBeVisible();
 await x.d.getByRole('link', { name: 'Редактировать препараты' }).click();
 await x.d.getByLabel('Дозировка', { exact: true }).fill('Уточнённая доза');
 await x.d.getByRole('button', { name: 'Сохранить назначения', exact: true }).click();
 await x.p.reload(); await expect(x.p.getByText('Уточнённая доза', { exact: true })).toBeVisible();
 await x.p.getByRole('button', { name: 'История', exact: true }).click();
 await expect(x.p.getByText(/09:00 · Принято/)).toBeVisible();
 await x.doctor.close(); await x.patient.close();
});

test('clinical recommendation quotation is saved in the visit and patient card', async ({ browser }) => {
 const x = await pair(browser);
 const visit = await (await x.doctor.request.post('/api/visits', { headers, data: { patientId: x.id, scheduled: new Date().toISOString() } })).json();
 await x.d.goto(`/doctor/visit/${visit.id}`);
 await x.d.getByLabel('Подтверждаемый план для пациента').fill('Подтверждённый план');
 await x.d.getByText('+ Прикрепить цитату', { exact: true }).click();
 await x.d.getByLabel('Источник цитаты').selectOption('Минздрав');
 await x.d.getByLabel('Название документа', { exact: true }).fill('Тест клинической рекомендации');
 await x.d.getByLabel('Прямая ссылка на документ').fill('https://cr.minzdrav.gov.ru/view-cr/test#section-3');
 await x.d.getByLabel('Раздел или страница').fill('Раздел 3');
 await x.d.getByLabel('Дословная цитата').fill('Проверочный фрагмент рекомендации.');
 await x.d.getByRole('button', { name: 'Прикрепить цитату к записи' }).click();
 await x.d.getByRole('button', { name: 'Сохранить черновик' }).click();
 await expect(x.d.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
 expect(JSON.stringify(await (await x.patient.request.get('/api/state')).json())).not.toContain('Проверочный фрагмент');
 await x.d.getByRole('button', { name: 'Подтвердить и сохранить' }).click();
 await x.d.getByRole('button', { name: 'Да, подтвердить план' }).click();
 await expect(x.d.getByText('Подтверждено врачом', { exact: true })).toBeVisible();
 await x.d.goto(`/doctor/patients/${x.id}`);
 await expect(x.d.getByText('Проверочный фрагмент рекомендации.', { exact: true })).toBeVisible();
 await x.p.goto('/patient/plan');
 await expect(x.p.getByText('Проверочный фрагмент рекомендации.', { exact: true })).toBeVisible();
 await expect(x.p.getByRole('link', { name: 'Открыть цитату в источнике' })).toHaveAttribute('href', /^https:\/\/cr\.minzdrav\.gov\.ru\/view-cr\/test#section-3:~:text=/);
 await x.doctor.close(); await x.patient.close();
});

test('older visit reloads card prescriptions before confirmation and keeps unsaved notes', async ({ browser }) => {
 const x = await pair(browser);
 const visit = await (await x.doctor.request.post('/api/visits', { headers, data: { patientId: x.id, scheduled: new Date().toISOString() } })).json();
 expect((await x.doctor.request.put(`/api/patients/${x.id}/prescriptions`, { headers, data: { version: 1, prescriptions: [
  { name: 'Новое назначение из карточки', dose: 'Доза врача', times: ['09:00'], start: '2026-10-27' },
 ] } })).ok()).toBeTruthy();
 await x.doctor.route('**/api/state', async route => {
  const response = await route.fetch(); const state = await response.json();
  // Simulate a visit created before prescription snapshots were introduced.
  for (const item of state.visits) if (item.id === visit.id) delete item.patientVersion;
  await route.fulfill({ response, json: state });
 });
 await x.d.goto(`/doctor/visit/${visit.id}`);
 await x.d.getByLabel('Подтверждаемый план для пациента').fill('Сохранить этот текст плана');
 await x.d.getByRole('button', { name: 'Загрузить актуальные назначения', exact: true }).click();
 await expect(x.d.getByLabel('Препарат 1', { exact: true })).toHaveValue('Новое назначение из карточки');
 await expect(x.d.getByLabel('Подтверждаемый план для пациента')).toHaveValue('Сохранить этот текст плана');
 await x.d.getByRole('button', { name: 'Подтвердить и сохранить', exact: true }).click();
 await x.d.getByRole('button', { name: 'Да, подтвердить план', exact: true }).click();
 await expect(x.d.getByText('Подтверждено врачом', { exact: true })).toBeVisible();
 const state = await (await x.patient.request.get('/api/state')).json();
 expect(state.prescriptions.filter((m: { active: boolean }) => m.active).map((m: { name: string }) => m.name)).toEqual(['Новое назначение из карточки']);
 await x.doctor.close(); await x.patient.close();
});

test('pharmacy map, honest stock labels, course calculation and mobile navigation', async ({ browser }) => {
 const x = await pair(browser);
 // Do not download map tiles or call public map APIs during automated tests.
 await x.patient.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=', 'base64') }));
 await x.patient.route('**/api/pharmacies/search', route => route.fulfill({ json: {
  inventoryConnected: true, checkedAt: new Date().toISOString(), warning: '', items: [
   { id: 'offer:one', name: 'Аптека с предложением', address: 'Тестовая улица, 1', lat: 55.756, lon: 37.618, distance: 120, source: 'Тестовый источник', url: 'https://pharmacy.example/offer', availability: 'available', price: 112.34, medicine: 'Авиандр', form: 'Тестовая упаковка', packageSize: 30, updatedAt: new Date().toISOString() },
   { id: 'osm:1', name: 'Аптека без остатков', address: 'Тестовая улица, 2', lat: 55.757, lon: 37.619, distance: 240, source: 'OpenStreetMap', url: 'https://www.openstreetmap.org/node/1', availability: 'unknown', price: null, updatedAt: null },
  ],
 } }));
 await x.p.setViewportSize({ width: 390, height: 844 }); await x.p.goto('/patient/today');
 await x.p.getByRole('navigation', { name: 'Мобильная навигация' }).getByRole('link', { name: 'Аптека', exact: true }).click();
 await expect(x.p.getByRole('heading', { name: 'Аптека', exact: true })).toBeVisible();
 await x.p.getByRole('button', { name: 'Найти аптеки', exact: true }).click();
 await expect(x.p.getByRole('region', { name: 'Карта аптек' })).toBeVisible();
 await expect(x.p.getByText('Наличие уточняется', { exact: true })).toBeVisible();
 await x.p.getByLabel('С подтверждённым наличием').check();
 await expect(x.p.getByRole('heading', { name: 'Аптека без остатков', exact: true })).toHaveCount(0);
 await x.p.getByRole('button', { name: 'Добавить в расчёт', exact: true }).click();
 await x.p.getByLabel('Способ расчёта').selectOption('course');
 await expect(x.p.getByLabel('Единиц в упаковке', { exact: true })).toHaveValue('30');
 await x.p.getByLabel('Единиц в сутки по назначению').fill('2');
 await x.p.getByLabel('Длительность курса, дней').fill('31');
 await expect(x.p.locator('.cost-total')).toContainText('337,02');
 // Fractional daily units must not round an exact one-pack course to two packs.
 await x.p.getByLabel('Единиц в упаковке', { exact: true }).fill('14');
 await x.p.getByLabel('Единиц в сутки по назначению').fill('0.14');
 await x.p.getByLabel('Длительность курса, дней').fill('100');
 await expect(x.p.locator('.cost-total')).toContainText('112,34');
 await x.p.getByRole('button', { name: '+ Препарат в расчёт' }).click();
 await expect(x.p.locator('.cost-total')).toContainText('Промежуточная сумма');
 await expect(x.p.locator('.cost-total')).toContainText('Не рассчитано позиций: 1');
 await x.p.locator('.cost-row').last().getByLabel('Название препарата и упаковка').fill('Второй препарат');
 await x.p.locator('.cost-row').last().getByLabel('Цена упаковки, ₽').fill('-5');
 await expect(x.p.locator('.cost-total')).toContainText('Не рассчитано позиций: 1');
 for (const width of [390, 1440]) {
  await x.p.setViewportSize({ width, height: 900 });
  expect(await x.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  await x.p.screenshot({ path: `test-results/pharmacy-${width}.png`, fullPage: true });
 }
 await x.doctor.close(); await x.patient.close();
});
