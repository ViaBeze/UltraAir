import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api, dateTime, today, uid, useAction, useApp } from './state';
import { Button, Card, Chip, Empty, Field, Heading } from './ui';
import './pharmacy.css';

type Point = { lat: number; lon: number };
type Place = Point & { id: string; name: string; address: string; distance: number; source: string; url: string;
 availability: 'available' | 'unavailable' | 'unknown'; price: number | null; medicine?: string; form?: string; packageSize?: number | null; updatedAt: string | null; stale?: boolean };
type SearchResult = { items: Place[]; inventoryConnected: boolean; checkedAt: string; warning: string };
type BasketRow = { id: string; name: string; price: string; quantity: string; mode: 'packs' | 'course'; units: string; daily: string; days: string; source: string };
const money = (value: number) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(value);
const cities = [
 { name: 'Москва', lat: 55.7558, lon: 37.6173 }, { name: 'Санкт-Петербург', lat: 59.9386, lon: 30.3141 },
 { name: 'Казань', lat: 55.7961, lon: 49.1064 }, { name: 'Екатеринбург', lat: 56.8389, lon: 60.6057 },
 { name: 'Новосибирск', lat: 55.0302, lon: 82.9204 }, { name: 'Краснодар', lat: 45.0355, lon: 38.9753 },
];
const aviandrShops = [
 { name: 'Ютека · аптеки и цены', url: 'https://uteka.ru/product/aviandr-399720/' },
 { name: 'ЕАПТЕКА · наличие и самовывоз', url: 'https://www.eapteka.ru/goods/aviandr/' },
];
function newRow(name = '', price = '', units = '', source = ''): BasketRow {
 return { id: uid(), name, price, quantity: '1', mode: 'packs', units, daily: '', days: '', source };
}
function rowCost(row: BasketRow) {
 const positive = (text: string) => text.trim() && Number.isFinite(Number(text)) && Number(text) > 0;
 const integer = (text: string) => positive(text) && Number.isInteger(Number(text));
 const hundredths = (text: string) => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
 };
 const daily = hundredths(row.daily);
 const count = row.mode === 'packs' ? (integer(row.quantity) && Number(row.quantity) <= 10000 ? Number(row.quantity) : null)
  : integer(row.units) && daily !== null && daily > 0 && daily <= 100000 && integer(row.days) && Number(row.units) <= 10000 && Number(row.days) <= 3650
   ? Math.ceil(daily * Number(row.days) / (Number(row.units) * 100)) : null;
 const cents = positive(row.price) && Number(row.price) <= 10000000 ? hundredths(row.price) : null;
 return { count, total: row.name.trim() && count !== null && cents !== null && cents > 0 ? count * cents : null };
}

function PharmacyMap({ center, items, selected, onSelect, onSearch, busy }: {
 center: Point; items: Place[]; selected: string | null; onSelect: (id: string) => void; onSearch: (center: Point) => void; busy: boolean;
}) {
 const element = useRef<HTMLDivElement>(null); const map = useRef<L.Map | null>(null); const layers = useRef<L.LayerGroup | null>(null);
 const select = useRef(onSelect); select.current = onSelect;
 const [tileError, setTileError] = useState(false);
 useEffect(() => {
  if (!element.current) return;
  const instance = L.map(element.current, { scrollWheelZoom: false }).setView([center.lat, center.lon], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
   maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
  }).on('tileerror', () => setTileError(true)).addTo(instance);
  map.current = instance; layers.current = L.layerGroup().addTo(instance);
  const resize = new ResizeObserver(() => instance.invalidateSize()); resize.observe(element.current);
  return () => { resize.disconnect(); instance.remove(); map.current = null; layers.current = null; };
 }, []);
 useEffect(() => { map.current?.setView([center.lat, center.lon], 13); }, [center.lat, center.lon]);
 useEffect(() => {
  layers.current?.clearLayers();
  for (const place of items) {
   const available = place.availability === 'available';
   const node = document.createElement('div');
   const title = document.createElement('strong'); title.textContent = place.name; node.append(title);
   const detail = document.createElement('p'); detail.textContent = `${place.address} · ${available && place.price !== null ? money(place.price) + ' / уп.' : place.availability === 'unavailable' ? 'Нет в наличии' : 'Наличие уточняется'}`; node.append(detail);
   const marker = L.marker([place.lat, place.lon], { title: place.name, alt: `Аптека: ${place.name}`, icon: L.divIcon({
    className: `pharmacy-marker ${available ? 'available' : ''} ${selected === place.id ? 'selected' : ''}`,
    html: '<span aria-hidden="true">+</span>', iconSize: [30, 36], iconAnchor: [15, 36], popupAnchor: [0, -36],
   }) }).bindPopup(node).on('click', () => select.current(place.id));
   if (layers.current) marker.addTo(layers.current);
   if (selected === place.id) marker.openPopup();
  }
 }, [items, selected]);
 return <div className="pharmacy-map-wrapper"><div ref={element} className="pharmacy-map" role="region" aria-label="Карта аптек"/>
  <Button type="button" variant="secondary" className="map-search" disabled={busy} onClick={() => { const position = map.current?.getCenter(); if (position) onSearch({ lat: Math.max(-85, Math.min(85, position.lat)), lon: ((position.lng + 180) % 360 + 360) % 360 - 180 }); }}>Искать в этой области</Button>
  {tileError && <p className="small map-warning" role="status">Карта загружается не полностью. Адреса и ссылки доступны в списке аптек.</p>}
 </div>;
}

