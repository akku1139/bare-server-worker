import createBareServer from './createServer.ts';

const kvDB = new KVAdapter(BARE);

const bare = createBareServer('/', {
	logErrors: true,
});

addEventListener('fetch', (event) => {
	if (bare.shouldRoute(event.request))
		event.respondWith(bare.routeRequest(event.request));
});
