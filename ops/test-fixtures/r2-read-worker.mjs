// Test-only Worker entrypoint: reads /<BINDING_NAME>/<object-key> from the bound R2 bucket
// so tests can verify what a wrangler-spawned worker sees in the local R2 simulation.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [bindingName, ...keySegments] = url.pathname.slice(1).split('/');
    const bucket = env[bindingName];
    if (!bucket || typeof bucket.get !== 'function') {
      return new Response('unknown bucket binding', { status: 400 });
    }
    const object = await bucket.get(keySegments.join('/'));
    return object ? new Response(object.body) : new Response('missing', { status: 404 });
  },
};
