import { useEffect, useRef, useState } from 'react';
import { api, dateTime, useAction, useApp } from './state';
import { Button, Field } from './ui';
import './ai.css';

export type MedicineResult = { name: string; inn: string | null; form: string | null; strength: string | null; manufacturer: string | null; url: string };
type SearchResult = { items: MedicineResult[]; source: string; query: string; checkedAt: string; mode: string };
const sources = ['РЛС', 'Видаль', 'ГРЛС'];
const links: Record<string, string> = { 'РЛС': 'https://www.rlsnet.ru/search_result.htm?word=', 'Видаль': 'https://www.vidal.ru/search?t=all&q=', 'ГРЛС': 'https://grls.rosminzdrav.ru/' };

export function MedicationCatalog({ disabled = false, initialQuery, onChoose }: {
 disabled?: boolean; initialQuery?: { value: string; sequence: number }; onChoose?: (item: MedicineResult) => void;
}) {
 const { state, mutate, toast } = useApp(); const action = useAction(); const preference = useAction();
 const [source, setSource] = useState(sources.includes(state.settings.source) ? state.settings.source : 'РЛС');
 const [query, setQuery] = useState(''); const [result, setResult] = useState<SearchResult | null>(null);
 const input = useRef<HTMLInputElement>(null); const pending = action.busy || disabled;
 useEffect(() => {
  if (initialQuery) { setQuery(initialQuery.value); setResult(null); input.current?.focus(); input.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
 }, [initialQuery]);
 function search() {
  void action.run(async () => { setResult(null); setResult(await api<SearchResult>('/medicines/search', 'POST', { query: query.trim(), source }, 115000)); });
 }
 return <section className="medicine-catalog" aria-label="Лекарственный справочник">
  <h3>Лекарственный справочник</h3>
  <div className="form-grid">
   <Field label="База лекарств"><select disabled={pending || preference.busy} value={source} onChange={e => { setSource(e.target.value); setResult(null); }}>{sources.map(s => <option key={s}>{s}</option>)}</select></Field>
   <Field label="Название или МНН"><input ref={input} disabled={pending} maxLength={120} value={query} onChange={e => { setQuery(e.target.value); setResult(null); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (query.trim().length >= 2 && !pending && state.ai?.enabled) search(); } }} placeholder="Например, название препарата"/></Field>
  </div>
  <div className="row wrap">
   <Button type="button" variant="secondary" disabled={pending || !state.ai?.enabled || query.trim().length < 2} onClick={search}>{action.busy ? 'Ищем в справочнике…' : 'Найти препарат'}</Button>
   <Button type="button" variant="quiet" disabled={disabled || preference.busy || state.settings.source === source} onClick={() => void preference.run(async () => { await mutate('/settings', 'PUT', { ...state.settings, source }); toast('База лекарств сохранена'); })}>Использовать эту базу по умолчанию</Button>
   <a className="button quiet" target="_blank" rel="noopener noreferrer" href={links[source] + (source === 'ГРЛС' ? '' : encodeURIComponent(query))}>Открыть {source}</a>
  </div>
  <p className="small muted">Поиск по открытым страницам справочника. В OpenAI и поисковый сервис передаётся только введённое название. Полнота и актуальность выдачи ограничены доступностью источника; инструкцию проверьте по ссылке.</p>
  {(action.error || preference.error) && <p role="alert" className="error-text">{action.error || preference.error}</p>}
  {result && <div className="medicine-results">
   <p className="small muted">{result.source} · поиск {dateTime(result.checkedAt)}</p>
   {!result.items.length && <p role="status">Подтверждённые ссылки на препараты не найдены. Уточните название, выберите другую базу или откройте справочник.</p>}
   {result.items.map(item => <article className="ai-proposal" key={item.url}>
    <strong>{item.name}</strong>
    {item.inn && <span>МНН: {item.inn}</span>}
    {(item.form || item.strength) && <span>{[item.form, item.strength].filter(Boolean).join(' · ')}</span>}
    {item.manufacturer && <small>{item.manufacturer}</small>}
    <div className="row wrap"><a target="_blank" rel="noopener noreferrer" href={item.url}>Карточка и инструкция · {result.source}</a>
     {onChoose && <Button type="button" variant="secondary" disabled={disabled} onClick={() => onChoose(item)}>Выбрать {item.name}</Button>}
    </div>
   </article>)}
   {onChoose && result.items.length > 0 && <p className="small muted">Выбор заполнит название. Дозу и расписание укажите в назначении; содержание вещества в таблетке не является назначенной дозой.</p>}
  </div>}
 </section>;
}
