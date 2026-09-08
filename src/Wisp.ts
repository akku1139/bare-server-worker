/**
 * Wisp protocol server for Cloudflare Workers (TCP only).
 * Spec: https://github.com/MercuryWorkshop/wisp-protocol/blob/v2/protocol.md
 *
 * Uses cloudflare:sockets connect() for outbound TCP.
 * UDP is not supported on Workers and is not advertised.
 */
import type { RouteCallback } from './BareServer.ts';
import type Server from './BareServer.ts';
import { BareError } from './BareServer.ts';

// Packet types
const PACKET_CONNECT = 0x01;
const PACKET_DATA = 0x02;
const PACKET_CONTINUE = 0x03;
const PACKET_CLOSE = 0x04;
const PACKET_INFO = 0x05;

// Stream types
const STREAM_TCP = 0x01;
const STREAM_UDP = 0x02;

// Close reasons
const CLOSE_UNKNOWN = 0x01;
const CLOSE_VOLUNTARY = 0x02;
const CLOSE_NETWORK = 0x03;
const CLOSE_INVALID_INFO = 0x41;
const CLOSE_UNREACHABLE = 0x42;
const CLOSE_TIMEOUT = 0x43;
const CLOSE_REFUSED = 0x44;
const CLOSE_BLOCKED = 0x48;

// Extensions
const EXT_STREAM_OPEN_CONFIRMATION = 0x05;

/** Default CONTINUE window size (packets the server will buffer per stream). */
const BUFFER_SIZE = 127;

function encodePacket(
	type: number,
	streamId: number,
	payload: ArrayBuffer | ArrayBufferView = new Uint8Array(0),
): ArrayBuffer {
	const payloadView =
		payload instanceof ArrayBuffer
			? new Uint8Array(payload)
			: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
	const buf = new ArrayBuffer(5 + payloadView.byteLength);
	const view = new DataView(buf);
	view.setUint8(0, type);
	view.setUint32(1, streamId, true); // little-endian
	new Uint8Array(buf, 5).set(payloadView);
	return buf;
}

function parsePacket(data: ArrayBuffer): {
	type: number;
	streamId: number;
	payload: Uint8Array;
} {
	if (data.byteLength < 5) {
		throw new Error('Packet too short');
	}
	const view = new DataView(data);
	return {
		type: view.getUint8(0),
		streamId: view.getUint32(1, true),
		payload: new Uint8Array(data, 5),
	};
}

function buildInfoPacket(): ArrayBuffer {
	// Major=2, Minor=1, extension: Stream Open Confirmation (id=0x05, length=0)
	const ext = new Uint8Array(1 + 4); // id + length (0)
	ext[0] = EXT_STREAM_OPEN_CONFIRMATION;
	// length already 0
	const payload = new Uint8Array(2 + ext.byteLength);
	payload[0] = 2; // major
	payload[1] = 1; // minor
	payload.set(ext, 2);
	return encodePacket(PACKET_INFO, 0, payload);
}

interface StreamState {
	socket: {
		readable: ReadableStream;
		writable: WritableStream;
		close: () => Promise<void>;
		closed: Promise<void>;
	};
	writer: WritableStreamDefaultWriter<Uint8Array>;
	/** Packets received from client since last CONTINUE. */
	packetsSinceContinue: number;
	closed: boolean;
}

