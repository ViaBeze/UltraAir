import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { dayLabel, useAction, useApp } from './state';
import type { Garden, Patient, PlantKind } from './state';
import { Button, ButtonLink, Card, CardHeading, Chip, Empty, Icon, Modal } from './ui';

export const plants: Record<PlantKind, { name: string; hero: string; description: string }> = {
 cornflower: { name: 'Василёк', hero: 'Мой василёк', description: 'Немного неба каждый день' },
 cactus: { name: 'Кактус', hero: 'Мой кактус', description: 'Тихая сила маленьких шагов' },
 daisy: { name: 'Ромашка', hero: 'Моя ромашка', description: 'Светлое настроение' },
 monstera: { name: 'Монстера', hero: 'Моя монстера', description: 'Больше зелени в вашем дне' },
};
export const emptyGarden: Garden = { plant: 'cornflower', chosen: false, growth: 0, stage: 0 };
export function stageName(garden: Garden) {
 return ['Семя', 'Росток', garden.plant === 'cactus' ? 'Подрастает' : 'Новые листья', garden.plant === 'monstera' ? 'Пышная крона' : 'Цветение'][garden.stage];
}
export function Drop({ children }: { children?: React.ReactNode }) {
 return <span className="drop-label"><Icon name="drop"/>{children}</span>;
}

// The same botanical illustration is used in both accounts, with server-owned growth.
export function PlantArt({ kind = 'cornflower', stage = 0, decorative = false }: { kind?: PlantKind; stage?: number; decorative?: boolean }) {
 const id = useId().replace(/:/g, '');
 const leaf = (x: number, y: number, rotation = 0, scale = 1) => <path d="M0 0C-4-23 9-41 27-45C30-21 20-5 0 0Z" transform={`translate(${x} ${y}) rotate(${rotation}) scale(${scale})`} fill={`url(#${id}-leaf)`}/>;
 const flower = (x: number, y: number, scale = 1) => <g transform={`translate(${x} ${y}) scale(${scale})`}>
  {kind === 'cornflower' ? <>{Array.from({ length: 9 }, (_, i) => <path key={i} d="M0 2C-6-6-12-10-11-22L-6-18-4-28 1-20 6-26 7-15 12-19C10-8 4-2 0 2Z" transform={`rotate(${i * 40})`} fill={i % 2 ? '#79a1bb' : '#638cae'}/>)}<circle r="7" fill="#4e658e"/><circle r="3" fill="#e2bc8d"/></> : <>{Array.from({ length: 12 }, (_, i) => <ellipse key={i} cx="0" cy="-16" rx="5.2" ry="13" transform={`rotate(${i * 30})`} fill={i % 2 ? '#fffdf2' : '#f3f0db'} stroke="#e4e4cf" strokeWidth=".5"/>)}<circle r="9" fill="#d6b65e"/><circle cx="-2" cy="-2" r="6" fill="#e5ca76"/></>}
 </g>;
 const label = `${plants[kind].name} · ${stageName({ ...emptyGarden, plant: kind, stage })}`;
 return <svg className="plant-art" viewBox="0 0 240 240" role={decorative ? undefined : 'img'} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : label}>
  <defs><linearGradient id={`${id}-leaf`} x1="0" x2="1" y1="0" y2="1"><stop stopColor="#a0b890"/><stop offset=".5" stopColor="#74986e"/><stop offset="1" stopColor="#4d7759"/></linearGradient><linearGradient id={`${id}-pot`} x1="0" x2="1"><stop stopColor="#b99f80"/><stop offset=".45" stopColor="#d5c0a2"/><stop offset="1" stopColor="#bca284"/></linearGradient></defs>
  <ellipse cx="120" cy="218" rx="54" ry="9" fill="#67806b" opacity=".12"/><path d="M78 175h84l-10 37q-1 9-13 9h-38q-12 0-13-9Z" fill={`url(#${id}-pot)`}/><path d="M86 181h6l8 31h-5Z" fill="#fff" opacity=".14"/><rect x="75" y="168" width="90" height="16" rx="6" fill="#c8b296"/><path d="M80 171h80" stroke="#eadbc4" strokeWidth="2" strokeLinecap="round"/><ellipse cx="120" cy="170" rx="37" ry="6" fill="#7e715a"/>
  {stage === 0 ? <><ellipse cx="120" cy="166" rx="7" ry="3" fill="#baa07c"/><path d="m117 165 5-2" stroke="#dec6a6"/></> : stage === 1 ? <><path d="M120 170v-34" stroke="#6a8e64" strokeWidth="4" strokeLinecap="round"/>{leaf(120,143,-65,.65)}{leaf(120,143,22,.62)}</> : kind === 'cactus' ? <>
   <path d="M105 170V72a17 17 0 0 1 34 0v98" fill={`url(#${id}-leaf)`}/><path d="M111 132H96q-15 0-15-15V96a9 9 0 0 1 18 0v20h12M133 145h17q16 0 16-16v-24a9 9 0 0 0-18 0v21h-15" fill={`url(#${id}-leaf)`}/><path d="M121 66v96M111 77v87M130 77v87" stroke="#b3c69b" strokeWidth="1.4" opacity=".5"/>{[83,99,115,148].map(y => <path key={y} d={`m111 ${y}-3-2m17 2 3-2`} stroke="#edf0cc" strokeWidth="1.5" strokeLinecap="round"/>)}
   {stage >= 3 && <g transform="translate(124 59)">{Array.from({ length: 6 }, (_, i) => <ellipse key={i} cx="0" cy="-7" rx="4" ry="7" transform={`rotate(${i * 60})`} fill="#cf9390"/>)}<circle r="4" fill="#f1d59a"/></g>}
  </> : kind === 'monstera' ? <>
   <path d="M118 170q2-44 6-90M120 148q-18-22-38-34M123 130q20-26 39-35" stroke="#5a7b54" strokeWidth="3.5" fill="none" strokeLinecap="round"/>{leaf(119,129,-49,1.35)}{leaf(123,110,20,1.2)}{leaf(122,156,57,1.14)}{leaf(113,163,-92,.95)}{stage >= 3 && <>{leaf(127,96,25,.95)}{leaf(104,132,-96,.75)}</>}<path d="m90 92-9 1m13 9-13 1m20 11-9 5m55-22 8-1m-12 11 10 2m-15 10 8 3" stroke="#e7eee0" strokeWidth="3.5" strokeLinecap="round"/>
  </> : <>
   <path d="M119 170q2-62-2-105M121 139q-21-23-35-40M121 147q24-24 34-54" stroke="#67895f" strokeWidth="3" fill="none" strokeLinecap="round"/>{leaf(119,156,-73,.96)}{leaf(121,133,43,.82)}{leaf(107,122,-75,.62)}{leaf(138,126,20,.6)}
   {stage >= 3 ? <>{flower(117,62,1.04)}{flower(84,98,.55)}{flower(157,90,.7)}</> : <><path d="M110 70q-5-18 7-18t8 18q-7 9-15 0Z" fill={kind === 'cornflower' ? '#90aaa9' : '#cdd2a6'}/><path d="m110 69 8 7 7-7" stroke="#6a8d63" strokeWidth="3" fill="none"/><ellipse cx="156" cy="92" rx="5" ry="8" fill="#98ae84"/><ellipse cx="85" cy="99" rx="4" ry="7" fill="#9bb28a"/></>}
  </>}
 </svg>;
}

