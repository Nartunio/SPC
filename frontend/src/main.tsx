import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
import LandingPage from './pages/landing-page/LandingPage.tsx';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import LoginPage from './pages/login-page/LoginPage.tsx';
import MenubarPage from './pages/menubar/MenubarPage.tsx';
import SignupPage from './pages/signup-page/SignupPage.tsx';
import { NoRoutePage } from './pages/no-route-page/NoRoutePage.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/panel" element={<MenubarPage />} />
        <Route path="/menubar" element={<MenubarPage />} />
        <Route path="*" element={<NoRoutePage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