async function handleWispConnection(
	server: WebSocket,
	logErrors: boolean,
): Promise<void> {
	const streams = new Map<number, StreamState>();

	const send = (buf: ArrayBuffer) => {
		try {
			server.send(buf);
		} catch {
			/* closed */
		}
	};

	const closeStream = async (streamId: number, reason: number) => {
		const state = streams.get(streamId);
		if (!state || state.closed) return;
		state.closed = true;
		streams.delete(streamId);
		send(encodePacket(PACKET_CLOSE, streamId, new Uint8Array([reason])));
		try {
			await state.writer.close().catch(() => {});
			await state.socket.close().catch(() => {});
		} catch {
			/* ignore */
		}
	};

	const cleanupAll = async () => {
		for (const id of [...streams.keys()]) {
			await closeStream(id, CLOSE_NETWORK);
		}
	};

	// Send server INFO (stream ID 0)
	send(buildInfoPacket());

	// Also send CONTINUE on stream 0 as initial buffer advertisement (v1 compat / common practice)
	send(
		encodePacket(
			PACKET_CONTINUE,
			0,
			(() => {
				const b = new ArrayBuffer(4);
				new DataView(b).setUint32(0, BUFFER_SIZE, true);
				return b;
			})(),
		),
	);

	server.addEventListener('close', () => {
		void cleanupAll();
	});

	server.addEventListener('error', (ev) => {
		if (logErrors) console.error('Wisp WS error', ev);
		void cleanupAll();
	});

	server.addEventListener('message', (event) => {
		void (async () => {
			try {
				let data: ArrayBuffer;
				if (event.data instanceof ArrayBuffer) {
					data = event.data;
				} else if (event.data instanceof Blob) {
					data = await event.data.arrayBuffer();
				} else {
					// text frames are invalid for Wisp binary protocol
					return;
				}

				const { type, streamId, payload } = parsePacket(data);

				switch (type) {
					case PACKET_INFO: {
						// Client INFO — we already sent ours; ignore extensions for now
						break;
					}

					case PACKET_CONNECT: {
						if (streamId === 0 || payload.byteLength < 3) {
							send(
								encodePacket(
									PACKET_CLOSE,
									streamId,
									new Uint8Array([CLOSE_INVALID_INFO]),
								),
							);
							break;
						}

						const streamType = payload[0];
						const port = new DataView(
							payload.buffer,
							payload.byteOffset + 1,
							2,
						).getUint16(0, true);
						const hostname = new TextDecoder().decode(payload.subarray(3));

						if (streamType === STREAM_UDP) {
							send(
								encodePacket(
									PACKET_CLOSE,
									streamId,
									new Uint8Array([CLOSE_INVALID_INFO]),
								),
							);
							break;
						}

						if (streamType !== STREAM_TCP || !hostname || port === 0) {
							send(
								encodePacket(
									PACKET_CLOSE,
									streamId,
									new Uint8Array([CLOSE_INVALID_INFO]),
								),
							);
							break;
						}

						// Block obvious local/private targets (basic safety)
						const lower = hostname.toLowerCase();
						if (
							lower === 'localhost' ||
							lower.endsWith('.local') ||
							lower.startsWith('127.') ||
							lower.startsWith('10.') ||
							lower.startsWith('192.168.') ||
							lower.startsWith('0.')
						) {
							send(
								encodePacket(
									PACKET_CLOSE,
									streamId,
									new Uint8Array([CLOSE_BLOCKED]),
								),
							);
							break;
						}

						try {
							// Dynamic import so typecheck still works without the module in types
							const { connect } = await import('cloudflare:sockets');
							const socket = connect(
								{ hostname, port },
								{ allowHalfOpen: true },
							);

							const writer = socket.writable.getWriter();
							const state: StreamState = {
								socket,
								writer,
								packetsSinceContinue: 0,
								closed: false,
							};
							streams.set(streamId, state);

							// Stream Open Confirmation: send CONTINUE when connected
							const cont = new ArrayBuffer(4);
							new DataView(cont).setUint32(0, BUFFER_SIZE, true);
							send(encodePacket(PACKET_CONTINUE, streamId, cont));

							// Pipe remote -> client
							const reader = socket.readable.getReader();
							(async () => {
								try {
									for (;;) {
										const { done, value } = await reader.read();
										if (done) break;
										if (value && value.byteLength > 0) {
											send(encodePacket(PACKET_DATA, streamId, value));
										}
									}
									await closeStream(streamId, CLOSE_VOLUNTARY);
								} catch {
									await closeStream(streamId, CLOSE_NETWORK);
								} finally {
									try {
										reader.releaseLock();
									} catch {
										/* ignore */
									}
								}
							})();
						} catch (err) {
							if (logErrors) console.error('Wisp connect failed', hostname, port, err);
							const msg = err instanceof Error ? err.message : String(err);
							let reason = CLOSE_UNREACHABLE;
							if (/refused|ECONNREFUSED/i.test(msg)) reason = CLOSE_REFUSED;
							else if (/timeout|ETIMEDOUT/i.test(msg)) reason = CLOSE_TIMEOUT;
							send(
								encodePacket(
									PACKET_CLOSE,
									streamId,
									new Uint8Array([reason]),
								),
							);
						}
						break;
					}

					case PACKET_DATA: {
						const state = streams.get(streamId);
						if (!state || state.closed) break;

						try {
							await state.writer.write(payload);
							state.packetsSinceContinue += 1;
							if (state.packetsSinceContinue >= BUFFER_SIZE) {
								state.packetsSinceContinue = 0;
								const cont = new ArrayBuffer(4);
								new DataView(cont).setUint32(0, BUFFER_SIZE, true);
								send(encodePacket(PACKET_CONTINUE, streamId, cont));
							}
						} catch {
							await closeStream(streamId, CLOSE_NETWORK);
						}
						break;
					}

					case PACKET_CLOSE: {
						await closeStream(streamId, CLOSE_VOLUNTARY);
						break;
					}

					default:
					// ignore unknown
					break;
				}
			} catch (err) {
				if (logErrors) console.error('Wisp packet error', err);
			}
		})();
	});
}

const wispRoute: RouteCallback = async (request, options) => {
	const upgradeHeader = request.headers.get('upgrade');
	if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
		throw new BareError(400, {
			code: 'UPGRADE_REQUIRED',
			id: 'request.headers.upgrade',
			message: 'Upgrade header must be websocket',
		});
	}

	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];

	server.accept();
	// Do not await — keep the WS handler alive independently of the HTTP response
	void handleWispConnection(server, options.logErrors);

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
};

export default function registerWisp(server: Server) {
	// Protocol requires trailing slash on the websocket URL
	server.socketRoutes.set('/wisp/', wispRoute);
}
