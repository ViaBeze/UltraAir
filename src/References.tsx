import { useEffect, useRef, useState } from 'react';
import { api, dateTime, useAction, useApp } from './state';
import type { Citation, Patient } from './state';
import { Button, Card, CardHeading, Field } from './ui';
import './medications.css';

export const citationTargets: Record<Citation['target'], string> = {
 general: 'Обоснование', dose: 'Дозировка', indication: 'Область применения',
 sideEffects: 'Побочные эффекты', interactions: 'Взаимодействия',
};
const sourceDomains: Record<string, string[]> = {
 'РЛС': ['rlsnet.ru', 'www.rlsnet.ru'], 'Видаль': ['vidal.ru', 'www.vidal.ru'],
 'ГРЛС': ['grls.rosminzdrav.ru'], 'Минздрав': ['cr.minzdrav.gov.ru'],
 'МКБ-10': ['icd.who.int'], 'Cochrane': ['cochranelibrary.com', 'www.cochranelibrary.com'],
};
const sourceHomes: Record<string, string> = {
 'РЛС': 'https://www.rlsnet.ru/', 'Видаль': 'https://www.vidal.ru/', 'ГРЛС': 'https://grls.rosminzdrav.ru/',
 'Минздрав': 'https://cr.minzdrav.gov.ru/', 'МКБ-10': 'https://icd.who.int/browse10/2019/en', 'Cochrane': 'https://www.cochranelibrary.com/',
};
function quoteLink(citation: Citation) {
 if (!citation.url) return '';
 const [document, fragment = ''] = citation.url.split('#');
 const section = fragment.split(':~:')[0];
 return `${document}#${section}:~:text=${encodeURIComponent(citation.quote).replace(/-/g, '%2D')}`;
}
export function CitationList({ items = [], onRemove }: { items?: Citation[]; onRemove?: (index: number) => void }) {
 if (!items.length) return null;
 return <div className="citation-list">{items.map((citation, index) => <article className="citation" key={`${index}-${citation.url}`}>
  <div className="row between wrap"><strong>{citationTargets[citation.target] || 'Обоснование'} · {citation.source}</strong>{onRemove && <Button type="button" variant="quiet" aria-label={`Удалить цитату ${index + 1}`} onClick={() => onRemove(index)}>Удалить</Button>}</div>
  <blockquote>{citation.quote}</blockquote><p className="small">{citation.title} · {citation.section}</p>
  {citation.url && <a target="_blank" rel="noopener noreferrer" href={quoteLink(citation)}>Открыть цитату в источнике ↗</a>}
 </article>)}</div>;
}

