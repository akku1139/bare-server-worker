import BareServer from './BareServer.js';
import type { BareMaintainer } from './BareServer.js';
import type { Database } from './Meta.js';
import { JSONDatabaseAdapter } from './Meta.js';
import { cleanupDatabase } from './Meta.js';
import registerV3 from './V3.js';

interface BareServerInit {
	logErrors?: boolean;
	localAddress?: string;
	maintainer?: BareMaintainer;
	database?: Database;
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

	const cleanup: (() => void)[] = [];

	if (!init.database) {
		const database = new Map<string, string>();
		const interval = setInterval(() => cleanupDatabase(database), 1000);
		init.database = database;
		cleanup.push(() => clearInterval(interval));
	}

	const server = new BareServer(directory, <
		Required<BareServerInit> & { database: JSONDatabaseAdapter }
	>{
		...init,
		database: new JSONDatabaseAdapter(init.database),
	});
	registerV3(server);

	server.addEventListener('close', () => {
		for (const cb of cleanup) cb();
	});

	return server;
}
