import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from './state';
import { Button, Icon, Modal } from './ui';
import { commonSteps, fullTour, screenSteps } from './tourSteps';
import type { TourStep } from './tourSteps';
import './tour.css';

type TourSession = { steps: TourStep[]; index: number; full: boolean; origin: string; scroll: number; userId: string };
const Context = createContext({ active: false, open: () => {} });
export const useTour = () => useContext(Context);

export function TourProvider({ children }: { children: ReactNode }) {
 const { state, user } = useApp(); const location = useLocation(); const navigate = useNavigate();
 const [chooser, setChooser] = useState(false); const [session, setSession] = useState<TourSession | null>(null);
 const pendingRoute = useRef<string | null>(null);
 const returning = useRef<{ route: string; scroll: number } | null>(null);
 const home = user?.role === 'doctor' ? '/doctor/overview' : '/patient/today';
 const currentUrl = location.pathname + location.search + location.hash;
 const isHome = location.pathname === home;
 const step = session?.steps[session.index];
 function close(returnToStart = true) {
  pendingRoute.current = null;
  if (returnToStart && session?.full && currentUrl !== session.origin) {
   returning.current = { route: session.origin, scroll: session.scroll };
   pendingRoute.current = session.origin;
   navigate(session.origin, { replace: true });
   return;
  }
  returning.current = null;
  const scroll = session?.scroll;
  setSession(null); setChooser(false);
  requestAnimationFrame(() => {
   if (returnToStart && scroll != null) window.scrollTo({ top: scroll, behavior: 'instant' });
   document.querySelector<HTMLElement>('[data-tour="help"]')?.focus({ preventScroll: true });
  });
 }
 function start(full: boolean) {
  if (!user || (full && !isHome)) return;
  const steps = full ? fullTour(state) : [...screenSteps(location.pathname, state), ...commonSteps(user.role)];
  setChooser(false);
  returning.current = null;
  setSession({ steps, index: 0, full, origin: currentUrl, scroll: window.scrollY, userId: user.id });
  if (full && steps[0].route !== currentUrl) { pendingRoute.current = steps[0].route!; navigate(steps[0].route!, { replace: true }); }
 }
 function move(index: number) {
  if (!session) return;
  const next = session.steps[index];
  if (!next) return;
  setSession({ ...session, index });
  if (session.full && next.route !== currentUrl) { pendingRoute.current = next.route!; navigate(next.route!, { replace: true }); }
 }
 useEffect(() => {
  if (!user || (session && user.id !== session.userId)) {
   pendingRoute.current = null; returning.current = null;
   setSession(null); setChooser(false);
  }
 }, [user?.id, session?.userId]);
 useEffect(() => {
  if (returning.current?.route === currentUrl) {
   const scroll = returning.current.scroll;
   returning.current = null; pendingRoute.current = null;
   setSession(null);
   requestAnimationFrame(() => { window.scrollTo({ top: scroll, behavior: 'instant' }); document.querySelector<HTMLElement>('[data-tour="help"]')?.focus({ preventScroll: true }); });
   return;
  }
  if (pendingRoute.current) {
   if (pendingRoute.current === currentUrl) pendingRoute.current = null;
   return;
  }
  if (session && (session.full ? step?.route !== currentUrl : session.origin !== currentUrl)) {
   setSession(null);
  }
 }, [currentUrl, session, step]);
 return <Context.Provider value={{ active: !!session || chooser, open: () => setChooser(true) }}>
  {children}
  {chooser && user && <Modal title="Обучение по сайту" onClose={() => setChooser(false)}>
   <p>Покажем элементы интерфейса и объясним, как ими пользоваться. На каждом шаге можно вернуться назад или пропустить обучение.</p>
   <div className="tour-start-options">
    <Button type="button" onClick={() => start(false)}>Показать этот экран</Button>
    <Button type="button" variant="secondary" disabled={!isHome} onClick={() => start(true)}>Пройти весь сайт</Button>
   </div>
   <p className="small muted">{isHome ? 'Полный обзор пройдёт по разделам вашего кабинета и вернёт на главную страницу.' : 'Полный обзор запускается с главной страницы. Обучение текущего экрана сохраняет введённые здесь данные.'}</p>
   <Button type="button" variant="quiet" onClick={() => setChooser(false)}>Пропустить обучение</Button>
  </Modal>}
  {session && step && createPortal(<Walkthrough key={session.userId} session={session} step={step} onMove={move} onClose={() => close()}/>, document.body)}
 </Context.Provider>;
}

type Box = { x: number; y: number; width: number; height: number };
const blank: Box = { x: 0, y: 0, width: 0, height: 0 };
function visible(selector?: string) {
 if (!selector) return null;
 // The selectors in tourSteps are ordered alternatives, e.g. desktop/mobile navigation.
 for (const alternative of selector.split(',')) {
  const target = [...document.querySelectorAll<HTMLElement>(alternative)].find(element => {
   const rect = element.getBoundingClientRect();
   return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  });
  if (target) return target;
 }
 return null;
}

