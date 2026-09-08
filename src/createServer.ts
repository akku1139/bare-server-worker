import BareServer from './BareServer.ts';
import type { BareMaintainer, Options } from './BareServer.ts';
import registerV3 from './V3.ts';
import registerWisp from './Wisp.ts';

interface BareServerInit {
	logErrors?: boolean;
	localAddress?: string;
	maintainer?: BareMaintainer;
	/** Enable Wisp protocol endpoint at {directory}wisp/ */
	wisp?: boolean;
}

/**
 * Create a Bare server.
 * This will handle all lifecycles for unspecified options (httpAgent, httpsAgent, metaMap).
 */
export default function createBareServer(
	directory: string,
	init: BareServerInit = {},
) {
	if (typeof directory !== 'string')
		throw new Error('Directory must be specified.');
	if (!directory.startsWith('/') || !directory.endsWith('/'))
		throw new RangeError('Directory must start and end with /');

	const options: Options = {
		logErrors: init.logErrors ?? false,
		localAddress: init.localAddress,
		maintainer: init.maintainer,
	};

	const server = new BareServer(directory, options);
	registerV3(server);
	if (init.wisp !== false) {
		registerWisp(server);
	}

	return server;
}
