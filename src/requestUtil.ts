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
	remote: URL
) {
	return fetch(
		`${remote.protocol}//${remote.host}:${remote.port}${remote.pathname}${remote.search}`,
		{
			headers: requestHeaders as HeadersInit,
			method: request.method,
			body: noBody.includes(request.method) ? undefined : await request.blob(),
			signal,
			redirect: 'manual',
		}
	);
}

export async function upgradeBareFetch(
	request: Request,
	signal: AbortSignal,
	requestHeaders: BareHeaders,
	remote: URL
) {
	const res = await fetch(
		`${remote.protocol}//${remote.host}:${remote.port}${remote.pathname}${remote.search}`,
		{
			headers: requestHeaders as HeadersInit,
			method: request.method,
			signal,
		}
	);

	if (!res.webSocket) throw new Error("server didn't accept WebSocket");

	return [res, res.webSocket] as [Response, WebSocket];
}

/**
 * Creates a bidirectional pipe between two WebSockets
 */
export function pipeWebSockets(ws1: WebSocket, ws2: WebSocket, logErrors: boolean = false) {
	ws1.addEventListener('message', (event) => {
		if (ws2.readyState === WebSocket.OPEN) {
			ws2.send(event.data);
		}
	});

	ws2.addEventListener('message', (event) => {
		if (ws1.readyState === WebSocket.OPEN) {
			ws1.send(event.data);
		}
	});

	ws1.addEventListener('close', () => {
		if (ws2.readyState === WebSocket.OPEN) {
			ws2.close();
		}
	});

	ws2.addEventListener('close', () => {
		if (ws1.readyState === WebSocket.OPEN) {
			ws1.close();
		}
	});

	ws1.addEventListener('error', (error) => {
		if (logErrors) {
			console.error('WebSocket 1 error:', error);
		}
		if (ws2.readyState === WebSocket.OPEN) {
			ws2.close();
		}
	});

	ws2.addEventListener('error', (error) => {
		if (logErrors) {
			console.error('WebSocket 2 error:', error);
		}
		if (ws1.readyState === WebSocket.OPEN) {
			ws1.close();
		}
	});
}