type SearchResult = { items: (Citation & { quoteVerified: boolean })[]; checkedAt: string };
const initial: Citation = { source: 'РЛС', title: '', url: '', section: '', quote: '', target: 'general' };
export function ReferencesEditor({ value, onChange, disabled = false, initialQuery = '' }: {
 value: Citation[]; onChange: (items: Citation[]) => void; disabled?: boolean; initialQuery?: string;
}) {
 const { state } = useApp(); const search = useAction();
 const [draft, setDraft] = useState<Citation>(initial); const [query, setQuery] = useState(initialQuery);
 const queryEdited = useRef(false);
 useEffect(() => { if (!queryEdited.current) setQuery(initialQuery); }, [initialQuery]);
 const [result, setResult] = useState<SearchResult | null>(null); const [error, setError] = useState('');
 function attach(citation: Citation) {
  if (value.length >= 20) { setError('Можно прикрепить до 20 цитат.'); return; }
  if (value.some(item => item.quote === citation.quote && item.url === citation.url && item.target === citation.target)) { setError('Эта цитата уже прикреплена.'); return; }
  onChange([...value, citation]); setError('');
 }
 function addManual() {
  const citation = { ...draft, title: draft.title.trim(), section: draft.section.trim(), quote: draft.quote.trim(), url: draft.url.trim() };
  if (!citation.title || !citation.section || !citation.quote) { setError('Укажите документ, раздел и дословную цитату.'); return; }
  if (citation.source !== 'Тюльпин') {
   try {
    const url = new URL(citation.url);
    if (url.protocol !== 'https:' || !sourceDomains[citation.source]?.includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new Error();
   } catch { setError('Вставьте HTTPS-ссылку на документ выбранного источника.'); return; }
  }
  attach(citation);
 }
 return <section className="references-editor" aria-label="Цитаты и источники">
  <h3>Цитаты и источники</h3>
  <CitationList items={value} onRemove={disabled ? undefined : index => onChange(value.filter((_, i) => i !== index))}/>
  {!disabled && <details><summary>+ Прикрепить цитату</summary><fieldset disabled={search.busy || value.length >= 20} className="reference-fields">
   <div className="form-grid">
    <Field label="Источник цитаты"><select value={draft.source} onChange={e => { setDraft({ ...draft, source: e.target.value as Citation['source'], url: '' }); setResult(null); }}>{[...Object.keys(sourceDomains), 'Тюльпин'].map(source => <option key={source} value={source}>{source === 'Минздрав' ? 'Клинические рекомендации · Минздрав' : source === 'Тюльпин' ? 'Учебник психиатрии · Тюльпин' : source}</option>)}</select></Field>
    <Field label="К чему относится цитата"><select value={draft.target} onChange={e => setDraft({ ...draft, target: e.target.value as Citation['target'] })}>{Object.entries(citationTargets).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
   </div>
   {draft.source !== 'Тюльпин' && <>
    <Field label="Поиск по источнику" hint="Только препарат или тема рекомендаций, без данных пациента."><input value={query} maxLength={120} onChange={e => { queryEdited.current = true; setQuery(e.target.value); setResult(null); }} placeholder="Название препарата или рекомендации"/></Field>
    <div className="row wrap"><Button type="button" variant="secondary" disabled={!state.ai?.enabled || query.trim().length < 2} onClick={() => void search.run(async () => { setResult(null); setResult(await api<SearchResult>('/references/search', 'POST', { source: draft.source, query: query.trim() }, 130000)); })}>{search.busy ? 'Проверяем источники…' : 'Найти цитаты'}</Button><a href={sourceHomes[draft.source]} target="_blank" rel="noopener noreferrer">Открыть источник ↗</a></div>
    {!state.ai?.enabled && <p className="small muted">Автоматический поиск пока недоступен. Можно открыть источник и прикрепить цитату вручную.</p>}
   </>}
   {result && <div className="citation-list"><p className="small muted">Поиск: {dateTime(result.checkedAt)}</p>{!result.items.length && <p role="status">Документы не найдены. Уточните запрос или откройте источник.</p>}{result.items.map((item, index) => <article className="citation" key={index}>
    <strong>{item.title}</strong><p className="small">{item.section}</p>
    {item.quote ? <blockquote>{item.quote}</blockquote> : <p className="small muted">Дословную цитату не удалось сверить с текстом страницы. Откройте документ и скопируйте нужный фрагмент вручную.</p>}
    <div className="row wrap"><a href={item.url} target="_blank" rel="noopener noreferrer">Открыть документ ↗</a>{item.quote && <Button type="button" variant="secondary" onClick={() => attach({ source: item.source, title: item.title, url: item.url, section: item.section, quote: item.quote, target: draft.target })}>Прикрепить найденную цитату</Button>}</div>
   </article>)}</div>}
   <h4>Цитата из открытого документа</h4>
   <Field label={draft.source === 'Тюльпин' ? 'Название учебника и издание' : 'Название документа'}><input maxLength={300} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })}/></Field>
   {draft.source !== 'Тюльпин' && <Field label="Прямая ссылка на документ"><input maxLength={2000} value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} placeholder="https://…"/></Field>}
   <Field label="Раздел или страница"><input maxLength={300} value={draft.section} onChange={e => setDraft({ ...draft, section: e.target.value })}/></Field>
   <Field label="Дословная цитата"><textarea rows={3} maxLength={2500} value={draft.quote} onChange={e => setDraft({ ...draft, quote: e.target.value })}/></Field>
   <Button type="button" variant="secondary" onClick={addManual}>Прикрепить цитату к записи</Button>
   <p className="small muted">Проверьте редакцию документа и применимость фрагмента. Цитаты сохранятся вместе с записью.</p>
  </fieldset></details>}
  {(error || search.error) && <p className="error-text" role="alert">{error || search.error}</p>}
 </section>;
}

export function PatientReferences({ patient }: { patient: Patient }) {
 const { mutate, toast } = useApp(); const action = useAction(); const [editing, setEditing] = useState(false);
 const [citations, setCitations] = useState(patient.citations || []); const [version, setVersion] = useState(patient.version);
 return <Card><CardHeading title="Источники в карточке" action={!editing && <Button type="button" variant="quiet" onClick={() => { setCitations(patient.citations || []); setVersion(patient.version); setEditing(true); }}>Редактировать цитаты</Button>}/>
  {editing ? <><ReferencesEditor value={citations} onChange={setCitations} disabled={action.busy}/>
   {action.error && <p role="alert" className="error-text">{action.error}</p>}
   <div className="row wrap"><Button disabled={action.busy} onClick={() => void action.run(async () => { await mutate(`/patients/${patient.id}/clinical`, 'PUT', { version, citations }); setEditing(false); toast('Цитаты сохранены в карточке'); })}>Сохранить цитаты</Button><Button variant="quiet" disabled={action.busy} onClick={() => setEditing(false)}>Отмена</Button></div>
  </> : <>{patient.citations?.length ? <CitationList items={patient.citations}/> : <p className="muted">Прикрепите цитату из справочника или клинических рекомендаций к медицинской карточке.</p>}</>}
 </Card>;
}
