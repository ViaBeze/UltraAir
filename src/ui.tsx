import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ArrowRight, ArrowLeft, X, Check, BookOpen, Pill, ChartNoAxesCombined, Leaf, Settings, Search, Mic, Square, Pause, Play, Download, ShieldCheck, Clock, Send, Plus, Eye, EyeOff, Copy, ChevronRight, Phone, ExternalLink, FileText, Volume2, Droplet, Wine, CircleHelp } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useAction, useApp } from './state';
const extra={help:CircleHelp,arrow:ArrowRight,back:ArrowLeft,close:X,check:Check,diary:BookOpen,pill:Pill,chart:ChartNoAxesCombined,leaf:Leaf,settings:Settings,search:Search,mic:Mic,stop:Square,pause:Pause,play:Play,download:Download,shield:ShieldCheck,clock:Clock,send:Send,plus:Plus,eye:Eye,eyeOff:EyeOff,copy:Copy,chevron:ChevronRight,phone:Phone,external:ExternalLink,file:FileText,volume:Volume2,drop:Droplet,glass:Wine};
export type IconName=keyof typeof extra|'heart'|'home'|'people'|'calendar'|'chat'|'sparkle'|'sos'|'bell';
export function Icon({name,className=''}:{name:IconName;className?:string}){const Component=extra[name as keyof typeof extra];return <span className={`icon ${className}`} aria-hidden="true">{Component?<Component size={22} strokeWidth={1.65}/>:<img src={`/assets/${name}.svg`} alt="" width="24" height="24"/>}</span>;}
export function Logo(){const location=useLocation();return <Link className="logo" to={location.pathname.startsWith('/doctor')?'/doctor/overview':'/patient/today'} aria-label="Рядом — главная"><span className="logo-mark"><Icon name="heart"/></span><span>рядом</span></Link>;}
export function Button({children,variant='primary',icon,className='',...props}:ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'primary'|'secondary'|'quiet'|'danger';icon?:IconName}){return <button className={`button ${variant} ${className}`} {...props}>{icon&&<Icon name={icon}/>}<span>{children}</span></button>;}
export function ButtonLink({children,to,variant='primary',icon,className='',onClick}:{children:ReactNode;to:string;variant?:string;icon?:IconName;className?:string;onClick?:()=>void}){return <Link to={to} onClick={onClick} className={`button ${variant} ${className}`}>{icon&&<Icon name={icon}/>}<span>{children}</span></Link>;}
export function Avatar({name='АМ',large=false}:{name?:string;large?:boolean}){return <span className={`avatar ${large?'large':''}`} aria-hidden="true">{name}</span>;}
export function Chip({children,tone='neutral'}:{children:ReactNode;tone?:string}){return <span className={`chip ${tone}`}>{children}</span>;}
export function Heading({title,subtitle,action}:{title:string;subtitle?:string;action?:ReactNode}){return <div className="page-heading"><div><h1>{title}</h1>{subtitle&&<p>{subtitle}</p>}</div>{action}</div>;}
export function Card({children,className='',id,tour}:{children:ReactNode;className?:string;id?:string;tour?:string}){return <section id={id} data-tour={tour} className={`card ${className}`}>{children}</section>;}
export function CardHeading({title,action}:{title:string;action?:ReactNode}){return <div className="card-heading"><h2>{title}</h2>{action}</div>;}
export function Field({label,children,hint,tour}:{label:string;children:ReactNode;hint?:string;tour?:string}){
 const id=useId(); const labelId=id+'-label'; const hintId=id+'-hint';
 function labelControls(nodes:ReactNode):ReactNode{return Children.map(nodes,node=>{if(!isValidElement<Record<string,unknown>>(node))return node; if(typeof node.type==='string'&&['input','textarea','select'].includes(node.type))return cloneElement(node,{id,'aria-labelledby':labelId,'aria-describedby':hint?hintId:undefined});if(node.props.children)return cloneElement(node,{},labelControls(node.props.children as ReactNode));return node;});}
 return <div className="field" data-tour={tour}><label id={labelId} htmlFor={id}>{label}</label>{labelControls(children)}{hint&&<small id={hintId}>{hint}</small>}</div>;
}
export function Detail({label,children}:{label:string;children:ReactNode}){return <div className="detail"><span>{label}</span><p>{children}</p></div>;}
export function Empty({title,children}:{title:string;children?:ReactNode}){return <div className="empty"><Icon name="leaf"/><h3>{title}</h3>{children&&<p>{children}</p>}</div>;}
export function Modal({title,children,onClose,initialFocus}:{title:string;children:ReactNode;onClose:()=>void;initialFocus?:string}){
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const d=ref.current;d?.showModal();if(initialFocus)d?.querySelector<HTMLElement>(initialFocus)?.focus();const old=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.body.style.overflow=old;};},[initialFocus]);
 return <dialog ref={ref} className="modal" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===ref.current)onClose();}} aria-labelledby="modal-title"><div className="modal-inner"><div className="card-heading"><h2 id="modal-title">{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть"><Icon name="close"/></button></div>{children}</div></dialog>;
}
export function Tabs({items,value,onChange}:{items:string[];value:string;onChange:(v:string)=>void}){return <div className="tabs" role="group" aria-label="Выбор раздела">{items.map(item=><button key={item} aria-pressed={value===item} className={value===item?'selected':''} onClick={()=>onChange(item)}>{item}</button>)}</div>;}
export function DeleteAudioButton({onDelete,disabled=false,saved=false}:{onDelete:()=>void|Promise<void>;disabled?:boolean;saved?:boolean}){
 const [confirm,setConfirm]=useState(false);const action=useAction();const {toast}=useApp();
 return <><Button type="button" variant="quiet" disabled={disabled||action.busy} onClick={()=>setConfirm(true)}>Удалить запись</Button>{confirm&&<Modal title="Удалить голосовую запись?" initialFocus="[data-audio-cancel]" onClose={()=>{if(!action.busy)setConfirm(false);}}><p>{saved?'Аудиозапись и её расшифровка будут удалены. Текст сообщения, дневника и итоги приёма сохранятся.':'Аудиозапись будет удалена. Вы сможете записать новую.'}</p>{action.error&&<p className="error-text" role="alert">{action.error}</p>}<div className="row wrap"><Button type="button" variant="secondary" data-audio-cancel disabled={action.busy} onClick={()=>setConfirm(false)}>Отмена</Button><Button type="button" variant="danger" disabled={disabled||action.busy} onClick={()=>void action.run(async()=>{await onDelete();setConfirm(false);toast('Голосовая запись удалена');})}>{action.busy?'Удаляем…':'Удалить запись'}</Button></div></Modal>}</>;
}
export function Recorder({compact=false,value,onComplete,onDelete,onRecordingChange,disabled=false,protectedRecording=false}:{compact?:boolean;value?:Blob|null;onComplete?:(blob:Blob)=>void;onDelete?:()=>void|Promise<void>;onRecordingChange?:(recording:boolean)=>void;disabled?:boolean;protectedRecording?:boolean}){
 const {toast}=useApp();
 const [consent,setConsent]=useState(false);const [status,setStatus]=useState<'idle'|'recording'|'paused'|'done'>('idle');
 const [seconds,setSeconds]=useState(0);const [audio,setAudio]=useState('');const [starting,setStarting]=useState(false);
 const recorder=useRef<MediaRecorder|null>(null);const stream=useRef<MediaStream|null>(null);const chunks=useRef<Blob[]>([]);const audioRef=useRef('');const mounted=useRef(true);
 useEffect(()=>{if(status!=='recording')return;const t=setInterval(()=>setSeconds(s=>s+1),1000);return()=>clearInterval(t);},[status]);
 useEffect(()=>{mounted.current=true;return()=>{
  mounted.current=false;
  if(recorder.current){recorder.current.onstop=null;recorder.current.ondataavailable=null;if(recorder.current.state!=='inactive')recorder.current.stop();}
  stream.current?.getTracks().forEach(t=>t.stop());if(audioRef.current)URL.revokeObjectURL(audioRef.current);
 };},[]);
 async function start(){
  setConsent(false);setStarting(true);
  try{
   if(!navigator.mediaDevices?.getUserMedia)throw new Error('Для микрофона нужен HTTPS. Текстовый ввод доступен.');
   const input=await navigator.mediaDevices.getUserMedia({audio:true});
   if(!mounted.current){input.getTracks().forEach(t=>t.stop());return;}
   stream.current=input;const r=new MediaRecorder(input);recorder.current=r;chunks.current=[];
   r.ondataavailable=e=>{if(e.data.size)chunks.current.push(e.data);};
   r.onstop=()=>{
    const blob=new Blob(chunks.current,{type:r.mimeType});
    if(audioRef.current)URL.revokeObjectURL(audioRef.current);
    audioRef.current=URL.createObjectURL(blob);setAudio(audioRef.current);input.getTracks().forEach(t=>t.stop());setStatus('done');onComplete?.(blob);
   };
   r.start();setSeconds(0);setStatus('recording');
  }catch(e){stream.current?.getTracks().forEach(t=>t.stop());toast(e instanceof Error&&e.message.includes('HTTPS')?e.message:'Не удалось включить микрофон. Разрешите доступ в браузере или продолжите текстом.');}
  finally{if(mounted.current)setStarting(false);}
 }
 async function remove(){
  await onDelete?.();
  if(audioRef.current)URL.revokeObjectURL(audioRef.current);
  audioRef.current='';chunks.current=[];setAudio('');setSeconds(0);setStatus('idle');
 }
 useEffect(()=>{
  if(value===undefined)return;
  if(audioRef.current)URL.revokeObjectURL(audioRef.current);
  audioRef.current=value?URL.createObjectURL(value):'';setAudio(audioRef.current);setStatus(value?'done':'idle');
 },[value]);
 const running=status==='recording'||status==='paused';
 useEffect(()=>{onRecordingChange?.(running||starting);},[running,starting,onRecordingChange]);
 return <div className={compact?'recorder compact':'recorder'}>
  {running?<>
   <div className="row between"><span className="recording-label"><i className={status==='paused'?'paused':''}/>{status==='paused'?'Запись на паузе':'Идёт запись'}</span><span className="timer">{String(Math.floor(seconds/60)).padStart(2,'0')}:{String(seconds%60).padStart(2,'0')}</span></div>
   {!compact&&<div className={`waveform ${status==='recording'?'moving':''}`} aria-hidden="true">{Array.from({length:48},(_,i)=><i key={i} style={{height:12+(i*17%46),animationDelay:`${i*.07}s`}}/>)}</div>}
   <div className="row wrap"><Button type="button" variant="secondary" icon={status==='paused'?'play':'pause'} onClick={()=>{if(status==='recording'){recorder.current?.pause();setStatus('paused');}else{recorder.current?.resume();setStatus('recording');}}}>{status==='paused'?'Продолжить':'Пауза'}</Button><Button type="button" variant="danger" icon="stop" onClick={()=>recorder.current?.stop()}>Остановить запись</Button></div>
  </>:<>
   {!(protectedRecording&&audio)&&<Button type="button" variant="secondary" disabled={disabled||starting} icon="mic" onClick={()=>setConsent(true)}>{status==='done'?'Записать ещё раз':compact?'Записать голосом':'Начать запись'}</Button>}
   {audio&&<div className="audio-result"><audio controls src={audio}/><a href={audio} download="ryadom-recording.webm" className="text-link">Скачать запись</a>{onDelete&&!protectedRecording&&<DeleteAudioButton disabled={disabled} onDelete={remove}/>}</div>}
   {audio&&protectedRecording&&<p className="small muted">Записи SOS нельзя удалять или заменять.</p>}
  </>}
  {!compact&&<p className="small muted">Прослушайте запись, затем сохраните или отправьте её.</p>}
  {consent&&<Modal title="Разрешить запись голоса?" onClose={()=>setConsent(false)}>
   <p>{audio?'Новая запись заменит предыдущую.':'Запись начнётся после разрешения доступа к микрофону.'} Вы сможете остановить её в любой момент.</p>
   <p className="small muted">После отправки или сохранения запись будет храниться в карточке и доступна лечащему врачу. Перед записью разговора получите согласие пациента.</p>
   <div className="stack"><Button type="button" disabled={disabled||starting} icon="mic" onClick={start}>Включить микрофон</Button><Button type="button" variant="quiet" onClick={()=>setConsent(false)}>Продолжить без записи</Button></div>
  </Modal>}
 </div>;
}
