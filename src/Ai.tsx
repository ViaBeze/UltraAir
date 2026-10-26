import { useEffect, useRef, useState } from 'react';
import { api, dateTime, useAction, useApp } from './state';
import type { ClinicalDraft, Patient, Visit } from './state';
import { Button, ButtonLink, Card, Chip, Empty, Field, Heading, Modal } from './ui';
import './ai.css';

type Transcript = { text: string; model: string; created: string };
type GroundedText = { value: string; evidence: string[] };
export type VisitFields = Pick<Required<Visit>, 'notes' | 'observation' | 'diagnosis' | 'plan'>;
type CardField = Exclude<keyof ClinicalDraft, 'version'>;
type Suggestion = {
 visit: Record<keyof VisitFields, GroundedText | null>;
 card: Record<Exclude<CardField, 'medications'>, GroundedText | null> & { medications: GroundedText[] | null };
 warnings: string[];
 diagnoses?: { name: string; icd10: string | null; rationale: GroundedText; against: string[]; missing: string[] }[];
 medications?: { name: string; inn: string | null; rationale: GroundedText; cautions: string[] }[];
 medicationAssessment?: { reason: string; missing: string[] };
 questions?: string[]; redFlags?: GroundedText[]; contextUsed?: boolean; promptVersion?: string;
};
type DraftResult = { source: string; suggestion: Suggestion; version: number; patientVersion: number; created: string; model: string; needsRefresh?: boolean };
const visitLabels: Record<keyof VisitFields, string> = { notes: 'Жалобы и анамнез', observation: 'Наблюдения врача', diagnosis: 'Диагноз для пациента', plan: 'План для пациента' };
const cardLabels: Record<CardField, string> = { allergy: 'Аллергии и нежелательные реакции', conditions: 'Сопутствующие состояния', medications: 'Принимаемые препараты', note: 'Внутренняя заметка врача', transfer: 'Обсуждение перевода' };
const consentText = 'Есть согласие пациента на обработку этих данных в OpenAI';

async function transcribe(mediaId: string) {
 return api<Transcript>(`/media/${mediaId}/transcription`, 'POST', { consent: true }, 115000);
}

export function AudioTranscript({ mediaId }: { mediaId: string }) {
 const { state } = useApp(); const action = useAction();
 const [transcript, setTranscript] = useState<Transcript | null>(null);
 const [consent, setConsent] = useState(false); const [allowed, setAllowed] = useState(false);
 return <div className="ai-transcript">
  {transcript ? <details open><summary>Расшифровка · проверьте по аудио</summary><p className="pre-wrap">{transcript.text}</p><small>Черновик ИИ · виден только врачу</small></details> :
   <Button type="button" variant="quiet" disabled={action.busy} onClick={() => void action.run(async () => {
    const saved = await api<{ transcript: Transcript | null }>(`/media/${mediaId}/transcription`);
    if (saved.transcript) setTranscript(saved.transcript);
    else if (!state.ai?.enabled) throw new Error('Расшифровка не настроена. Обратитесь к администратору.');
    else setConsent(true);
   })}>{action.busy ? 'Расшифровываем…' : 'Расшифровать голосовое'}</Button>}
  {action.error && <p className="error-text" role="alert">{action.error}</p>}
  {consent && <Modal title="Расшифровать голосовое?" onClose={() => { if (!action.busy) setConsent(false); }}>
   <p>Запись будет передана в OpenAI для распознавания речи. Текст сохранится в кабинете врача.</p>
   <label className="checkbox"><input type="checkbox" checked={allowed} disabled={action.busy} onChange={e => setAllowed(e.target.checked)}/><span>{consentText}</span></label>
   {action.error && <p className="error-text" role="alert">{action.error}</p>}
   <Button disabled={!allowed || action.busy} onClick={() => void action.run(async () => { setTranscript(await transcribe(mediaId)); setConsent(false); })}>{action.busy ? 'Распознаём речь…' : 'Передать и расшифровать'}</Button>
  </Modal>}
 </div>;
}

type PanelProps = {
 visit: Visit; version: number; patient: Patient; fields: VisitFields; clinical: ClinicalDraft | null;
 audio: { id: string; created: string }[]; disabled: boolean;
 onApply: (fields: Partial<VisitFields>, clinical: ClinicalDraft | null) => void;
 onFindMedication: (name: string) => void;
};