export function Pharmacy() {
 const { state, user } = useApp(); const [params] = useSearchParams(); const search = useAction(); const location = useAction();
 const [query, setQuery] = useState(params.get('medicine')?.slice(0, 120) || 'Авиандр');
 const [patientId, setPatientId] = useState(params.get('patient') || (user?.role === 'patient' ? state.patients[0]?.id : '') || '');
 const [center, setCenter] = useState<Point>(cities[0]); const [city, setCity] = useState('Москва');
 const [radius, setRadius] = useState(3000); const [result, setResult] = useState<SearchResult | null>(null);
 const [searched, setSearched] = useState(''); const [selected, setSelected] = useState<string | null>(null); const [availableOnly, setAvailableOnly] = useState(false);
 const [basket, setBasket] = useState<BasketRow[]>(() => [newRow(params.get('medicine') || 'Авиандр')]);
 const [addressEnabled, setAddressEnabled] = useState(false); const [address, setAddress] = useState('');
 const [locations, setLocations] = useState<(Point & { name: string })[]>([]);
 const list = useRef<HTMLDivElement>(null);
 useEffect(() => { void api<{ addressSearch: boolean }>('/pharmacies/config').then(value => setAddressEnabled(value.addressSearch)).catch(() => {}); }, []);
 const medications = state.prescriptions.filter(m => m.patientId === patientId && m.active && (!m.end || m.end >= today()));
 const items = (result?.items || []).filter(item => !availableOnly || item.availability === 'available');
 const costs = basket.map(rowCost); const missing = costs.filter(cost => cost.total === null).length;
 const subtotal = costs.reduce((sum, cost) => sum + (cost.total || 0), 0) / 100;
 const busy = search.busy || location.busy;
 function find(point = center) {
  if (query.trim().length < 2) return;
  const medicine = query.trim();
  void search.run(async () => {
   setResult(null); setSelected(null); setSearched(medicine);
   const data = await api<SearchResult>('/pharmacies/search', 'POST', { ...point, radius, query: medicine }, 30000);
   setResult(data);
  });
 }
 function changeArea(point: Point, name: string) { setCenter({ lat: point.lat, lon: point.lon }); setCity(name); setResult(null); setSelected(null); setLocations([]); }
 function updateRow(id: string, patch: Partial<BasketRow>) { setBasket(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row)); }
 function select(id: string) { setSelected(id); list.current?.querySelector<HTMLElement>(`[data-place-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
 return <><Heading title="Аптека" subtitle="Найти аптеку рядом и рассчитать стоимость лекарств"/>
  <Card className="pharmacy-search"><div className="form-grid">
   <Field label="Препарат для поиска"><input disabled={busy} value={query} maxLength={120} onChange={e => { setQuery(e.target.value); setResult(null); }} placeholder="Авиандр"/></Field>
   <Field label="Город"><select disabled={busy} value={city} onChange={e => { const chosen = cities.find(item => item.name === e.target.value); if (chosen) changeArea(chosen, chosen.name); }}>{!cities.some(item => item.name === city) && <option value={city}>{city}</option>}{cities.map(item => <option key={item.name}>{item.name}</option>)}</select></Field>
   <Field label="Радиус поиска"><select disabled={busy} value={radius} onChange={e => { setRadius(Number(e.target.value)); setResult(null); }}>{[1000, 3000, 5000, 10000].map(value => <option key={value} value={value}>{value / 1000} км</option>)}</select></Field>
  </div><div className="row wrap">
   <Button disabled={busy || query.trim().length < 2} onClick={() => find()}>{search.busy ? 'Ищем аптеки…' : 'Найти аптеки'}</Button>
   <Button variant="secondary" disabled={busy} onClick={() => void location.run(async () => {
    if (!navigator.geolocation) throw new Error('Геопозиция недоступна. Выберите город или переместите карту.');
    const point = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, () => reject(new Error('Не удалось определить местоположение. Разрешите доступ или выберите область на карте.')), { timeout: 10000, maximumAge: 60000 }));
    changeArea({ lat: point.coords.latitude, lon: point.coords.longitude }, 'Моё местоположение');
   })}>{location.busy ? 'Определяем…' : 'Рядом со мной'}</Button>
   <Button variant="quiet" disabled={busy} onClick={() => { setQuery('Авиандр'); setResult(null); }}>Авиандр</Button>
   <a className="button quiet" href={`https://yandex.ru/maps/?ll=${center.lon}%2C${center.lat}&z=13&text=${encodeURIComponent('аптеки')}`} target="_blank" rel="noopener noreferrer">Аптеки на Яндекс.Картах ↗</a>
  </div><p className="small muted">Другой город можно выбрать на карте. Поиск использует выбранную область, без данных медицинской карточки.</p>
  {addressEnabled && <><Field label="Город или адрес"><input disabled={busy} maxLength={120} value={address} onChange={e => setAddress(e.target.value)}/></Field><Button variant="secondary" disabled={busy || address.trim().length < 2} onClick={() => void location.run(async () => { const data = await api<{ items: (Point & { name: string })[] }>('/pharmacies/location', 'POST', { query: address.trim() }); setLocations(data.items); if (!data.items.length) throw new Error('Адрес не найден. Уточните запрос.'); })}>Найти адрес</Button>{locations.map(item => <Button key={item.name} variant="quiet" onClick={() => changeArea(item, item.name)}>{item.name}</Button>)}</>}
  {(search.error || location.error) && <p role="alert" className="error-text">{search.error || location.error}</p>}
  </Card>
  {/^авиандр(?:®)?(?:\s|$)/i.test(query.trim()) && <Card className="aviandr-shops"><h2>Где купить Авиандр</h2>
   <p>Проверьте наличие и цену на сайте аптеки. Выберите свой город и нужную упаковку, затем перенесите цену в расчёт ниже.</p>
   <div className="row wrap">{aviandrShops.map(shop => <a key={shop.url} className="button secondary" href={shop.url} target="_blank" rel="noopener noreferrer">{shop.name} ↗</a>)}</div>
  </Card>}
  <div className="pharmacy-layout"><Card className="pharmacy-map-card"><PharmacyMap center={center} items={items} selected={selected} onSelect={select} busy={busy || query.trim().length < 2} onSearch={point => { changeArea(point, 'Выбранная область'); find(point); }}/><p className="small muted">Зелёная метка — наличие по данным аптеки. Серая — наличие не подтверждено.</p></Card>
   <Card className="pharmacy-results"><div className="row between wrap"><h2>{result ? `Аптеки · ${items.length}` : 'Аптеки рядом'}</h2><label className="checkbox"><input type="checkbox" checked={availableOnly} onChange={e => setAvailableOnly(e.target.checked)}/>С подтверждённым наличием</label></div>
    {search.busy && <p role="status">Загружаем аптеки в выбранной области…</p>}
    {!result && !search.busy && <Empty title="Выберите область и начните поиск">На карте появятся аптеки, а здесь — адреса и сведения о наличии.</Empty>}
    {result && <>
     <p className="small muted">{searched} · поиск {dateTime(result.checkedAt)}</p>
     {!result.inventoryConnected && <p className="pharmacy-notice">Наличие и цены пока не подключены. Уточните наличие {searched} в выбранной аптеке; цену можно внести в калькулятор.</p>}
     {result.warning && <p role="alert" className="error-text">{result.warning}</p>}
     {!items.length && !result.warning && <Empty title={availableOnly ? 'Подтверждённое наличие не найдено' : 'Аптеки в этой области не найдены'}>Измените область или радиус поиска.</Empty>}
     <div ref={list} className="pharmacy-place-list">{items.map(place => <article className={`pharmacy-place ${selected === place.id ? 'is-selected' : ''}`} key={place.id} data-place-id={place.id}>
      <div className="row between"><h3>{place.name}</h3><span className="small muted">{place.distance >= 1000 ? `${(place.distance / 1000).toFixed(1)} км` : `${place.distance} м`}</span></div>
      <p>{place.address}</p><Chip tone={place.availability === 'available' ? 'success' : 'neutral'}>{place.availability === 'available' ? 'В наличии по данным аптеки' : place.availability === 'unavailable' ? 'Нет в наличии' : 'Наличие уточняется'}</Chip>
      {place.medicine && <p>{place.medicine} · {place.form}</p>}{place.price !== null && <strong>{money(place.price)} / упаковка</strong>}
      <p className="small muted">{place.source}{place.updatedAt ? ` · ${dateTime(place.updatedAt)}` : ''}{place.stale ? ' · данные устарели' : ''}</p>
      <div className="row wrap"><Button variant="quiet" onClick={() => setSelected(place.id)}>На карте</Button><a href={`https://yandex.ru/maps/?rtext=~${place.lat}%2C${place.lon}&rtt=auto`} target="_blank" rel="noopener noreferrer">Маршрут ↗</a><a href={place.url} target="_blank" rel="noopener noreferrer">{place.medicine ? 'На сайте аптеки ↗' : 'Карточка аптеки ↗'}</a></div>
      {place.price !== null && <Button variant="secondary" onClick={() => setBasket(rows => [...rows.filter(row => !(row.name === searched && !row.price)), newRow(`${place.medicine} · ${place.form}`, String(place.price), place.packageSize ? String(place.packageSize) : '', `${place.name} · ${place.updatedAt ? dateTime(place.updatedAt) : ''}`)])}>Добавить в расчёт</Button>}
     </article>)}</div>
    </>}
   </Card>
  </div>
  <Card><h2>Расчёт стоимости</h2><p>Укажите цену упаковки и необходимое количество</p>
   {user?.role === 'doctor' && <Field label="Назначения пациента для расчёта"><select value={patientId} onChange={e => setPatientId(e.target.value)}><option value="">Выберите пациента</option>{state.patients.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
   {!!medications.length && <div className="row wrap">{medications.map(m => <Button key={m.id} variant="secondary" onClick={() => setBasket(rows => [...rows, newRow(m.name)])}>+ {m.name}</Button>)}</div>}
   <div className="cost-rows">{basket.map((row, index) => <fieldset className="cost-row" key={row.id}><legend>Препарат для расчёта {index + 1}</legend>
    <div className="form-grid"><Field label="Название препарата и упаковка"><input maxLength={300} value={row.name} onChange={e => updateRow(row.id, { name: e.target.value })}/></Field><Field label="Цена упаковки, ₽"><input type="number" inputMode="decimal" min="0.01" max="10000000" step="0.01" value={row.price} onChange={e => updateRow(row.id, { price: e.target.value, source: '' })}/></Field><Field label="Способ расчёта"><select value={row.mode} onChange={e => updateRow(row.id, { mode: e.target.value as BasketRow['mode'] })}><option value="packs">По упаковкам</option><option value="course">На курс</option></select></Field></div>
    {row.mode === 'packs' ? <Field label="Количество упаковок"><input type="number" min="1" max="10000" step="1" value={row.quantity} onChange={e => updateRow(row.id, { quantity: e.target.value })}/></Field> : <div className="form-grid"><Field label="Единиц в упаковке"><input type="number" min="1" max="10000" step="1" value={row.units} onChange={e => updateRow(row.id, { units: e.target.value })}/></Field><Field label="Единиц в сутки по назначению"><input type="number" min="0.01" max="1000" step="0.01" value={row.daily} onChange={e => updateRow(row.id, { daily: e.target.value })}/></Field><Field label="Длительность курса, дней"><input type="number" min="1" max="3650" step="1" value={row.days} onChange={e => updateRow(row.id, { days: e.target.value })}/></Field></div>}
    <div className="row between wrap"><p className="small muted">{row.source || 'Цена вводится вручную'}{costs[index].count !== null ? ` · ${costs[index].count} уп.` : ''}</p><strong>{costs[index].total === null ? 'Заполните данные для расчёта' : money(costs[index].total! / 100)}</strong><Button variant="quiet" onClick={() => setBasket(rows => rows.filter(item => item.id !== row.id))}>Удалить из расчёта</Button></div>
   </fieldset>)}</div>
   <Button variant="secondary" onClick={() => setBasket(rows => [...rows, newRow()])}>+ Препарат в расчёт</Button>
   <div className="cost-total" aria-live="polite"><span>{missing ? 'Промежуточная сумма' : 'Итого'}</span><strong>{money(subtotal)}</strong>{missing > 0 && <p>Не рассчитано позиций: {missing}. Общая стоимость станет доступна после заполнения данных.</p>}</div>
   <p className="small muted">Количество упаковок на курс округляется вверх. Единицы в упаковке и в сутки должны совпадать, например таблетки. Дозировка из назначения не пересчитывается автоматически. Цены и наличие уточняйте в аптеке.</p>
  </Card>
 </>;
}
