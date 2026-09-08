import type { RouteCallback } from './BareServer.ts';
import { BareError } from './BareServer.ts';
import type Server from './BareServer.ts';
import type { BareHeaders } from './requestUtil.ts';
import { bareFetch, upgradeBareFetch } from './requestUtil.ts';
import { joinHeaders, splitHeaders } from './splitHeaderUtil.ts';
import { remoteToURL, urlToRemote } from './remoteUtil.js';

const forbiddenForwardHeaders: string[] = [
	'connection',
	'transfer-encoding',
	'host',
	'origin',
	'referer',
];

const forbiddenPassHeaders: string[] = [
	'vary',
	'connection',
	'transfer-encoding',
	'access-control-allow-headers',
	'access-control-allow-methods',
	'access-control-expose-headers',
	'access-control-max-age',
	'access-control-request-headers',
	'access-control-request-method',
];

// common defaults
const defaultForwardHeaders: string[] = ['accept-encoding', 'accept-language'];

const defaultPassHeaders: string[] = [
	'content-encoding',
	'content-length',
	'last-modified',
];

// defaults if the client provides a cache key
const defaultCacheForwardHeaders: string[] = [
	'if-modified-since',
	'if-none-match',
	'cache-control',
];

const defaultCachePassHeaders: string[] = ['cache-control', 'etag'];

const cacheNotModified = 304;

function loadForwardedHeaders(
	forward: string[],
	target: BareHeaders,
	request: Request,
) {
	for (const header of forward) {
		if (request.headers.has(header)) {
			target[header] = request.headers.get(header)!;
		}
	}
}

const splitHeaderValue = /,\s*/g;

interface BareHeaderData {
	remote: URL;
	sendHeaders: BareHeaders;
	passHeaders: string[];
	passStatus: number[];
	forwardHeaders: string[];
}

function readHeaders(request: Request): BareHeaderData {
	const sendHeaders: BareHeaders = Object.create(null);
	const passHeaders = [...defaultPassHeaders];
	const passStatus: number[] = [];
	const forwardHeaders = [...defaultForwardHeaders];

	// should be unique
	const cache = new URL(request.url).searchParams.has('cache');

	if (cache) {
		passHeaders.push(...defaultCachePassHeaders);
		passStatus.push(cacheNotModified);
		forwardHeaders.push(...defaultCacheForwardHeaders);
	}

	const headers = joinHeaders(request.headers);

	const xBareURL = headers.get('x-bare-url');

	if (xBareURL === null)
		throw new BareError(400, {
			code: 'MISSING_BARE_HEADER',
			id: `request.headers.x-bare-url`,
			message: `Header was not specified.`,
		});

	const remote = urlToRemote(new URL(xBareURL));

	const xBareHeaders = headers.get('x-bare-headers');

	if (xBareHeaders === null)
		throw new BareError(400, {
			code: 'MISSING_BARE_HEADER',
			id: `request.headers.x-bare-headers`,
			message: `Header was not specified.`,
		});

	try {
		const json = JSON.parse(xBareHeaders) as Record<string, string | string[]>;

		for (const header in json) {
			const value = json[header];

			if (typeof value === 'string') {
				sendHeaders[header] = value;
			} else if (Array.isArray(value)) {
				const array: string[] = [];

				for (const val of value) {
					if (typeof val !== 'string') {
						throw new BareError(400, {
							code: 'INVALID_BARE_HEADER',
							id: `bare.headers.${header}`,
							message: `Header was not a String.`,
						});
					}

					array.push(val);
				}

				sendHeaders[header] = array;
			} else {
				throw new BareError(400, {
					code: 'INVALID_BARE_HEADER',
					id: `bare.headers.${header}`,
					message: `Header was not a String.`,
				});
			}
		}
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new BareError(400, {
				code: 'INVALID_BARE_HEADER',
				id: `request.headers.x-bare-headers`,
				message: `Header contained invalid JSON. (${error.message})`,
			});
		} else {
			throw error;
		}
	}

	if (headers.has('x-bare-pass-status')) {
		const parsed = headers.get('x-bare-pass-status')!.split(splitHeaderValue);

		for (const value of parsed) {
			const number = parseInt(value);

			if (isNaN(number)) {
				throw new BareError(400, {
					code: 'INVALID_BARE_HEADER',
					id: `request.headers.x-bare-pass-status`,
					message: `Array contained non-number value.`,
				});
			} else {
				passStatus.push(number);
			}
		}
	}

	if (headers.has('x-bare-pass-headers')) {
		const parsed = headers.get('x-bare-pass-headers')!.split(splitHeaderValue);

		for (let header of parsed) {
			header = header.toLowerCase();

			if (forbiddenPassHeaders.includes(header)) {
				throw new BareError(400, {
					code: 'FORBIDDEN_BARE_HEADER',
					id: `request.headers.x-bare-pass-headers`,
					message: `A forbidden header was passed.`,
				});
			} else {
				passHeaders.push(header);
			}
		}
	}

	if (headers.has('x-bare-forward-headers')) {
		const parsed = headers
			.get('x-bare-forward-headers')!
			.split(splitHeaderValue);

		for (let header of parsed) {
			header = header.toLowerCase();

			if (forbiddenForwardHeaders.includes(header)) {
				throw new BareError(400, {
					code: 'FORBIDDEN_BARE_HEADER',
					id: `request.headers.x-bare-forward-headers`,
					message: `A forbidden header was forwarded.`,
				});
			} else {
				forwardHeaders.push(header);
			}
		}
	}

	return {
		remote: remoteToURL(remote),
		sendHeaders,
		passHeaders,
		passStatus,
		forwardHeaders,
	};
}

