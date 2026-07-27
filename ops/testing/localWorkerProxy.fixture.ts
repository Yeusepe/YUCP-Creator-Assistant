export default {
  fetch(request: Request): Response {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/structured-log') {
      console.warn(JSON.stringify({ event: 'local.worker.probe' }));
    }
    return new Response(pathname, {
      status: 404,
    });
  },
};