function fillFacts(suggestion: Suggestion, props: PanelProps) {
 const fields: Partial<VisitFields> = {}; let clinical = props.clinical;
 for (const key of Object.keys(visitLabels) as (keyof VisitFields)[]) {
  const value = suggestion.visit[key]?.value; if (!value) continue;
  const current = props.fields[key];
  if (key === 'notes' || key === 'observation') fields[key] = current.includes(value) ? current : [current, value].filter(Boolean).join('\n\n');
  else if (!current.trim()) fields[key] = value;
 }
 for (const key of Object.keys(cardLabels) as CardField[]) {
  const values = suggestion.card[key]; if (!values || (Array.isArray(values) && !values.length)) continue;
  const existing = props.clinical?.[key] ?? props.patient[key];
  const current = Array.isArray(existing) ? existing.join('\n') : existing || '';
  const additions = (Array.isArray(values) ? values : [values]).map(v => v.value).filter(v => !current.includes(v));
  const merged = [current, ...additions].filter(Boolean).join('\n');
  // Keep the editable proposal if a merged field exceeds the card's storage limits.
  if (merged.length > 10000 || (key === 'medications' && (merged.split('\n').length > 50 || merged.split('\n').some(v => v.length > 200)))) continue;
  clinical = { ...clinical, version: props.patient.version };
  if (key === 'medications') clinical.medications = merged.split('\n').filter(Boolean);
  else clinical[key] = merged;
 }
 for (const key of Object.keys(fields) as (keyof VisitFields)[]) if (fields[key]!.length > 10000) delete fields[key];
 return { fields, clinical };
}

