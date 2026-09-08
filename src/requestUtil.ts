export interface BareRemote {
	host: string;
	port: number | string;
	path: string;
	protocol: string;
}

export type BareHeaders = Record<string, string | string[]>;

export function randomHex(byteLength: number) {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	let hex = '';
	for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
	return hex;
}

const noBody = ['GET', 'HEAD'];

export async function bareFetch(
	request: Request,
	signal: AbortSignal,
	requestHeaders: BareHeaders,
	remote: URL,
) {
	return fetch(
		`${remote.protocol}//${remote.host}:${remote.port}${remote.pathname}${remote.search}`,
		{
			headers: requestHeaders as HeadersInit,
			method: request.method,
			body: noBody.includes(request.method) ? undefined : await request.blob(),
			signal,
			redirect: 'manual',
		},
	);
}

/**
 * Establish an outbound WebSocket connection via fetch (Cloudflare Workers).
 * The remote URL must use ws: or wss:; it is converted to http(s) for fetch.
 */
export async function upgradeBareFetch(
	requestHeaders: BareHeaders,
	remote: URL,
	protocols: string[] = [],
	signal?: AbortSignal,
): Promise<[Response, WebSocket]> {
	// Workers expect http(s) URL for WebSocket upgrade fetch
	const isSecure = remote.protocol === 'wss:';
	const protocol = isSecure ? 'https:' : 'http:';
	const defaultPort = isSecure ? '443' : '80';
	const portPart =
		remote.port && remote.port !== '' && String(remote.port) !== defaultPort
			? `:${remote.port}`
			: '';
	const url = `${protocol}//${remote.host}${portPart}${remote.pathname}${remote.search}`;

	const headers = new Headers();
	for (const [key, value] of Object.entries(requestHeaders)) {
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, v);
		} else {
			headers.set(key, value);
		}
	}

	// Required for WebSocket upgrade
	headers.set('Upgrade', 'websocket');
	headers.set('Connection', 'Upgrade');

	if (protocols.length > 0) {
		headers.set('Sec-WebSocket-Protocol', protocols.join(', '));
	}

	const res = await fetch(url, {
		headers,
		method: 'GET',
		signal,
	});

	if (!res.webSocket) {
		throw new Error("server didn't accept WebSocket");
	}

	return [res, res.webSocket];
}
