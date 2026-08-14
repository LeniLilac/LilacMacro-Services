import {
  adminCommandEnvelopeSchema,
  type AdminCommandEnvelope,
} from '../contracts/admin-commands.js';
import type { SignedControlSnapshot } from '../contracts/control-snapshot.js';
import type { Clock } from './clock.js';
import type { Actor, ControlRepository, SnapshotSigner } from './ports.js';

export class CommandService {
  public constructor(
    private readonly repository: ControlRepository,
    private readonly signer: SnapshotSigner,
    private readonly clock: Clock,
  ) {}

  public async execute(actor: Actor, input: unknown): Promise<SignedControlSnapshot> {
    const envelope: AdminCommandEnvelope = adminCommandEnvelopeSchema.parse(input);
    authorizeCommand(actor, envelope.command.type);
    return this.repository.executeAndPublish(actor, envelope, this.signer, this.clock.now());
  }

  public async republish(): Promise<SignedControlSnapshot> {
    return this.repository.republish(this.signer, this.clock.now());
  }
}

const systemCommands = new Set(['game.observation', 'release.set']);

function authorizeCommand(actor: Actor, commandType: string): void {
  const systemOnly = systemCommands.has(commandType);
  if ((actor.kind === 'system') !== systemOnly) {
    throw new Error('Actor is not authorized for this control command.');
  }
  if (actor.kind !== 'system' && !/^\d+$/.test(actor.userId)) {
    throw new Error('Administrative actor identity was invalid.');
  }
  if (actor.kind === 'system' && actor.userId !== '0') {
    throw new Error('System actor identity was invalid.');
  }
}
