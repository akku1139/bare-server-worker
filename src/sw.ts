import createBareServer from './createServer.ts';

const bare = createBareServer('/', {
  logErrors: true,
});

interface Env {}

export default {
  async fetch(request: Request, env: Env) {
    if (bare.shouldRoute(request)) return bare.routeRequest(request));
  },
}