function Walkthrough({ session, step, onMove, onClose }: { session: TourSession; step: TourStep; onMove: (index: number) => void; onClose: () => void }) {
 const dialog = useRef<HTMLDialogElement>(null); const card = useRef<HTMLDivElement>(null);
 const [box, setBox] = useState<Box>(blank); const [position, setPosition] = useState({ left: 12, top: 12 });
 const [fallback, setFallback] = useState(false);
 const location = useLocation();
 useLayoutEffect(() => {
  dialog.current?.showModal();
  return () => { dialog.current?.close(); };
 }, []);
 useLayoutEffect(() => {
  let frame = 0; let target: HTMLElement | null = null; let measured: HTMLElement | null = null; let viewport = '';
  const update = () => {
   const width = window.innerWidth; const height = window.visualViewport?.height || window.innerHeight;
   const preferred = visible(step.target);
   target = preferred || visible(step.fallback) || visible('.page-heading') || visible('#main');
   setFallback(!preferred);
   if (target && (measured !== target || viewport !== `${width}x${height}`)) {
    measured = target; viewport = `${width}x${height}`;
    // On a phone, leave room below the highlight for the explanation.
    target.scrollIntoView({ block: width < 800 || target.offsetHeight > height * .65 ? 'start' : 'center', inline: 'nearest', behavior: 'instant' });
   }
   const rect = target?.getBoundingClientRect(); const pad = 7;
   const x = Math.max(4, Math.min(width - 4, (rect?.left || 0) - pad));
   const y = Math.max(4, Math.min(height - 4, (rect?.top || 0) - pad));
   const right = Math.max(x, Math.min(width - 4, (rect?.right || 0) + pad));
   const bottom = Math.max(y, Math.min(height - 4, (rect?.bottom || 0) + pad));
   const next = { x, y, width: right - x, height: bottom - y };
   setBox(old => Object.keys(next).every(key => old[key as keyof Box] === next[key as keyof Box]) ? old : next);
   const cw = card.current?.offsetWidth || Math.min(380, width - 24);
   const ch = card.current?.offsetHeight || 300; const gap = 18;
   let left = Math.max(12, (width - cw) / 2); let top = Math.max(12, height - ch - 12);
   if (width >= 800 && right + gap + cw < width - 12) { left = right + gap; top = y; }
   else if (width >= 800 && x - gap - cw > 12) { left = x - gap - cw; top = y; }
   else if (bottom + gap + ch < height - 12) { top = bottom + gap; }
   else if (y - gap - ch > 12) { top = y - gap - ch; }
   left = Math.max(12, Math.min(width - cw - 12, left)); top = Math.max(12, Math.min(height - ch - 12, top));
   setPosition(old => old.left === left && old.top === top ? old : { left, top });
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
  update();
  card.current?.querySelector<HTMLElement>('[data-tour-next]')?.focus({ preventScroll: true });
  const resize = new ResizeObserver(schedule);
  if (card.current) resize.observe(card.current);
  if (target) resize.observe(target);
  const mutation = new MutationObserver(schedule);
  const shell = document.querySelector('.app-shell');
  if (shell) mutation.observe(shell, { childList: true, subtree: true, attributes: true });
  window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
  window.visualViewport?.addEventListener('resize', schedule);
  return () => { cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); window.visualViewport?.removeEventListener('resize', schedule); };
 }, [step, location.key]);
 const last = session.index === session.steps.length - 1;
 return <dialog ref={dialog} className="tour-dialog" aria-labelledby="tour-title" aria-describedby="tour-description" onCancel={e => { e.preventDefault(); onClose(); }} onKeyDown={e => {
  if (e.key !== 'Tab') return;
  const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), [tabindex="0"]')];
  const first = controls[0]; const last = controls.at(-1);
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
 }}>
  <svg className="tour-shade" aria-hidden="true" width="100%" height="100%">
   <defs><mask id="tour-spotlight"><rect width="100%" height="100%" fill="white"/><rect x={box.x} y={box.y} width={box.width} height={box.height} rx="14" fill="black"/></mask></defs>
   <rect width="100%" height="100%" fill="rgba(20, 37, 28, .66)" mask="url(#tour-spotlight)"/>
  </svg>
  <div className="tour-outline" data-tour-target={step.id} aria-hidden="true" style={{ left: box.x, top: box.y, width: box.width, height: box.height }}/>
  <div className="tour-card" ref={card} style={position}>
   <div className="tour-card-header"><span>Шаг {session.index + 1} из {session.steps.length}</span><button type="button" className="icon-button" aria-label="Закрыть обучение" onClick={onClose}><Icon name="close"/></button></div>
   <progress aria-label="Прогресс обучения" value={session.index + 1} max={session.steps.length}/>
   <div className="tour-copy" aria-live="polite"><h2 id="tour-title">{step.title}</h2><p id="tour-description">{step.body}</p>{fallback && <p className="small muted">Этот элемент появится при наличии данных или на соответствующем этапе. Сейчас подсвечен его раздел.</p>}</div>
   <select aria-label="Шаг обучения" value={session.index} onChange={e => onMove(Number(e.target.value))}>{session.steps.map((item, index) => <option key={item.id} value={index}>{index + 1}. {item.title}</option>)}</select>
   <div className="tour-controls"><Button type="button" variant="quiet" onClick={onClose}>Пропустить</Button><div className="row"><Button type="button" variant="secondary" disabled={session.index === 0} onClick={() => onMove(session.index - 1)}>Назад</Button><Button type="button" data-tour-next onClick={() => last ? onClose() : onMove(session.index + 1)}>{last ? 'Завершить' : 'Далее'}</Button></div></div>
  </div>
 </dialog>;
}
