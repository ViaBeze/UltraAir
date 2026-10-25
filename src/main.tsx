import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import '@fontsource-variable/inter';
import './styles.css';
import './garden.css';
import { AppProvider, useApp } from './state';
import { Shell } from './Shell';
import { PatientHome, Diary, Plan, Dynamics, PatientSos, PatientProfile } from './Patient';
import { DoctorHome, Patients, Appointments, NewPatient, PatientAccess, PatientCard, MedicalForm, ProfileForm } from './Doctor';
import { Visit, Review, Observations, Sources, DoctorSos } from './Clinical';
import { Messages, AiAssistant, DoctorSettings } from './Communication';
import { Login } from './Login';
import { NotificationProvider } from './Notifications';
function Home(){const {user,loading,error,refresh}=useApp();if(loading)return <div className="loading-page">Загружаем…</div>;if(error)return <div className="loading-page"><p>{error}</p><button onClick={()=>void refresh()}>Повторить</button></div>;return <Navigate to={user?`/${user.role}/${user.role==='doctor'?'overview':'today'}`:'/login'} replace/>;}
function App(){if(location.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(location.hostname))return <div className="loading-page"><h1>Рядом</h1><p>Для входа в аккаунт откройте защищённый адрес приложения.</p><a className="button primary" href="https://ryadomhelp.online">Открыть ryadomhelp.online</a><p className="small muted">Если домен ещё не открывается, дождитесь обновления DNS.</p></div>;return <BrowserRouter><AppProvider><NotificationProvider><Routes><Route path="/" element={<Home/>}/><Route path="/login" element={<Login/>}/><Route path="/activate" element={<Login/>}/><Route path="/patient" element={<Shell role="patient"/>}><Route index element={<Navigate to="today" replace/>}/><Route path="today" element={<PatientHome/>}/><Route path="diary" element={<Diary/>}/><Route path="plan" element={<Plan/>}/><Route path="dynamics" element={<Dynamics/>}/><Route path="messages" element={<Messages role="patient"/>}/><Route path="sos" element={<PatientSos/>}/><Route path="profile" element={<PatientProfile/>}/></Route><Route path="/doctor" element={<Shell role="doctor"/>}><Route index element={<Navigate to="overview" replace/>}/><Route path="overview" element={<DoctorHome/>}/><Route path="patients" element={<Patients/>}/><Route path="new" element={<NewPatient/>}/><Route path="access/:id" element={<PatientAccess/>}/><Route path="patients/:id" element={<PatientCard/>}/><Route path="patients/:id/medical" element={<MedicalForm/>}/><Route path="patients/:id/profile" element={<ProfileForm/>}/><Route path="appointments" element={<Appointments/>}/><Route path="visit/:id" element={<Visit/>}/><Route path="review/:id" element={<Review/>}/><Route path="observations/:id" element={<Observations/>}/><Route path="sources/:id" element={<Sources/>}/><Route path="messages" element={<Messages role="doctor"/>}/><Route path="sos" element={<DoctorSos/>}/><Route path="ai" element={<AiAssistant/>}/><Route path="settings" element={<DoctorSettings/>}/></Route><Route path="*" element={<Home/>}/></Routes></NotificationProvider></AppProvider></BrowserRouter>;}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
