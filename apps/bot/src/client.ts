import { Client, GatewayIntentBits } from 'discord.js';

export function createBotClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
    ],
  });
}

export async function startBot(token: string): Promise<Client> {
  const client = createBotClient();
  await client.login(token);
  return client;
}
