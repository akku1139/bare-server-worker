import BareServer from './BareServer.ts';
import type { BareMaintainer } from './BareServer.ts';
import registerV3 from './V3.ts';

interface BareServerInit {
	logErrors?: boolean;
	localAddress?: string;
	maintainer?: BareMaintainer;
}

/**
 * Create a Bare server.
 * This will handle all lifecycles for unspecified options (httpAgent, httpsAgent, metaMap).
 */
export default function createBareServer(
	directory: string,
	init: BareServerInit = {}
) {
	if (typeof directory !== 'string')
		throw new Error('Directory must be specified.');
	if (!directory.startsWith('/') || !directory.endsWith('/'))
		throw new RangeError('Directory must start and end with /');
	init.logErrors ??= false;

	const server = new BareServer(directory, init);
	registerV3(server);

	return server;
}