export function GardenRules({ onClose, kind }: { onClose: () => void; kind: PlantKind }) {
 return <Modal title="Как растёт растение" onClose={onClose}>
  <div className="stack garden-rules"><div className="garden-rule"><Icon name="pill"/><div><h3>Отметка лекарства по плану</h3><p>После отметки «Принято» растение получает каплю. «Пропущено» и «Напомнить позже» не добавляют рост.</p></div><Drop>+1</Drop></div><div className="garden-rule"><Icon name="diary"/><div><h3>Дневник — опрос самочувствия</h3><p>Один раз за день, независимо от ваших ответов.</p></div><Drop>+3</Drop></div>
  <p>Капли сразу поливают растение после сохранения приёма лекарства или дневника. Дополнительное действие не нужно.</p><div className="garden-stages">{[0,6,15,30].map((amount, stage) => <div key={stage}><PlantArt kind={kind} stage={stage} decorative/><strong>{stageName({ ...emptyGarden, plant: kind, stage })}</strong><small>{amount} капель</small></div>)}</div>
  <p className="small muted">Паузы не отнимают рост. Смена растения и исправление записи не дают повторной награды. Ответ об алкоголе можно пропустить — награда сохранится. Капли начисляются и за записи последних 7 дней.</p><Button onClick={onClose}>Всё понятно</Button></div>
 </Modal>;
}

function ChoosePlant({ garden, onClose }: { garden: Garden; onClose: () => void }) {
 const { mutate, toast } = useApp(); const action = useAction(); const [selected, setSelected] = useState(garden.plant);
 return <Modal title="Выберите своё растение" onClose={onClose}><div className="stack"><p className="muted">Можно поменять в любой момент. Все капли и рост сохранятся.</p><div className="plant-choices" role="group" aria-label="Растение">{(Object.entries(plants) as [PlantKind, typeof plants[PlantKind]][]).map(([kind, info]) => <button key={kind} type="button" className={`plant-choice ${selected === kind ? 'selected' : ''}`} aria-pressed={selected === kind} onClick={() => setSelected(kind)}><PlantArt kind={kind} stage={3} decorative/><strong>{info.name}</strong><span>{info.description}</span>{selected === kind && <span className="plant-choice-check"><Icon name="check"/></span>}</button>)}</div><p role="alert" className="error-text">{action.error}</p><Button disabled={action.busy} onClick={() => void action.run(async () => { await mutate('/garden/plant', 'PUT', { plant: selected }); toast('Растение выбрано. Капли и рост сохранены.'); onClose(); })}>{action.busy ? 'Сохраняем…' : `Выбрать: ${plants[selected].name}`}</Button></div></Modal>;
}