const tunnelRequest: RouteCallback = async (request) => {
	const { remote, sendHeaders, passHeaders, passStatus, forwardHeaders } =
		readHeaders(request);

	loadForwardedHeaders(forwardHeaders, sendHeaders, request);

	const response = await bareFetch(
		request,
		request.signal,
		sendHeaders,
		remote,
	);

	const responseHeaders = new Headers();

	for (const [header, value] of response.headers.entries()) {
		if (!passHeaders.includes(header.toLowerCase())) continue;
		responseHeaders.set(header, value);
	}

	const status = passStatus.includes(response.status) ? response.status : 200;

	if (status !== cacheNotModified) {
		responseHeaders.set('x-bare-status', response.status.toString());
		responseHeaders.set('x-bare-status-text', response.statusText);
		responseHeaders.set(
			'x-bare-headers',
			JSON.stringify(Object.fromEntries(response.headers)),
		);
	}

	return new Response(response.body, {
		status,
		headers: splitHeaders(responseHeaders),
	});
};

// WebSocket packet types per TOMP spec
interface SocketConnectPacket {
	type: 'connect';
	remote: string;
	protocols: string[];
	headers: Record<string, string>;
	forwardHeaders: string[];
}

interface SocketOpenPacket {
	type: 'open';
	protocol: string;
	setCookies: string[];
}

type SocketClientToServer = SocketConnectPacket;

function readSocket(socket: WebSocket): Promise<SocketClientToServer> {
	return new Promise((resolve, reject) => {
		const messageListener = (event: MessageEvent) => {
			cleanup();

			if (typeof event.data !== 'string')
				return reject(
					new TypeError('the first websocket message was not a text frame'),
				);

			try {
				resolve(JSON.parse(event.data));
			} catch (err) {
				reject(err);
			}
		};

		const closeListener = () => {
			cleanup();
			reject(new Error('WebSocket closed before connect packet'));
		};

		const cleanup = () => {
			socket.removeEventListener('message', messageListener);
			socket.removeEventListener('close', closeListener);
			clearTimeout(timeout);
		};

		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error('Timed out before metadata could be read'));
		}, 10e3);

		socket.addEventListener('message', messageListener);
		socket.addEventListener('close', closeListener);
	});
}

const tunnelSocket: RouteCallback = async (request, options) => {
	const upgradeHeader = request.headers.get('upgrade');
	if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
		throw new BareError(400, {
			code: 'UPGRADE_REQUIRED',
			id: 'request.headers.upgrade',
			message: 'Upgrade header must be websocket',
		});
	}

	// Cloudflare Workers WebSocketPair: [0] = client, [1] = server
	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];

	// Handle the server side of the WebSocket
	(async () => {
		let remoteSocket: WebSocket | undefined;

		try {
			server.accept();
			const connectPacket = await readSocket(server);

			if (connectPacket.type !== 'connect')
				throw new Error('Client did not send connect packet.');

			const headers: BareHeaders = { ...connectPacket.headers };

			loadForwardedHeaders(
				connectPacket.forwardHeaders || [],
				headers,
				request,
			);

			let remoteUrl: URL;
			try {
				remoteUrl = new URL(connectPacket.remote);
			} catch {
				throw new Error('Invalid remote URL in connect packet');
			}
			if (remoteUrl.protocol !== 'ws:' && remoteUrl.protocol !== 'wss:') {
				throw new Error('Remote protocol must be ws: or wss:');
			}

			if (!headers['Host'] && !headers['host']) {
				headers['Host'] = remoteUrl.host;
			}

			const [remoteRes, remoteWs] = await upgradeBareFetch(
				headers,
				remoteUrl,
				connectPacket.protocols || [],
				request.signal,
			);

			remoteSocket = remoteWs;
			remoteSocket.accept();

			const setCookies: string[] = [];
			const anyHeaders = remoteRes.headers as Headers & {
				getSetCookie?: () => string[];
			};
			if (typeof anyHeaders.getSetCookie === 'function') {
				setCookies.push(...anyHeaders.getSetCookie());
			} else {
				const single = remoteRes.headers.get('set-cookie');
				if (single) setCookies.push(single);
			}

			const openPacket: SocketOpenPacket = {
				type: 'open',
				protocol: remoteRes.headers.get('sec-websocket-protocol') || '',
				setCookies,
			};
			server.send(JSON.stringify(openPacket));

			// Pipe messages (preserve text/binary)
			remoteSocket.addEventListener('message', (event) => {
				try {
					server.send(event.data);
				} catch {
					/* ignore */
				}
			});

			server.addEventListener('message', (event) => {
				try {
					remoteSocket!.send(event.data);
				} catch {
					/* ignore */
				}
			});

			remoteSocket.addEventListener('close', () => {
				try {
					server.close();
				} catch {
					/* ignore */
				}
			});

			server.addEventListener('close', () => {
				try {
					remoteSocket!.close();
				} catch {
					/* ignore */
				}
			});

			remoteSocket.addEventListener('error', (error) => {
				if (options.logErrors) {
					console.error('Remote socket error:', error);
				}
				try {
					server.close();
				} catch {
					/* ignore */
				}
			});

			server.addEventListener('error', (error) => {
				if (options.logErrors) {
					console.error('Serving socket error:', error);
				}
				try {
					remoteSocket!.close();
				} catch {
					/* ignore */
				}
			});
		} catch (err) {
			if (options.logErrors) console.error(err);
			try {
				server.close();
			} catch {
				/* ignore */
			}
			if (remoteSocket) {
				try {
					remoteSocket.close();
				} catch {
					/* ignore */
				}
			}
		}
	})();

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
};

export default function registerV3(server: Server) {
	server.routes.set('/v3/', tunnelRequest);
	server.socketRoutes.set('/v3/', tunnelSocket);
}
