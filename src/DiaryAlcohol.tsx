import type { AlcoholFields, Entry } from './state';
import { Field, Icon } from './ui';

export const emptyAlcohol: AlcoholFields = { alcohol: null, alcoholDrink: '', alcoholVolume: null, alcoholStrength: null, alcoholTime: null, alcoholNote: '' };

export function AlcoholQuestion({ value, onChange }: { value: AlcoholFields; onChange: (value: AlcoholFields) => void }) {
 function update(fields: Partial<AlcoholFields>) { onChange({ ...value, ...fields }); }
 return <fieldset className="alcohol-question"><legend>Был ли сегодня алкоголь?</legend><p className="small muted">Можно ответить, если вам комфортно. Это поможет дополнить дневник.</p>
  <div className="alcohol-options">{[['no','Нет, сегодня не было'],['yes','Да, употреблял(а) алкоголь'],['private','Предпочитаю не отвечать']].map(([answer,label]) => <label className={`alcohol-option ${value.alcohol === answer ? 'selected' : ''}`} key={answer}><input type="radio" name="alcohol" value={answer} checked={value.alcohol === answer} onChange={() => onChange(answer === 'yes' ? { ...value, alcohol: 'yes' } : { ...emptyAlcohol, alcohol: answer as 'no' | 'private' })}/><span>{label}</span></label>)}</div>
  {value.alcohol === 'yes' && <div className="alcohol-details"><h3>Если помните — добавьте детали</h3><Field label="Что вы пили?" hint="Необязательно"><input value={value.alcoholDrink} maxLength={200} placeholder="Например, вино или пиво" onChange={e => update({ alcoholDrink: e.target.value })}/></Field><div className="form-grid"><Field label="Количество, мл" hint="Можно примерно"><input type="number" min="0" max="10000" step="any" inputMode="decimal" value={value.alcoholVolume ?? ''} onChange={e => update({ alcoholVolume: e.target.value === '' ? null : Number(e.target.value) })}/></Field><Field label="Крепость, %" hint="Если знаете"><input type="number" min="0" max="100" step="any" inputMode="decimal" value={value.alcoholStrength ?? ''} onChange={e => update({ alcoholStrength: e.target.value === '' ? null : Number(e.target.value) })}/></Field></div><Field label="Примерное время"><input type="time" value={value.alcoholTime ?? ''} onChange={e => update({ alcoholTime: e.target.value || null })}/></Field><Field label="Комментарий об алкоголе"><textarea rows={2} maxLength={1000} value={value.alcoholNote} onChange={e => update({ alcoholNote: e.target.value })}/></Field></div>}
  <div className="alcohol-privacy"><Icon name="shield"/><p>Ответ доступен вам и вашему лечащему врачу. Можно оставить вопрос без ответа — капли за дневник сохранятся.</p></div>
 </fieldset>;
}

export function AlcoholRecord({ entry }: { entry: Entry }) {
 const label = entry.alcohol === 'yes' ? 'Алкоголь: есть отметка' : entry.alcohol === 'no' ? 'Алкоголь: не было' : entry.alcohol === 'private' ? 'Алкоголь: без ответа' : 'Алкоголь: не указано';
 return <div className="alcohol-record"><div className="row"><Icon name="glass"/><strong>{label}</strong></div>{entry.alcohol === 'yes' && <><p>{[entry.alcoholDrink, entry.alcoholVolume != null ? `${entry.alcoholVolume} мл` : '', entry.alcoholStrength != null ? `${entry.alcoholStrength}%` : '', entry.alcoholTime ? `около ${entry.alcoholTime}` : ''].filter(Boolean).join(' · ') || 'Без дополнительных деталей'}</p>{entry.alcoholNote && <p className="pre-wrap">{entry.alcoholNote}</p>}</>}</div>;
}
