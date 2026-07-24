type Env = {};

interface ExportedHandler<TEnvironment> {
  fetch(request: Request, env: TEnvironment): Response | Promise<Response>;
}
