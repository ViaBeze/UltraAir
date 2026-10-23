import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, useApp } from './state';
import { applicationKey, clearBrowserPush, needsHomeScreen, pushRegistration, supportsPush, withTimeout } from './pushClient';
import { Button, ButtonLink, Card, Chip, Icon } from './ui';

type Config = { publicKey: string; enabled: boolean; regular: boolean; urgent: boolean; lastTest: {status: string; last_code: number | null} | null };
type PushState = { config: Config | null; enabled: boolean; checking: boolean; busy: boolean; error: string; permission: NotificationPermission | 'unsupported'; refresh: () => Promise<void>; enable: () => Promise<void>; disable: () => Promise<void>; preferences: (regular: boolean, urgent: boolean) => Promise<void>; test: () => Promise<void> };
const Context = createContext<PushState>(null!);

export function NotificationProvider({children}: {children: ReactNode}) {
 const {user, toast} = useApp();
 const [config, setConfig] = useState<Config | null>(null); const [enabled, setEnabled] = useState(false); const [checking, setChecking] = useState(true);
 const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [permission, setPermission] = useState<PushState['permission']>('unsupported');
 const lock = useRef(false); const userId = useRef(user?.id); userId.current = user?.id;
 const refresh = useCallback(async () => {
  if (!user?.id) { setConfig(null); setEnabled(false); setChecking(false); return; }
  const id = user.id;
  try {
   const next = await api<Config>('/push');
   if (id !== userId.current) return;
   setConfig(next); setPermission(supportsPush() ? Notification.permission : 'unsupported');
   if (!supportsPush() || needsHomeScreen()) { setEnabled(false); return; }
   const registration = await pushRegistration();
   const subscription = await registration.pushManager.getSubscription();
   if (id !== userId.current) return;
   // A previous account or revoked device must not keep receiving its old pushes.
   if (subscription && !next.enabled) await clearBrowserPush();
   setEnabled(next.enabled && !!subscription && Notification.permission === 'granted');
  } finally { if (id === userId.current) setChecking(false); }
 }, [user?.id]);
 useEffect(() => {
  setChecking(true); setConfig(null); setEnabled(false); setError('');
  const check = () => { if (!lock.current) void refresh().catch(() => setError('Не удалось проверить уведомления. Проверьте соединение и повторите.')); };
  check(); window.addEventListener('focus', check);
  return () => window.removeEventListener('focus', check);
 }, [refresh]);
 async function run(fn: () => Promise<void>) {
  if (lock.current) return;
  lock.current = true; setBusy(true); setError('');
  try { await fn(); }
  catch (e) { setError(e instanceof DOMException ? 'Браузер не смог подключить уведомления. Проверьте разрешение для Рядом в настройках телефона и браузера, проверьте интернет и повторите.' : e instanceof Error ? e.message : 'Не удалось настроить уведомления'); }
  finally { lock.current = false; setBusy(false); }
 }
 async function enable() {
  // Permission must be requested synchronously from the user's tap on iOS.
  if (!supportsPush() || needsHomeScreen() || busy || lock.current) return;
  const permissionRequest = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
  await run(async () => {
   const permission = await permissionRequest; setPermission(permission);
   if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Разрешите уведомления для Рядом в настройках браузера или телефона, затем вернитесь сюда.' : 'Разрешение не получено. Нажмите «Включить уведомления» и выберите «Разрешить».');
   const current = config || await api<Config>('/push');
   const registration = await pushRegistration();
   let subscription = await registration.pushManager.getSubscription();
   if (subscription && !current.enabled) { await subscription.unsubscribe(); subscription = null; }
   subscription = subscription || await withTimeout(registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: applicationKey(current.publicKey)}));
   try { await api('/push/subscription', 'POST', subscription.toJSON()); }
   catch (e) { await subscription.unsubscribe().catch(() => {}); throw e; }
   await refresh(); toast('Уведомления подключены на этом устройстве');
  });
 }
 async function disable() { await run(async () => { await api('/push/subscription', 'DELETE'); setEnabled(false); await clearBrowserPush(); await refresh(); toast('Уведомления отключены на этом устройстве'); }); }
 async function preferences(regular: boolean, urgent: boolean) { await run(async () => {
  const previous = config;
  setConfig(old => old && {...old, regular, urgent});
  try { await api('/push/preferences', 'PUT', {regular, urgent}); await refresh(); }
  catch (e) { setConfig(previous); throw e; }
 }); }
 async function test() { await run(async () => { await api('/push/test', 'POST'); setConfig(old => old && {...old, lastTest: {status: 'pending', last_code: null}}); toast('Проверка поставлена в очередь. Проверьте центр уведомлений телефона.'); }); }
 const testStatus = config?.lastTest?.status;
 useEffect(() => {
  if (testStatus !== 'pending' && testStatus !== 'sending') return;
  const timer = setInterval(() => { void refresh().catch(() => {}); }, 3000);
  return () => clearInterval(timer);
 }, [testStatus, refresh]);
 return <Context.Provider value={{config, enabled, checking, busy, error, permission, refresh, enable, disable, preferences, test}}>{children}</Context.Provider>;
}

