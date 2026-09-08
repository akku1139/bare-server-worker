import type { RouteCallback } from './BareServer.ts';
import { BareError } from './BareServer.ts';
import type Server from './BareServer.ts';
import type { BareHeaders, BareRemote } from './requestUtil.ts';
import { upgradeBareFetch, pipeWebSockets } from './requestUtil.ts';
import { bareFetch, randomHex } from './requestUtil.ts';
import { joinHeaders, splitHeaders } from './splitHeaderUtil.ts';
import { remoteToURL, urlToRemote } from './remoteUtil.js';

const forbiddenForwardHeaders: string[] = [
'connection',
'transfer-encoding',
'host',
'connection',
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

const defaultForwardHeaders: string[] = ['accept-encoding', 'accept-language'];

const defaultPassHeaders: string[] = [
'content-encoding',
'content-length',
'last-modified',
];

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
request: Request
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
const passStatus = [] as number[];
const forwardHeaders = [...defaultForwardHeaders];

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
id: `request.headers.x-bare-forward-headers`,
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
remote
);

const responseHeaders = new Headers();

for (const [header, value] of response.headers.entries()) {
if (!passHeaders.includes(header)) continue;
responseHeaders.set(header, value);
}

const status = passStatus.includes(response.status) ? response.status : 200;

if (status !== cacheNotModified) {
responseHeaders.set('x-bare-status', response.status.toString());
responseHeaders.set('x-bare-status-text', response.statusText);
responseHeaders.set(
'x-bare-headers',
JSON.stringify(Object.fromEntries(response.headers))
);
}

return new Response(response.body, {
status,
headers: splitHeaders(responseHeaders),
});
};

interface SocketConnectPacket {
type: 'connect';
remote: string;
headers: BareHeaders;
forwardHeaders: string[];
protocols: string[];
}

interface SocketOpenPacket {
type: 'open';
protocol: string;
setCookies: string[];
}

type SocketClientToServer = SocketConnectPacket;
type SocketServerToClient = SocketOpenPacket;

function readSocket(socket: WebSocket): Promise<SocketClientToServer> {
return new Promise((resolve, reject) => {
const messageListener = (event: MessageEvent) => {
cleanup();

if (typeof event.data !== 'string')
return reject(
new TypeError('the first websocket message was not a text frame')
);

try {
resolve(JSON.parse(event.data));
} catch (err) {
reject(err);
}
};

const closeListener = () => {
cleanup();
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
try {
const connectPacket = await readSocket(request.webSocket!);

if (connectPacket.type !== 'connect')
throw new Error('Client did not send open packet.');

loadForwardedHeaders(
connectPacket.forwardHeaders,
connectPacket.headers,
request
);

const encodedProtocols = connectPacket.protocols.map(p => {
const validChars = "!#$%&'*+-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ^_`abcdefghijklmnopqrstuvwxyz|~";
let result = '';
for (let i = 0; i < p.length; i++) {
const char = p[i];
if (validChars.includes(char) && char !== '%') {
result += char;
} else {
const code = char.charCodeAt(0);
result += '%' + code.toString(16).padStart(2, '0');
}
}
return result;
});

const remoteHeaders: Record<string, string> = {
...Object.fromEntries(
Object.entries(connectPacket.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])
),
upgrade: 'websocket',
connection: 'upgrade',
};

if (encodedProtocols.length > 0) {
remoteHeaders['sec-websocket-protocol'] = encodedProtocols.join(', ');
}

const remoteUrl = new URL(connectPacket.remote);

const remoteResponse = await fetch(
`${remoteUrl.protocol}//${remoteUrl.host}${remoteUrl.pathname}${remoteUrl.search}`,
{
headers: remoteHeaders,
signal: request.signal,
}
);

if (!remoteResponse.webSocket) {
throw new Error("Remote server didn't accept WebSocket");
}

const remoteSocket = remoteResponse.webSocket;

const clientSocket = request.webSocket!;
clientSocket.accept();

const setCookies = remoteResponse.headers.getSetCookie?.() || [];

clientSocket.send(
JSON.stringify({
type: 'open',
protocol: remoteSocket.protocol || '',
setCookies,
} as SocketServerToClient)
);

pipeWebSockets(clientSocket, remoteSocket, options.logErrors ?? false);

return new Response(null, { status: 101 });
} catch (err) {
if (options.logErrors) console.error(err);
if (request.webSocket) {
request.webSocket.close(1011, 'Internal Server Error');
}
return new Response(null, { status: 500 });
}
};

export default function registerV3(server: Server) {
server.routes.set('/v3/', tunnelRequest);
server.socketRoutes.set('/v3/', tunnelSocket);
}
