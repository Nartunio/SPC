import { useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';

type FetchState = 'idle' | 'loading' | 'success' | 'error';

export default function LoggedInPage() {
	const { isAuthenticated, isLoading, loginWithRedirect, getAccessTokenSilently, user, logout } = useAuth0();

	const [state, setState] = useState<FetchState>('idle');
	const [status, setStatus] = useState<number | null>(null);
	const [statusText, setStatusText] = useState<string>('');
	const [body, setBody] = useState<string>('');
	const [error, setError] = useState<string>('');

	async function fetchPrivate() {
		setState('loading');
		setError('');
		setBody('');
		setStatus(null);
		setStatusText('');
		try {
			const token = await getAccessTokenSilently({
				authorizationParams: {
					audience: import.meta.env.VITE_AUTH0_AUDIENCE,
				},
			});

			const res = await fetch('http://localhost:8000/auth/private', {
				method: 'GET',
				headers: {
					Accept: '*/*',
					Authorization: `Bearer ${token}`,
				},
			});

			setStatus(res.status);
			setStatusText(res.statusText);

			const contentType = res.headers.get('content-type') || '';
			if (contentType.includes('application/json')) {
				try {
					const json = await res.json();
					setBody(JSON.stringify(json, null, 2));
				} catch (e) {
					const text = await res.text();
					setBody(text);
				}
			} else {
				const text = await res.text();
				setBody(text);
			}

			setState(res.ok ? 'success' : 'error');
		} catch (e: unknown) {
			setState('error');
			setError(e instanceof Error ? e.message : 'Unknown error');
		}
	}

	useEffect(() => {
		if (!isLoading && isAuthenticated) {
			fetchPrivate();
		}
	}, [isLoading, isAuthenticated]);

	return (
		<div style={{ padding: '1rem', maxWidth: 900, margin: '0 auto' }}>
			<h1 style={{ fontSize: 24, fontWeight: 600 }}>Private Endpoint Response</h1>

			<div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
				{!isAuthenticated ? (
					<button onClick={() => loginWithRedirect()} style={{ padding: '6px 12px' }}>Log in</button>
				) : (
					<>
						<span style={{ color: '#555' }}>Signed in as {user?.email || user?.name}</span>
						<button onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })} style={{ padding: '6px 12px' }}>Log out</button>
						<button onClick={fetchPrivate} disabled={state === 'loading'} style={{ padding: '6px 12px' }}>
							{state === 'loading' ? 'Loading…' : 'Re-fetch'}
						</button>
					</>
				)}
			</div>

			{state !== 'idle' && (
				<div style={{ marginTop: '1rem' }}>
					<div style={{ marginBottom: '0.5rem', color: '#555' }}>
						<span>Status: </span>
						<strong>{status ?? '—'}</strong>
						{statusText ? <span> ({statusText})</span> : null}
					</div>
					{error && (
						<div style={{ color: 'crimson', marginBottom: '0.5rem' }}>
							Error: {error}
						</div>
					)}
					<pre
						style={{
							background: '#0b1021',
							color: '#e6edf3',
							padding: '1rem',
							borderRadius: 8,
							overflowX: 'auto',
							whiteSpace: 'pre-wrap',
							wordBreak: 'break-word',
							border: '1px solid #1f2a4d',
						}}
					>
						{body || '(empty response body)'}
					</pre>
				</div>
			)}
		</div>
	);
}

