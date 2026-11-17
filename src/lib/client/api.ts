export class ApiError extends Error {
	constructor(
		message: string,
		public status: number,
		/** The error response body, e.g. { error, code, manageUrl } from the AI endpoints. */
		public data: Record<string, unknown> | null = null
	) {
		super(message);
	}
}

/** JSON request to the app's own API. Errors carry the server's message. */
export async function api<T = unknown>(
	path: string,
	opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<T> {
	let res: Response;
	try {
		res = await fetch(path, {
			method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
			headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			signal: opts.signal
		});
	} catch {
		throw new ApiError('Couldn’t reach Medicus Vitae. Check that it is still running.', 0);
	}
	const type = res.headers.get('content-type') ?? '';
	const data = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
	if (!res.ok) {
		const message =
			(data && typeof data === 'object' && 'error' in data && String((data as { error: unknown }).error)) ||
			(typeof data === 'string' && data) ||
			`Request failed (${res.status})`;
		if (res.status === 401 && typeof location !== 'undefined') {
			location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
		}
		throw new ApiError(message, res.status, data && typeof data === 'object' ? (data as Record<string, unknown>) : null);
	}
	return data as T;
}
