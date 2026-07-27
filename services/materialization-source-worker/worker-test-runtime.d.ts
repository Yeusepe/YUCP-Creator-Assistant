type Env = Record<string, string>;

interface ExportedHandler<TEnvironment> {
  fetch(request: Request, env: TEnvironment): Response | Promise<Response>;
}
