declare module 'cloudflare:sockets' {
	export interface SocketAddress {
		hostname: string;
		port: number;
	}

	export interface SocketOptions {
		secureTransport?: 'off' | 'on' | 'starttls';
		allowHalfOpen?: boolean;
	}

	export interface Socket {
		readonly readable: ReadableStream<Uint8Array>;
		readonly writable: WritableStream<Uint8Array>;
		readonly closed: Promise<void>;
		close(): Promise<void>;
		startTls(): Socket;
	}

	export function connect(
		address: SocketAddress | string,
		options?: SocketOptions,
	): Socket;
}