export function VisitAiPanel(props: PanelProps) {
 const { state, toast } = useApp(); const action = useAction();
 const [source, setSource] = useState(''); const [result, setResult] = useState<DraftResult | null>(null);
 const [reviewKey, setReviewKey] = useState(0);
 const [autoFill, setAutoFill] = useState(true); const [autoApplied, setAutoApplied] = useState(false);
 const [includeContext, setIncludeContext] = useState(false);
 const latestProps = useRef(props); latestProps.current = props;
 const [consent, setConsent] = useState(false); const [selectedAudio, setSelectedAudio] = useState('');
 const [stage, setStage] = useState(''); const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState('');
 useEffect(() => {
  let active = true;
  void api<{ draft: DraftResult | null }>(`/visits/${props.visit.id}/ai-draft`).then(value => {
   if (active && value.draft) { setResult(value.draft); setSource(value.draft.source); setIncludeContext(!!value.draft.suggestion.contextUsed); }
  }).catch(e => { if (active) setLoadError(e.message); }).finally(() => { if (active) setLoading(false); });
  return () => { active = false; };
 }, [props.visit.id]);
 useEffect(() => {
  const warn = (e: BeforeUnloadEvent) => { if (source.trim() && source !== result?.source) e.preventDefault(); };
  window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
 }, [source, result?.source]);
 const audioId = props.audio.find(a => a.id === selectedAudio)?.id || props.audio.at(-1)?.id || '';
 const busy = action.busy || props.disabled || loading;
 const staleClinical = !!props.clinical && props.clinical.version !== props.patient.version;
 const stale = !!result && (result.needsRefresh || result.version !== props.version || result.patientVersion !== props.patient.version || result.source !== source || !!result.suggestion.contextUsed !== includeContext);
 function generate(withAudio: boolean, reviewMedications = false) {
  void action.run(async () => {
   const baseline = JSON.stringify([props.fields, props.clinical, props.version, props.patient.version]);
   let text = source;
   if (withAudio) {
    setStage('Распознаём речь…');
    const transcript = await transcribe(audioId);
    text = source.includes(transcript.text) ? source : [source.trim(), transcript.text].filter(Boolean).join('\n\n');
    if (text.length > 50000) throw new Error('Слишком много текста. Используйте запись отдельной части приёма.');
    setSource(text); setSelectedAudio('');
   }
   setStage(reviewMedications ? 'Рассматриваем варианты препаратов…' : 'Готовим карточку и клинические предложения…');
   const draft = await api<DraftResult>(`/visits/${props.visit.id}/ai-draft`, 'POST', {
    consent: true, source: text, version: props.version, patientVersion: props.patient.version, includeClinicalContext: includeContext,
    reviewMedications,
   }, 115000);
   const current = latestProps.current;
   const unchanged = !current.disabled && baseline === JSON.stringify([current.fields, current.clinical, current.version, current.patient.version]) && (!current.clinical || current.clinical.version === current.patient.version);
   let didApply = false;
   setAutoApplied(false);
   if (autoFill && unchanged && !reviewMedications) {
    const merged = fillFacts(draft.suggestion, current);
    if (Object.keys(merged.fields).length || merged.clinical !== current.clinical) { current.onApply(merged.fields, merged.clinical); didApply = true; setAutoApplied(true); }
   }
   setResult(draft); setReviewKey(key => key + 1);
   toast(reviewMedications ? 'Разбор препаратов готов. Проверьте варианты и пояснения.' : didApply ? 'Черновик карточки заполнен. Проверьте факты и предложения ИИ.' : 'Черновик готов. Проверьте предложения перед переносом в форму.');
  });
 }
 return <Card className="ai-panel lavender">
  <div className="row between wrap"><h2>Помощник врача</h2><Chip>Черновик ИИ</Chip></div>
  <p>Расшифруйте запись или добавьте заметки. Помощник заполнит черновик карточки и предложит диагнозы и препараты для рассмотрения врачом.</p>
  {!state.ai?.enabled && <p role="status">Для обработки администратору нужно подключить OpenAI. Запись аудио и ручное заполнение доступны.</p>}
  {loadError && <p role="alert" className="error-text">Не удалось загрузить прошлый черновик: {loadError}</p>}
  <Field label="Исходный текст для помощника" hint="Проверьте распознавание, особенно отрицания, названия и дозировки. До 50 000 символов.">
   <textarea value={source} disabled={busy} rows={7} maxLength={50000} onChange={e => setSource(e.target.value)} placeholder="Заметки врача или расшифровка приёма…"/>
  </Field>
  <Button type="button" variant="quiet" disabled={busy || !props.fields.notes.trim() || source.length + props.fields.notes.length + 2 > 50000} onClick={() => setSource(s => [s, props.fields.notes].filter(Boolean).join('\n\n'))}>Добавить заметки из приёма</Button>
  <label className="checkbox"><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)}/><span>{consentText}</span></label>
  <label className="checkbox"><input type="checkbox" checked={includeContext} disabled={busy} onChange={e => setIncludeContext(e.target.checked)}/><span>Учесть сохранённую медкарту и действующие назначения</span></label>
  {includeContext && <details><summary>Какие сведения из карточки будут переданы</summary><p>Возраст: {props.patient.age}. Диагноз: {props.patient.diagnosis || 'не указан'}. План: {props.patient.treatment || 'не указан'}. Аллергии: {props.patient.allergy || 'не указаны'}. Состояния: {props.patient.conditions || 'не указаны'}. Принимаемые препараты: {props.patient.medications?.join(', ') || 'не указаны'}.</p><p>Действующие назначения: {state.prescriptions.filter(p => p.patientId === props.patient.id && p.active).map(p => `${p.name}, ${p.dose}; ${p.instructions}; ${p.times.join(', ')}; ${p.start} — ${p.end || 'без даты окончания'}`).join('; ') || 'нет'}.</p><p>Имя, контакты, дата рождения и внутренние заметки из карточки не передаются. Неуказанные сведения считаются неизвестными.</p></details>}
  <label className="checkbox"><input type="checkbox" checked={autoFill} disabled={busy} onChange={e => setAutoFill(e.target.checked)}/><span>Автоматически перенести факты в черновик карточки</span></label>
  <p className="small muted">Выбранное аудио и исходный текст будут отправлены в OpenAI. Проверьте, что в тексте нет лишних персональных данных.</p>
  {props.audio.length > 0 && <Field label="Запись для заполнения"><select disabled={busy} value={audioId} onChange={e => setSelectedAudio(e.target.value)}>{props.audio.map((a, i) => <option value={a.id} key={a.id}>Запись {i + 1} · {dateTime(a.created)}</option>)}</select></Field>}
  <div className="row wrap" data-tour="ai-actions">
   {props.audio.length > 0 && <Button type="button" disabled={busy || !consent || !state.ai?.enabled} onClick={() => generate(true)}>Заполнить по аудио</Button>}
   <Button type="button" variant="secondary" disabled={busy || !consent || !state.ai?.enabled || source.trim().length < 10} onClick={() => generate(false)}>Заполнить по тексту</Button>
   <Button type="button" variant="secondary" disabled={busy || !consent || !state.ai?.enabled || source.trim().length < 10} onClick={() => generate(false, true)}>Предложить препараты</Button>
  </div>
  <p className="small muted">«Предложить препараты» запускает новый разбор исходного текста и выбранного контекста медкарты. Заполненные поля формы сохраняются.</p>
  {action.busy && <p role="status">{stage}</p>}
  {action.error && <p role="alert" className="error-text">{action.error}</p>}
  {result && <>
   {stale && <p className="error-text" role="status">{result.needsRefresh ? 'Помощник обновлён. Нажмите «Заполнить по тексту» или «Предложить препараты», чтобы обновить сохранённый разбор.' : 'Исходный текст, приём или медкарта изменились. Сформируйте черновик заново перед переносом полей.'}</p>}
   <ClinicalReasoning {...props} suggestion={result.suggestion} disabled={busy || stale || staleClinical}/>
   {autoApplied && <p role="status">Факты перенесены в форму. Новые гипотезы и варианты препаратов выберите отдельно. Карточка обновится после подтверждения приёма.</p>}
   <SuggestionReview key={`${result.created}:${reviewKey}`} {...props} result={result} disabled={busy || stale || staleClinical}/>
  </>}
 </Card>;
}

