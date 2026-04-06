export function createUserDataExportResponse(exportPayload: unknown): Response {
  return new Response(JSON.stringify(exportPayload, null, 2), {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="yucp-data-export.json"',
      'Content-Type': 'application/json',
    },
  });
}

export async function disconnectProviderConnectionsOrThrow<TConvex>(options: {
  convex: TConvex;
  apiSecret: string;
  authUserId: string;
  connections: ReadonlyArray<{ id?: string }>;
  runProviderDisconnectHook(
    convex: TConvex,
    connectionId: string,
    authUserId: string
  ): Promise<void>;
  disconnectConnection(connectionId: string): Promise<void>;
  onDisconnectFailure?(details: { connectionId: string; error: string }): void;
}): Promise<void> {
  const failedConnectionIds: string[] = [];

  for (const connection of options.connections) {
    if (!connection.id) {
      continue;
    }

    try {
      await options.runProviderDisconnectHook(options.convex, connection.id, options.authUserId);
      await options.disconnectConnection(connection.id);
    } catch (disconnectErr) {
      failedConnectionIds.push(connection.id);
      options.onDisconnectFailure?.({
        connectionId: connection.id,
        error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
      });
    }
  }

  if (failedConnectionIds.length > 0) {
    throw new Error(
      `Failed to disconnect ${failedConnectionIds.length} provider connection${
        failedConnectionIds.length === 1 ? '' : 's'
      }: ${failedConnectionIds.join(', ')}`
    );
  }
}
