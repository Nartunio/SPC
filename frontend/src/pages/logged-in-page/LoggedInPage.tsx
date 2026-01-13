import { useAuth0 } from '@auth0/auth0-react';
import StoragePanel from './components/StoragePanel';

export default function LoggedInPage() {
  const { isAuthenticated, isLoading, loginWithRedirect, user, logout } = useAuth0();

  return (
	<div style={{ padding: '1rem', maxWidth: 1000, margin: '0 auto', display: 'grid', gap: 16 }}>
	  <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
		<h1 style={{ fontSize: 24, fontWeight: 600 }}>Storage Panel</h1>
		<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
		  {!isAuthenticated ? (
			<button
			  onClick={() =>
				loginWithRedirect({
				  authorizationParams: {
					redirect_uri: window.location.origin,
					audience: (import.meta as any).env.VITE_AUTH0_AUDIENCE,
					scope: 'openid profile email offline_access',
				  },
				})
			  }
			  style={{ padding: '6px 12px' }}
			>
			  Log in
			</button>
		  ) : (
			<>
			  <span style={{ color: '#555' }}>Signed in as {user?.email || user?.name}</span>
			  <button onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })} style={{ padding: '6px 12px' }}>Log out</button>
			</>
		  )}
		</div>
	  </div>

	  {!isLoading && isAuthenticated ? (
		<StoragePanel />
	  ) : (
		<div>Loading authentication…</div>
	  )}
	</div>
  );
}

