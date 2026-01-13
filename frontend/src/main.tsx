import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

import { Auth0Provider } from '@auth0/auth0-react';

import LandingPage from './pages/landing-page/LandingPage.tsx';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { NoRoutePage } from './pages/no-route-page/NoRoutePage.tsx';
import LoggedInPage from './pages/logged-in-page/LoggedInPage.tsx';
import ShareAccessPage from './pages/share/ShareAccessPage.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Auth0Provider
      domain={import.meta.env.VITE_AUTH0_DOMAIN}
      clientId={import.meta.env.VITE_AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: import.meta.env.VITE_AUTH0_AUDIENCE,
        // Request refresh tokens for silent renewal
        scope: 'openid profile email offline_access',
      }}
      useRefreshTokens={true}
      cacheLocation="localstorage"
    >
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path='/logged-in-page' element={<LoggedInPage />} />
          <Route path='/share' element={<ShareAccessPage />} />
          <Route path="*" element={<NoRoutePage />} />
        </Routes>
      </BrowserRouter>
    </Auth0Provider>
  </StrictMode>,
)