export function PatientPlant() {
 const { state } = useApp(); const garden = state.patients[0]?.garden || emptyGarden;
 const [choose, setChoose] = useState(false); const [rules, setRules] = useState(false);
 const next = [6,15,30][garden.stage]; const progress = next ? `До ${garden.stage === 0 ? 'ростка' : garden.stage === 1 ? 'новых листьев' : garden.plant === 'monstera' ? 'пышной кроны' : 'цветения'} ещё ${next - garden.growth} капель` : garden.plant === 'monstera' ? 'У вашего растения пышная крона' : 'Ваше растение цветёт';
 return <Card className="plant-card"><div className="row between"><div><p className="garden-eyebrow">Ваш маленький сад</p><h2>{plants[garden.plant].hero}</h2></div><span className="growth-total" aria-label={`Капель роста: ${garden.growth}`}><Drop>{garden.growth}</Drop><small>капель роста</small></span></div>
  <div className="plant-scene"><p className="plant-message">Растём понемногу.<br/>В вашем ритме.</p><div className="plant-halo"><PlantArt kind={garden.plant} stage={garden.stage}/></div><span className="plant-stage"><Icon name="leaf"/>{stageName(garden)}</span></div>
  <div className="growth-copy"><span>{progress}</span><span>{garden.growth} / {Math.max(30, garden.growth)}</span></div><progress className="garden-progress" aria-label="Рост растения в капельках" max={30} value={Math.min(30,garden.growth)}/>
  <div className="garden-auto-note"><Icon name="drop"/><p>Растение поливается автоматически, когда вы отмечаете приём лекарства или заполняете дневник-опрос.</p></div>
  <div className="plant-actions"><button className="text-link" onClick={() => setRules(true)}>Как растёт растение</button><Button variant="quiet" onClick={() => setChoose(true)}>Выбрать растение <span aria-hidden="true">→</span></Button></div>
  <p className="small muted">Рост сохраняется, даже если сделать паузу.</p>
  {choose && <ChoosePlant garden={garden} onClose={() => setChoose(false)}/>} {rules && <GardenRules kind={garden.plant} onClose={() => setRules(false)}/>}
 </Card>;
}

export function PatientFlower({ patient, large = false }: { patient: Patient; large?: boolean }) {
 const garden = patient.garden || emptyGarden;
 return <span className={`patient-plant-avatar ${large ? 'large' : ''}`}><PlantArt kind={garden.plant} stage={garden.stage}/></span>;
}

export function GardenGrid({ patients }: { patients: Patient[] }) {
 const { state } = useApp();
 return <div className="garden-grid">{patients.map(patient => {
  const garden = patient.garden || emptyGarden; const entry = state.entries.find(e => e.patientId === patient.id); const sos = state.sosEvents.some(s => s.patientId === patient.id && !s.closed);
  return <Link className={`patient-flower plant-${garden.plant}`} key={patient.id} to={`/doctor/patients/${patient.id}`} aria-label={`Открыть карточку: ${patient.name}`}><div className="flower-scene"><PlantArt kind={garden.plant} stage={garden.stage}/>{sos && <span className="flower-alert"><Chip tone="danger">SOS · ждёт ответа</Chip></span>}<span className="flower-open"><Icon name="arrow"/></span></div><div className="patient-flower-copy"><h3>{patient.name}</h3><p>{plants[garden.plant].name} · {garden.chosen ? 'выбор пациента' : 'пока по умолчанию'}</p><span className="small muted">{stageName(garden)} · {garden.growth} капель роста</span><div className="garden-clinical"><p>Диагноз: <strong>{patient.diagnosis || 'Не указан'}</strong></p><p>Лечение: <strong>{patient.treatment || 'Пока не назначено'}</strong></p></div><div className="flower-meta"><span>{entry ? `Дневник: ${dayLabel(entry.date)}` : 'Дневник: пока нет записей'}</span><Icon name="chevron"/></div></div></Link>;
 })}</div>;
}

export function DoctorGarden() {
 const { state } = useApp();
 return <Card className="doctor-garden"><CardHeading title="Сад ваших пациентов" action={<Link className="text-link" to="/doctor/patients">Открыть сад →</Link>}/><p className="small muted">У каждого — своё растение и свой ритм. Рост отражает отмеченные приёмы лекарств и заполненные дневники, а не состояние здоровья.</p>{state.patients.length ? <GardenGrid patients={state.patients.slice(0,4)}/> : <Empty title="Здесь вырастет ваш сад">Создайте карточку — пациент сможет выбрать растение и заботиться о нём.</Empty>}{!state.patients.length && <ButtonLink variant="secondary" to="/doctor/new">Добавить пациента</ButtonLink>}</Card>;
}