function ClinicalReasoning({ suggestion, ...props }: PanelProps & { suggestion: Suggestion }) {
 return <div className="ai-reasoning">
  {!!suggestion.redFlags?.length && <div className="ai-red-flags"><strong>Требуется оценка безопасности</strong>{suggestion.redFlags.map((flag, i) => <div key={i}><p>{flag.value}</p><Evidence value={flag}/></div>)}</div>}
  {!!suggestion.diagnoses?.length && <><h3>Диагностические гипотезы</h3><p className="small muted">Требуют проверки врачом. Вероятность не рассчитана.</p>{suggestion.diagnoses.map((item, i) => <article className="ai-proposal" key={i}>
   <strong>{item.name}{item.icd10 && ` · ${item.icd10}`}</strong><p>{item.rationale.value}</p><Evidence value={item.rationale}/>
   {!!item.against.length && <div><strong>Что против гипотезы</strong><ul>{item.against.map((v, j) => <li key={j}>{v}</li>)}</ul></div>}
   {!!item.missing.length && <div><strong>Что уточнить</strong><ul>{item.missing.map((v, j) => <li key={j}>{v}</li>)}</ul></div>}
   <Button type="button" variant="secondary" disabled={props.disabled} onClick={() => props.onApply({ diagnosis: [item.icd10, item.name].filter(Boolean).join(' · ') }, props.clinical)}>{props.fields.diagnosis.trim() ? 'Заменить диагноз в черновике' : 'Выбрать диагноз в черновик'}</Button>
  </article>)}</>}
  <section className="ai-reasoning" aria-label="Варианты препаратов"><h3>Варианты препаратов</h3>
   {suggestion.medicationAssessment && <p>{suggestion.medicationAssessment.reason}</p>}
   {!suggestion.medications?.length && <p role="status">{suggestion.medicationAssessment ? 'Конкретные препараты пока не предложены.' : 'В сохранённом разборе ИИ не предложил препараты. Нажмите «Предложить препараты» для отдельного подбора.'}</p>}
   {!!suggestion.medicationAssessment?.missing.length && <div><strong>Уточнить для выбора препарата</strong><ul>{suggestion.medicationAssessment.missing.map((value, i) => <li key={i}>{value}</li>)}</ul></div>}
   {!!suggestion.medications?.length && <p className="small muted">Предложения ИИ. Показания, ограничения и инструкцию проверьте в выбранном справочнике перед назначением.</p>}
   {suggestion.medications?.map((item, i) => <article className="ai-proposal" key={i}>
   <strong>{item.name}{item.inn && item.inn !== item.name && ` · ${item.inn}`}</strong><p>{item.rationale.value}</p><Evidence value={item.rationale}/>
   {!!item.cautions.length && <div><strong>Проверить перед выбором</strong><ul>{item.cautions.map((v, j) => <li key={j}>{v}</li>)}</ul></div>}
   <Button type="button" variant="secondary" disabled={props.disabled} onClick={() => props.onFindMedication(item.name)}>Проверить {item.name} в справочнике</Button>
  </article>)}</section>
  {!!suggestion.questions?.length && <div><h3>Уточнить на приёме</h3><ol>{suggestion.questions.map((q, i) => <li key={i}>{q}</li>)}</ol></div>}
 </div>;
}

