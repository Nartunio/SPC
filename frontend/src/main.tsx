import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

import { Auth0Provider, type AppState } from '@auth0/auth0-react';

import LandingPage from './pages/landing-page/LandingPage.tsx';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { NoRoutePage } from './pages/no-route-page/NoRoutePage.tsx';
import LoggedInPage from './pages/logged-in-page/LoggedInPage.tsx';
import ShareAccessPage from './pages/share/ShareAccessPage.tsx';
import CallbackPage from './pages/callback/CallbackPage.tsx';

function Auth0ProviderWithNavigate({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  const onRedirectCallback = (appState?: AppState) => {
    const target = (appState as any)?.returnTo || '/logged-in-page';
    navigate(target, { replace: true });
  };

  return (
    <Auth0Provider
      domain={import.meta.env.VITE_AUTH0_DOMAIN}
      clientId={import.meta.env.VITE_AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: `${window.location.origin}/callback`,
        audience: import.meta.env.VITE_AUTH0_AUDIENCE,
        // Request refresh tokens for silent renewal
        scope: 'openid profile email offline_access',
      }}
      onRedirectCallback={onRedirectCallback}
      useRefreshTokens={true}
      cacheLocation="localstorage"
    >
      {children}
    </Auth0Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Auth0ProviderWithNavigate>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/callback" element={<CallbackPage />} />
          <Route path='/logged-in-page' element={<LoggedInPage />} />
          <Route path='/share' element={<ShareAccessPage />} />
          <Route path="*" element={<NoRoutePage />} />
        </Routes>
      </Auth0ProviderWithNavigate>
    </BrowserRouter>
  </StrictMode>,
)
