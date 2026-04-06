import type { Id } from '../../../../convex/_generated/dataModel';

export interface DownloadRouteSession {
  authUserId: string;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
  sourceChannelId?: string;
  archiveChannelId?: string;
  messageTitle: string;
  messageBody: string;
  requiredRoleIds: string[];
  roleLogic: 'all' | 'any';
  allowedExtensions: string[];
  expiresAt: number;
}

export type RouteRecord = {
  _id: Id<'download_routes'>;
  authUserId: string;
  guildId: string;
  sourceChannelId: string;
  archiveChannelId: string;
  messageTitle: string;
  messageBody: string;
  requiredRoleIds: string[];
  roleLogic: 'all' | 'any';
  allowedExtensions: string[];
  enabled: boolean;
};

export type ManageRouteRecord = RouteRecord & {
  sourceName: string;
  archiveName: string;
};
