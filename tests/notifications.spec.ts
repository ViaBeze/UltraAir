import {test, expect} from '@playwright/test';
import type {BrowserContext} from '@playwright/test';
import {createECDH, randomBytes} from 'node:crypto';

const headers = {'X-Ryadom': '1'};
const password = 'Notification-test-password-123!';
async function doctor(context: BrowserContext) {
 const login = 'notifications.' + crypto.randomUUID();
 const response = await context.request.post('/api/auth/register', {headers, data: {login, name: 'Врач Уведомления', password, consent: true}});
 expect(response.ok()).toBeTruthy(); return login;
}

// Only the browser's external push-provider subscription is mocked. Authentication,
// preferences, device cookies, logout and durable jobs use the real local API.
async function mockProvider(context: BrowserContext) {
 const key = createECDH('prime256v1'); key.generateKeys();
 const data = {endpoint: 'https://fcm.googleapis.com/fcm/send/' + crypto.randomUUID(), keys: {p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url')}};
 await context.grantPermissions(['notifications']);
 await context.addInitScript(data => {
  const sub = {endpoint: data.endpoint, expirationTime: null, toJSON: () => data, unsubscribe: async () => {localStorage.removeItem('test-push'); return true;}};
  PushManager.prototype.getSubscription = async () => localStorage.getItem('test-push') ? sub as unknown as PushSubscription : null;
  PushManager.prototype.subscribe = async () => {localStorage.setItem('test-push', '1'); return sub as unknown as PushSubscription;};
 }, data);
}

test('phone subscription, preferences, test and logout belong to this device', async ({page, context}) => {
 const login = await doctor(context); await mockProvider(context);
 await page.goto('/doctor/settings');
 await page.getByRole('button', {name: 'Включить уведомления', exact: true}).click();
 await expect(page.getByText('Включены на этом устройстве', {exact: true})).toBeVisible();
 await page.getByRole('checkbox', {name: /Обычные уведомления/}).uncheck();
 await expect.poll(async () => (await (await context.request.get('/api/push')).json()).regular).toBe(false);
 await page.reload();
 await expect(page.getByRole('checkbox', {name: /Обычные уведомления/})).not.toBeChecked();
 await expect(page.getByRole('checkbox', {name: /SOS · срочные/})).toBeChecked();
 await page.getByRole('button', {name: 'Проверить уведомление', exact: true}).click();
 await expect.poll(async () => (await (await context.request.get('/api/push')).json()).lastTest?.status).toBe('pending');
 await page.getByRole('button', {name: 'Выйти', exact: true}).click();
 await expect(page).toHaveURL(/login/);
 await page.getByRole('textbox', {name: 'Логин', exact: true}).fill(login); await page.getByLabel('Пароль', {exact: true}).fill(password);
 await page.getByRole('button', {name: 'Войти', exact: true}).click();
 await expect(page).toHaveURL(/doctor\/(overview|settings)/);
 expect((await (await context.request.get('/api/push')).json()).enabled).toBe(false);
 await page.goto('/doctor/overview');
 await expect(page.getByText('Получайте SOS и сообщения на телефон')).toBeVisible();
});

test('iPhone browser explains Home Screen installation without requesting permission', async ({page, context}) => {
 await doctor(context);
 await context.addInitScript(() => Object.defineProperty(navigator, 'userAgent', {get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1'}));
 await page.setViewportSize({width: 390, height: 844});
 await page.goto('/doctor/settings');
 await expect(page.getByRole('heading', {name: 'Подключить на iPhone или iPad'})).toBeVisible();
 await expect(page.getByRole('button', {name: 'Включить уведомления', exact: true})).toHaveCount(0);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('notification deep link resumes after login and background worker displays SOS', async ({page, context}) => {
 const login = await doctor(context);
 await context.request.post('/api/auth/logout', {headers});
 await page.goto('/doctor/sos?id=test-deep-link');
 await expect(page).toHaveURL(/login/);
 await page.getByRole('textbox', {name: 'Логин', exact: true}).fill(login); await page.getByLabel('Пароль', {exact: true}).fill(password);
 await page.getByRole('button', {name: 'Войти', exact: true}).click();
 await expect(page).toHaveURL(/doctor\/sos\?id=test-deep-link/);
 await context.grantPermissions(['notifications']);
 const cdp = await context.newCDPSession(page);
 let registrationId = '';
 cdp.on('ServiceWorker.workerRegistrationUpdated', (event: {registrations: {scopeURL: string; registrationId: string}[]}) => {
  const registration = event.registrations.find(r => r.scopeURL === new URL(page.url()).origin + '/');
  if (registration) registrationId = registration.registrationId;
 });
 await cdp.send('ServiceWorker.enable');
 await page.evaluate(async () => {await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;});
 await expect.poll(() => registrationId).not.toBe('');
 await cdp.send('ServiceWorker.deliverPushMessage', {origin: new URL(page.url()).origin, registrationId, data: JSON.stringify({id: 'browser-sos', title: 'Рядом · Новое SOS-обращение', body: 'Откройте Рядом, чтобы ответить.', link: '/doctor/sos?id=browser-sos', tag: 'browser-sos', urgent: true})});
 await expect.poll(async () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => n.title))).toContain('Рядом · Новое SOS-обращение');
 const alert = await page.evaluate(async () => {
  const item = (await (await navigator.serviceWorker.ready).getNotifications()).find(n => n.tag === 'browser-sos')!;
  return {link: item.data.link, requireInteraction: item.requireInteraction, body: item.body};
 });
 expect(alert.link).toBe(new URL('/doctor/sos?id=browser-sos', page.url()).href);
 expect(alert.requireInteraction).toBe(true);
 await cdp.detach();
});
