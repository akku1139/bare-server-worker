import createBareServer from './createServer.ts';

const bare = createBareServer('/', {
	logErrors: true,
});

addEventListener('fetch', (event) => {
	if (bare.shouldRoute(event.request))
		event.respondWith(bare.routeRequest(event.request));
});
