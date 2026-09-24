import { handleApi } from './api.js';
import { refreshAll } from './refresh.js';
import { HttpError, json } from './util.js';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env);
      return json({ error: 'Not found' }, { status: 404 });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, { status: e.status });
      console.error('Unhandled error', e && e.stack ? e.stack : e);
      return json({ error: 'Something went wrong on the server' }, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      refreshAll(env, { now: event.scheduledTime }).then((r) => {
        if (Object.keys(r.errors).length) console.warn('Refresh errors', JSON.stringify(r.errors));
      }),
    );
  },
};