function Evidence({ value }: { value: GroundedText }) {
 return <details><summary>Основание в данных приёма</summary>{value.evidence.map((text, i) => <blockquote key={i}>{text}</blockquote>)}</details>;
}

type ReviewRow = { key: string; scope: 'visit' | 'card'; field: string; label: string; value: string; current: string; evidence: string[]; selected: boolean };
function SuggestionReview({ result, ...props }: PanelProps & { result: DraftResult }) {
 const [rows, setRows] = useState<ReviewRow[]>(() => {
  const resultRows: ReviewRow[] = [];
  for (const field of Object.keys(visitLabels) as (keyof VisitFields)[]) {
   const value = result.suggestion.visit[field]; if (!value) continue;
   const current = props.fields[field];
   const append = field === 'notes' || field === 'observation';
   resultRows.push({ key: 'visit.' + field, scope: 'visit', field, label: visitLabels[field], current,
    value: append && current && !current.includes(value.value) ? current + '\n\n' + value.value : value.value,
    evidence: value.evidence, selected: append || !current.trim() });
  }
  for (const field of Object.keys(cardLabels) as CardField[]) {
   const suggestion = result.suggestion.card[field]; if (!suggestion || (Array.isArray(suggestion) && !suggestion.length)) continue;
   const existing = props.clinical?.[field] ?? props.patient[field];
   const current = Array.isArray(existing) ? existing.join('\n') : existing || '';
   const additions = (Array.isArray(suggestion) ? suggestion : [suggestion]);
   const value = [current, ...additions.map(x => x.value).filter(text => !current.includes(text))].filter(Boolean).join('\n');
   resultRows.push({ key: 'card.' + field, scope: 'card', field, label: cardLabels[field], current, value,
    evidence: additions.flatMap(x => x.evidence), selected: true });
  }
  return resultRows;
 });
 const [applied, setApplied] = useState(false);
 function update(key: string, patch: Partial<ReviewRow>) { setApplied(false); setRows(list => list.map(row => row.key === key ? { ...row, ...patch } : row)); }
 const invalid = rows.some(r => r.selected && (r.value.length > 10000 || (r.field === 'medications' && (r.value.split('\n').filter(Boolean).length > 50 || r.value.split('\n').some(x => x.length > 200)))));
 const edited = !applied && rows.some(row => {
  if (!row.selected) return false;
  if (row.scope === 'visit') return row.current !== props.fields[row.field as keyof VisitFields];
  const field = row.field as CardField;
  const value = props.clinical?.[field] ?? props.patient[field];
  return row.current !== (Array.isArray(value) ? value.join('\n') : value || '');
 });
 return <div className="ai-suggestions">
  <h3>Проверьте предложенные поля</h3>
  <p className="small muted">Заполненные диагноз и план заменяются только при выборе соответствующего поля. Для остальных полей сохранён прежний текст. Назначения лекарств проверьте отдельно в форме приёма.</p>
  {result.suggestion.warnings.length > 0 && <div className="ai-warnings"><strong>Нужно уточнить</strong><ul>{result.suggestion.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
  {rows.map(row => <div className="ai-proposal" key={row.key}>
   <label className="checkbox"><input type="checkbox" checked={row.selected} disabled={props.disabled} onChange={e => update(row.key, { selected: e.target.checked })}/><span>{row.scope === 'card' ? 'Медкарта' : 'Приём'} · {row.label}</span></label>
   {row.current && <details><summary>Сейчас в поле</summary><p className="pre-wrap">{row.current}</p></details>}
   <Field label={`Предложение: ${row.label}`}><textarea rows={3} value={row.value} maxLength={10000} disabled={props.disabled || !row.selected} onChange={e => update(row.key, { value: e.target.value })}/></Field>
   <details><summary>Основание в исходном тексте</summary>{[...new Set(row.evidence)].map((quote, i) => <blockquote key={i}>{quote}</blockquote>)}</details>
  </div>)}
  {!rows.length && <p>В тексте нет сведений для заполнения. Дополните его и повторите обработку.</p>}
  {invalid && <p className="error-text" role="alert">Сократите текст: до 10 000 символов в поле, до 50 препаратов по 200 символов.</p>}
  {edited && <p className="error-text" role="alert">Вы изменили поля формы после подготовки предложений. Нажмите «Заполнить по тексту» ещё раз, чтобы сравнить их с текущим текстом.</p>}
  <Button type="button" disabled={props.disabled || invalid || edited || applied || !rows.some(r => r.selected)} onClick={() => {
   const fields: Partial<VisitFields> = {}; let clinical = props.clinical;
   for (const row of rows.filter(r => r.selected)) {
    if (row.scope === 'visit') fields[row.field as keyof VisitFields] = row.value;
    else {
     clinical = { ...clinical, version: props.patient.version };
     if (row.field === 'medications') clinical.medications = row.value.split('\n').map(s => s.trim()).filter(Boolean);
     else clinical[row.field as Exclude<CardField, 'medications'>] = row.value;
    }
   }
   props.onApply(fields, clinical); setApplied(true);
  }}>{applied ? 'Перенесено в форму' : 'Перенести выбранное в форму'}</Button>
  <p className="small muted">После переноса сохраните черновик или подтвердите итоговый план. Изменения медкарты сохранятся при подтверждении приёма.</p>
 </div>;
}

export function ClinicalDraftFields({ draft, patient, disabled, onChange }: { draft: ClinicalDraft; patient: Patient; disabled: boolean; onChange: (draft: ClinicalDraft | null) => void }) {
 return <div className="ai-clinical-fields"><h3>Изменения медицинской карточки</h3>
  <p className="small muted">Проверьте сведения. Они обновятся вместе с подтверждением приёма.</p>
  {!disabled && draft.version !== patient.version && <p role="alert" className="error-text">Медкарта изменилась. Уберите эти изменения и сформируйте их заново по актуальной карточке.</p>}
  {(Object.keys(cardLabels) as CardField[]).filter(key => draft[key] != null).map(key => <Field key={key} label={`Медкарта: ${cardLabels[key]}`}><textarea rows={3} disabled={disabled} maxLength={10000} value={Array.isArray(draft[key]) ? draft[key].join('\n') : draft[key] || ''} onChange={e => onChange({ ...draft, [key]: key === 'medications' ? e.target.value.split('\n') : e.target.value })}/></Field>)}
  {!disabled && <Button type="button" variant="quiet" onClick={() => onChange(null)}>Убрать изменения медкарты</Button>}
 </div>;
}

export function AiOverview() {
 const { state } = useApp();
 const visits = state.visits.filter(v => v.status !== 'confirmed' && v.status !== 'cancelled');
 return <><Heading title="Помощник врача" subtitle="Голосовые записи и черновики после приёма"/>
  <Card><Chip tone={state.ai?.enabled ? 'success' : 'warning'}>{state.ai?.enabled ? 'Ключ OpenAI настроен' : 'Ожидает настройки'}</Chip>
   <p>В приёме сохраните запись или вставьте заметки, затем нажмите «Заполнить по аудио» или «Заполнить по тексту». Факты заполнят черновик карточки. Проверьте гипотезы и варианты препаратов; выбранное лекарство найдите в справочнике. Пациент увидит диагноз и план после вашего подтверждения.</p>
   <p className="small muted">Промпт задан администратором и недоступен для редактирования врачом.</p>
   <p>В переписке и дневнике нажмите «Расшифровать голосовое» рядом с записью.</p>
   {!state.ai?.enabled && <p>Для обработки администратору нужно настроить ключ OpenAI на сервере.</p>}
   <ButtonLink to="/doctor/appointments" variant="secondary">К расписанию</ButtonLink>
  </Card><Card><h2>Приёмы для заполнения</h2>{visits.length ? visits.map(v => <ButtonLink key={v.id} to={`/doctor/visit/${v.id}`} variant="secondary">{state.patients.find(p => p.id === v.patientId)?.name} · {dateTime(v.scheduled)}</ButtonLink>) : <Empty title="Нет незавершённых приёмов"/>}</Card>
 </>;
}
