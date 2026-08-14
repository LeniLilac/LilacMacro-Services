import { randomUUID } from 'node:crypto';
import {
  ApplicationIntegrationType,
  ChatInputCommandInteraction,
  InteractionContextType,
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { AdminCommand } from '../contracts/admin-commands.js';
import { featureIds, type ScheduleKey } from '../contracts/control-snapshot.js';
import type {
  BotControlClient,
  BotDiagnosticClient,
} from '../infrastructure/internal-api-client.js';

export const botCommands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  command('macro-game', 'Publish game availability.')
    .addBooleanOption((option) =>
      option.setName('available').setDescription('Whether the game is open.').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('Optional public maintenance message.')
        .setMaxLength(240),
    )
    .toJSON(),
  command('macro-code', 'Add or remove a redeem code.')
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('Action.')
        .setRequired(true)
        .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }),
    )
    .addStringOption((option) =>
      option.setName('code').setDescription('Redeem code.').setRequired(true).setMaxLength(64),
    )
    .addStringOption((option) =>
      option.setName('expires-at').setDescription('Optional ISO-8601 UTC expiry for a new code.'),
    )
    .toJSON(),
  command('macro-feature', 'Disable or re-enable a closed macro feature.')
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('Action.')
        .setRequired(true)
        .addChoices({ name: 'Disable', value: 'disable' }, { name: 'Enable', value: 'enable' }),
    )
    .addStringOption((option) =>
      option
        .setName('feature')
        .setDescription('Feature ID.')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Reason for disabling.').setMaxLength(240),
    )
    .addStringOption((option) =>
      option.setName('expires-at').setDescription('Optional ISO-8601 UTC expiry.'),
    )
    .toJSON(),
  command('macro-schedule', 'Set a UTC shop reset schedule and cycle anchor.')
    .addStringOption((option) =>
      option
        .setName('key')
        .setDescription('Schedule.')
        .setRequired(true)
        .addChoices(
          { name: 'Gold shop reset', value: 'gold-shop-reset' },
          { name: 'Raid shop reset', value: 'raid-shop-reset' },
          { name: 'Expedition shop reset', value: 'expedition-shop-reset' },
        ),
    )
    .addStringOption((option) =>
      option.setName('next-at').setDescription('Next ISO-8601 UTC occurrence.').setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('cadence-seconds')
        .setDescription('Repeat cadence in seconds.')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(366 * 24 * 60 * 60),
    )
    .toJSON(),
  command('macro-diagnostic', 'Accept, reject, or delete a diagnostic archive.')
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('Action.')
        .setRequired(true)
        .addChoices(
          { name: 'Accept', value: 'accept' },
          { name: 'Reject', value: 'reject' },
          { name: 'Delete', value: 'delete' },
        ),
    )
    .addStringOption((option) =>
      option.setName('upload-id').setDescription('Diagnostic upload UUID.').setRequired(true),
    )
    .toJSON(),
];

export interface BotDependencies {
  adminIds: ReadonlySet<string>;
  control: BotControlClient;
  diagnostics: BotDiagnosticClient;
}

export async function handleBotInteraction(
  interaction: ChatInputCommandInteraction,
  dependencies: BotDependencies,
): Promise<void> {
  if (!dependencies.adminIds.has(interaction.user.id)) {
    await interaction.reply({ content: 'Administrator access required.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    if (interaction.commandName === 'macro-diagnostic') {
      const action = interaction.options.getString('action', true) as
        'accept' | 'reject' | 'delete';
      await dependencies.diagnostics.moderateDiagnostic(
        interaction.user.id,
        interaction.options.getString('upload-id', true),
        action,
      );
      await interaction.editReply(`Diagnostic ${action} completed.`);
      return;
    }
    const command = commandFromInteraction(interaction);
    const revision = await dependencies.control.execute(interaction.user.id, randomUUID(), command);
    await interaction.editReply(`Published signed control revision ${revision}.`);
  } catch (error) {
    await interaction.editReply(
      error instanceof Error ? safeMessage(error.message) : 'Command failed.',
    );
  }
}

export function commandFromInteraction(interaction: ChatInputCommandInteraction): AdminCommand {
  if (interaction.commandName === 'macro-game') {
    return {
      type: 'game.availability',
      available: interaction.options.getBoolean('available', true),
      message: interaction.options.getString('message'),
    };
  }
  if (interaction.commandName === 'macro-code') {
    const code = interaction.options.getString('code', true);
    return interaction.options.getString('action', true) === 'add'
      ? { type: 'code.add', code, expiresAt: interaction.options.getString('expires-at') }
      : { type: 'code.remove', code };
  }
  if (interaction.commandName === 'macro-feature') {
    const feature = interaction.options.getString('feature', true);
    if (!featureIds.includes(feature as (typeof featureIds)[number]))
      throw new Error('Unknown feature ID.');
    return interaction.options.getString('action', true) === 'disable'
      ? {
          type: 'feature.disable',
          feature: feature as (typeof featureIds)[number],
          reason:
            interaction.options.getString('reason') ?? 'Temporarily disabled by an administrator.',
          expiresAt: interaction.options.getString('expires-at'),
        }
      : { type: 'feature.enable', feature: feature as (typeof featureIds)[number] };
  }
  if (interaction.commandName === 'macro-schedule') {
    return {
      type: 'schedule.set',
      key: interaction.options.getString('key', true) as ScheduleKey,
      nextAt: interaction.options.getString('next-at', true),
      cadenceSeconds: interaction.options.getInteger('cadence-seconds', true),
    };
  }
  throw new Error('Unknown bot command.');
}

function command(name: string, description: string): SlashCommandBuilder {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setIntegrationTypes(
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall,
    )
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    );
}

function safeMessage(message: string): string {
  return /^(Control revision conflict|Diagnostic upload|Unknown feature)/.test(message)
    ? message
    : 'Command failed. Check service logs.';
}
