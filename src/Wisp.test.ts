/**
 * Unit tests for Wisp packet codec (no Workers runtime required).
 * Run with: npm test
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
	BUFFER_SIZE,
	buildConnectPayload,
	buildContinuePacket,
	buildInfoPacket,
	encodePacket,
	parsePacket,
	PACKET_CLOSE,
	PACKET_CONNECT,
	PACKET_CONTINUE,
	PACKET_DATA,
	PACKET_INFO,
	STREAM_TCP,
} from './Wisp.ts';

describe('Wisp packet codec', () => {
	it('encodePacket / parsePacket round-trip', () => {
		const payload = new TextEncoder().encode('hello');
		const buf = encodePacket(PACKET_DATA, 42, payload);
		const parsed = parsePacket(buf);
		assert.equal(parsed.type, PACKET_DATA);
		assert.equal(parsed.streamId, 42);
		assert.deepEqual(Array.from(parsed.payload), Array.from(payload));
	});

	it('uses little-endian stream id', () => {
		const buf = encodePacket(PACKET_CLOSE, 0x01020304, new Uint8Array([0x01]));
		const bytes = new Uint8Array(buf);
		// type
		assert.equal(bytes[0], PACKET_CLOSE);
		// stream id LE: 04 03 02 01
		assert.equal(bytes[1], 0x04);
		assert.equal(bytes[2], 0x03);
		assert.equal(bytes[3], 0x02);
		assert.equal(bytes[4], 0x01);
		assert.equal(bytes[5], 0x01);
	});

	it('parsePacket rejects short packets', () => {
		assert.throws(() => parsePacket(new ArrayBuffer(4)), /too short/);
	});

	it('buildInfoPacket has type INFO, stream 0, version 2.1', () => {
		const buf = buildInfoPacket();
		const { type, streamId, payload } = parsePacket(buf);
		assert.equal(type, PACKET_INFO);
		assert.equal(streamId, 0);
		assert.equal(payload[0], 2); // major
		assert.equal(payload[1], 1); // minor
		// extension Stream Open Confirmation id=0x05
		assert.equal(payload[2], 0x05);
	});

	it('buildContinuePacket encodes buffer remaining LE', () => {
		const buf = buildContinuePacket(7, BUFFER_SIZE);
		const { type, streamId, payload } = parsePacket(buf);
		assert.equal(type, PACKET_CONTINUE);
		assert.equal(streamId, 7);
		assert.equal(payload.byteLength, 4);
		assert.equal(new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true), BUFFER_SIZE);
	});

	it('buildConnectPayload matches client CONNECT layout', () => {
		// Mirrors wisp-js ConnectPayload: stream_type u8, port u16 LE, hostname UTF-8
		const payload = buildConnectPayload(STREAM_TCP, 443, 'example.com');
		assert.equal(payload[0], STREAM_TCP);
		assert.equal(new DataView(payload.buffer, payload.byteOffset + 1, 2).getUint16(0, true), 443);
		assert.equal(new TextDecoder().decode(payload.subarray(3)), 'example.com');

		const packet = encodePacket(PACKET_CONNECT, 1, payload);
		const parsed = parsePacket(packet);
		assert.equal(parsed.type, PACKET_CONNECT);
		assert.equal(parsed.streamId, 1);
		assert.equal(parsed.payload[0], STREAM_TCP);
	});

	it('empty payload packets are valid', () => {
		const buf = encodePacket(PACKET_CLOSE, 99);
		const parsed = parsePacket(buf);
		assert.equal(parsed.type, PACKET_CLOSE);
		assert.equal(parsed.streamId, 99);
		assert.equal(parsed.payload.byteLength, 0);
	});
});