export function NotificationSettings() {
 const push = useContext(Context); const {user} = useApp(); const install = needsHomeScreen();
 const status = push.config?.lastTest?.status;
 return <Card className="push-settings" id="phone-notifications"><div className="push-heading"><span className="push-icon"><Icon name="bell"/></span><div><h2>Уведомления на телефон</h2><p>Сообщения и SOS, даже когда Рядом закрыт</p></div></div>
  <Chip tone={push.enabled ? 'success' : 'warning'}>{push.checking ? 'Проверяем подключение…' : push.enabled ? 'Включены на этом устройстве' : 'На этом устройстве не включены'}</Chip>
  {install ? <div className="push-help"><h3>Подключить на iPhone или iPad</h3><ol><li>Откройте этот сайт в Safari.</li><li>Нажмите «Поделиться» → «На экран Домой» → «Добавить».</li><li>Откройте «Рядом» с новой иконки, войдите и включите уведомления здесь.</li></ol><p className="small muted">Нужна iOS / iPadOS 16.4 или новее.</p></div> : !supportsPush() ? <p>Этот браузер не поддерживает уведомления. Откройте Рядом в актуальной версии Chrome, Firefox или Safari. На iPhone добавьте сайт на экран «Домой».</p> : <>
   {push.permission === 'denied' && <p className="push-help">Уведомления заблокированы. Разрешите их в настройках сайта в браузере или в настройках телефона → «Уведомления» → «Рядом», затем вернитесь сюда.</p>}
   {push.enabled && <div className="push-preferences"><label className="checkbox"><input type="checkbox" checked={push.config?.urgent ?? true} disabled={push.busy} onChange={e => void push.preferences(push.config?.regular ?? true, e.target.checked)}/><span><strong>SOS · срочные оповещения</strong><small>Новые обращения и сообщения в SOS-чате</small></span></label><label className="checkbox"><input type="checkbox" checked={push.config?.regular ?? true} disabled={push.busy} onChange={e => void push.preferences(e.target.checked, push.config?.urgent ?? true)}/><span><strong>Обычные уведомления</strong><small>{user?.role === 'doctor' ? 'Новые сообщения и записи дневника' : 'Сообщения врача, изменения плана и напоминания'}</small></span></label></div>}
   <div className="push-actions">{push.enabled ? <><Button disabled={push.busy} onClick={() => void push.test()} icon="bell">Проверить уведомление</Button><Button variant="quiet" disabled={push.busy} onClick={() => void push.disable()}>Отключить на устройстве</Button></> : <Button icon="bell" disabled={push.busy || push.checking || push.permission === 'denied'} onClick={() => void push.enable()}>{push.busy ? 'Подключаем…' : 'Включить уведомления'}</Button>}</div>
  </>}
  {status && push.enabled && <p className="small" role="status">{status === 'sent' ? 'Проверка передана службе уведомлений. Посмотрите, появилась ли она на телефоне.' : status === 'pending' || status === 'sending' ? 'Отправляем проверку…' : 'Проверка не доставлена службе уведомлений. Повторите подключение или попробуйте позже.'}</p>}
  {push.error && <div role="alert"><p className="error-text">{push.error}</p><Button variant="quiet" onClick={() => void push.refresh().catch(() => {})}>Проверить подключение</Button></div>}
  <p className="small muted">Подключайте каждый телефон отдельно. На экране блокировки не показываем имя пациента и текст переписки. Звук и вибрация зависят от настроек телефона; режим «Не беспокоить» может заглушать SOS.</p>
 </Card>;
}

export function PhoneNotificationNotice() {
 const push = useContext(Context); const {user} = useApp();
 if (push.checking || push.enabled || user?.role !== 'doctor') return null;
 return <div className="push-notice"><Icon name="bell"/><div><strong>Получайте SOS и сообщения на телефон</strong><p>Подключите уведомления в настройках на нужном устройстве.</p></div><ButtonLink to="/doctor/settings#phone-notifications" variant="secondary">Настроить</ButtonLink></div>;
}
