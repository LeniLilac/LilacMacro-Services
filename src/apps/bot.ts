import { Client, Events, GatewayIntentBits, REST, Routes } from 'discord.js';
import { composeBotServices } from './composition.js';
import { botCommands, handleBotInteraction } from './bot-commands.js';
import { featureIds } from '../contracts/control-snapshot.js';
import { ServiceHeartbeat } from './service-heartbeat.js';

const services = composeBotServices();
const heartbeat = new ServiceHeartbeat(
  '/tmp/lilacmacro-bot-ready',
  async () => client.isReady() && (await services.control.ready()),
);

const rest = new REST({ version: '10' }).setToken(services.config.DISCORD_BOT_TOKEN);
await rest.put(Routes.applicationCommands(services.config.DISCORD_BOT_CLIENT_ID), {
  body: botCommands,
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (!services.config.adminIds.has(interaction.user.id)) return interaction.respond([]);
    const query = interaction.options.getFocused().toLowerCase();
    return interaction.respond(
      featureIds
        .filter((id) => id.includes(query))
        .slice(0, 25)
        .map((id) => ({ name: id, value: id })),
    );
  }
  if (!interaction.isChatInputCommand()) return;
  await handleBotInteraction(interaction, {
    adminIds: services.config.adminIds,
    control: services.control,
    diagnostics: services.diagnostics,
  });
});
client.once(Events.ClientReady, (readyClient) => {
  console.log(`Discord bot ready as ${readyClient.user.id}.`);
  void heartbeat.refresh();
});
client.on(Events.ShardDisconnect, () => void heartbeat.refresh());

const shutdown = async () => {
  await heartbeat.stop();
  client.destroy();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
heartbeat.start();
await client.login(services.config.DISCORD_BOT_TOKEN);
