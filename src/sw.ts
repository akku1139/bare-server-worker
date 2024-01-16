import KVAdapter from './KVAdapter.ts';
import { cleanupDatabase } from './Meta.ts';
import createBareServer from './createServer.ts';

const kvDB = new KVAdapter(BARE);

const bare = createBareServer('/', {
	logErrors: true,
	database: kvDB,
});

addEventListener('fetch', (event) => {
	cleanupDatabase(kvDB);
	if (bare.shouldRoute(event.request))
		event.respondWith(bare.routeRequest(event.request));
});
