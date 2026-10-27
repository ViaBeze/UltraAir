import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { today, useAction, useApp } from './state';
import type { Medication } from './state';
import { Button, ButtonLink, Card, Detail, Field, Heading } from './ui';
import { MedicationCatalog } from './Medicines';
import { CitationList, ReferencesEditor } from './References';
import './medications.css';

export function blankMedication(name = ''): Medication {
 return { name, dose: '', instructions: '', indication: '', sideEffects: '', interactions: '', citations: [], times: ['09:00'], start: today(), end: null };
}
export function medicationValues(item: Medication): Medication {
 return { name: item.name, dose: item.dose, instructions: item.instructions, times: item.times, start: item.start, end: item.end,
  indication: item.indication || '', sideEffects: item.sideEffects || '', interactions: item.interactions || '', citations: item.citations || [], ...(item.id ? { id: item.id } : {}) };
}
export function MedicationDetails({ medication: m }: { medication: Medication }) {
 return <div className="medication-details"><Detail label="Область применения">{m.indication || 'Не указана врачом'}</Detail>
  <Detail label="Побочные эффекты">{m.sideEffects || 'Не указаны; проверьте инструкцию'}</Detail>
  <Detail label="Совместимость с другими препаратами">{m.interactions || 'Не проверена; отсутствие сведений не подтверждает совместимость'}</Detail>
  <CitationList items={m.citations}/>
 </div>;
}
export function PrescriptionHistory({ patientId }: { patientId: string }) {
 const { state } = useApp(); const previous = state.prescriptions.filter(m => m.patientId === patientId && !m.active).reverse();
 if (!previous.length) return null;
 return <Card><h2>История назначений</h2><details><summary>Прежние назначения · {previous.length}</summary>
  {previous.map(m => <article className="prescription-summary" key={m.id}><strong>{m.name}</strong><p>{m.dose} · {m.times.join(', ')}</p>
   <p className="small muted">Заменено или отменено · период назначения {m.start} — {m.end || 'без даты окончания'}</p>
   {m.instructions && <p className="pre-wrap">{m.instructions}</p>}<MedicationDetails medication={m}/>
  </article>)}
 </details></Card>;
}
export function PrescriptionFields({ value, onChange, disabled = false, medicineQuery }: {
 value: Medication[]; onChange: (items: Medication[]) => void; disabled?: boolean; medicineQuery?: { value: string; sequence: number };
}) {
 function change(index: number, patch: Partial<Medication>) { onChange(value.map((item, i) => i === index ? { ...item, ...patch } : item)); }
 return <div className="prescription-fields">
  {!disabled && <MedicationCatalog disabled={value.length >= 30} initialQuery={medicineQuery} onChoose={item => onChange([...value, { ...blankMedication(item.name), times: [] }])}/>}
  {value.map((m, index) => <fieldset className="prescription-editor" key={index} disabled={disabled}>
   <legend>Назначение {index + 1}</legend>
   <Field label={`Препарат ${index + 1}`}><input required maxLength={200} value={m.name} onChange={e => change(index, { name: e.target.value })}/></Field>
   <Field label="Дозировка"><input required maxLength={200} value={m.dose} onChange={e => change(index, { dose: e.target.value })}/></Field>
   <Field label="Область применения"><textarea maxLength={2000} value={m.indication || ''} onChange={e => change(index, { indication: e.target.value })} placeholder="Показание или цель назначения"/></Field>
   <Field label="Побочные эффекты"><textarea maxLength={3000} value={m.sideEffects || ''} onChange={e => change(index, { sideEffects: e.target.value })}/></Field>
   <Field label="Совместимость с другими препаратами"><textarea maxLength={3000} value={m.interactions || ''} onChange={e => change(index, { interactions: e.target.value })} placeholder="Проверенные взаимодействия и ограничения"/></Field>
   <Field label="Время приёма · через запятую"><input required pattern="([01][0-9]|2[0-3]):[0-5][0-9](,\s*([01][0-9]|2[0-3]):[0-5][0-9])*" placeholder="09:00, 20:00" value={m.times.join(', ')} onChange={e => change(index, { times: e.target.value.split(',').map(time => time.trim()) })}/></Field>
   <div className="form-grid"><Field label="Начало"><input required type="date" value={m.start} onChange={e => change(index, { start: e.target.value })}/></Field><Field label="Окончание · необязательно"><input type="date" min={m.start} value={m.end || ''} onChange={e => change(index, { end: e.target.value || null })}/></Field></div>
   <Field label="Пояснения"><textarea maxLength={2000} value={m.instructions} onChange={e => change(index, { instructions: e.target.value })}/></Field>
   <ReferencesEditor value={m.citations || []} disabled={disabled} initialQuery={m.name} onChange={citations => change(index, { citations })}/>
   {!disabled && <Button variant="quiet" type="button" onClick={() => onChange(value.filter((_, i) => i !== index))}>Убрать назначение</Button>}
  </fieldset>)}
  {!disabled && <Button variant="secondary" type="button" disabled={value.length >= 30} onClick={() => onChange([...value, blankMedication()])}>+ Добавить препарат</Button>}
 </div>;
}

export function PatientPrescriptions() {
 const { state } = useApp(); const { id } = useParams(); const patient = state.patients.find(p => p.id === id);
 if (!patient) return <Heading title="Карточка не найдена"/>;
 return <CardPrescriptionsEditor key={patient.id} patientId={patient.id} name={patient.name} initialVersion={patient.version}/>;
}
function CardPrescriptionsEditor({ patientId, name, initialVersion }: { patientId: string; name: string; initialVersion: number }) {
 const { state, mutate, toast } = useApp(); const action = useAction(); const navigate = useNavigate();
 const [version] = useState(initialVersion);
 const [meds, setMeds] = useState<Medication[]>(() => state.prescriptions.filter(m => m.patientId === patientId && m.active).map(medicationValues));
 return <><Heading title="Редактировать препараты" subtitle={`${name} · вне приёма`} action={<ButtonLink variant="quiet" to={`/doctor/patients/${patientId}`}>К карточке</ButtonLink>}/>
  <Card><p>Изменения сразу станут доступны пациенту. Прежние назначения и отметки сохранятся в истории.</p>
   <form onSubmit={e => { e.preventDefault(); void action.run(async () => {
    await mutate(`/patients/${patientId}/prescriptions`, 'PUT', { version, prescriptions: meds });
    toast('Назначения обновлены и доступны пациенту'); navigate(`/doctor/patients/${patientId}`);
   }); }}><fieldset disabled={action.busy} className="reference-fields">
    <PrescriptionFields value={meds} onChange={setMeds}/>
    {!meds.length && <p className="small muted">Сохранение пустого списка отменит действующие назначения.</p>}
    {action.error && <p role="alert" className="error-text">{action.error}</p>}
    <div className="row wrap"><Button type="submit" disabled={action.busy}>Сохранить назначения</Button><ButtonLink variant="quiet" to={`/doctor/patients/${patientId}`}>Отмена</ButtonLink></div>
   </fieldset></form>
  </Card></>;
}
