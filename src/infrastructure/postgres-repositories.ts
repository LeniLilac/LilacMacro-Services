import pg, { type Pool, type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../contracts/canonical-json.js';
import {
  adminCommandSchema,
  adminCommandEnvelopeSchema,
  type AdminCommandEnvelope,
} from '../contracts/admin-commands.js';
import {
  signedControlSnapshotSchema,
  type SignedControlSnapshot,
} from '../contracts/control-snapshot.js';
import { applyAdminCommand, type MutableControlState } from '../domain/control-state.js';
import type {
  Actor,
  ControlAuditRecord,
  ControlRepository,
  SnapshotSigner,
} from '../domain/ports.js';

export { PostgresDiagnosticRepository } from './postgres-diagnostic-repository.js';

export function createPool(connectionString: string): Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
  });
}

export class PostgresControlRepository implements ControlRepository {
  public constructor(private readonly pool: Pool) {}

  public async readState(): Promise<MutableControlState> {
    const result = await this.pool.query<{ state: MutableControlState }>(
      'SELECT state FROM control_state WHERE singleton = true',
    );
    if (result.rowCount !== 1) throw new Error('Control state is unavailable.');
    const state = structuredClone(result.rows[0]!.state);
    return {
      ...state,
      releaseEvidence: state.releaseEvidence ?? null,
      releaseFloorVersion:
        state.releaseFloorVersion ??
        state.releaseEvidence?.version ??
        state.release?.version ??
        null,
    };
  }

  public async executeAndPublish(
    actor: Actor,
    envelopeInput: AdminCommandEnvelope,
    signer: SnapshotSigner,
    now: Date,
  ): Promise<SignedControlSnapshot> {
    const envelope = adminCommandEnvelopeSchema.parse(envelopeInput);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const replay = await client.query<{
        snapshot: unknown;
        actor_kind: Actor['kind'];
        actor_id: string;
        command: unknown;
        resulting_revision: string;
      }>(
        `SELECT control_commands.result_snapshot AS snapshot, control_commands.actor_kind,
                control_commands.actor_id, control_commands.command,
                control_commands.resulting_revision
         FROM control_commands
         WHERE control_commands.command_id = $1`,
        [envelope.commandId],
      );
      if (replay.rowCount) {
        const original = replay.rows[0]!;
        if (
          original.actor_kind !== actor.kind ||
          original.actor_id !== actor.userId ||
          Number(original.resulting_revision) - 1 !== envelope.expectedRevision ||
          canonicalJson(original.command) !== canonicalJson(envelope.command)
        ) {
          throw new Error('Control command replay did not match the original request.');
        }
        await client.query('COMMIT');
        return signedControlSnapshotSchema.parse(original.snapshot);
      }

      const current = await lockControlState(client);
      if (current.revision !== envelope.expectedRevision)
        throw new Error('Control revision conflict.');
      const next: MutableControlState = {
        ...applyAdminCommand(current, envelope.command),
        revision: current.revision + 1,
      };
      const snapshot = await signer.sign(next, now);
      const priorAudit = await client.query<{ entry_hash: string }>(
        'SELECT entry_hash FROM control_commands ORDER BY resulting_revision DESC LIMIT 1',
      );
      const previousHash = priorAudit.rows[0]?.entry_hash ?? null;
      const entryHash = auditEntryHash({
        previousHash,
        commandId: envelope.commandId,
        actorKind: actor.kind,
        actorId: actor.userId,
        command: envelope.command,
        resultingRevision: next.revision,
        createdAt: now.toISOString(),
      });
      await client.query(
        'UPDATE control_state SET revision = $1, state = $2::jsonb, updated_at = now() WHERE singleton = true',
        [next.revision, JSON.stringify(next)],
      );
      await client.query(
        `INSERT INTO control_commands
         (command_id, actor_kind, actor_id, command, result_snapshot, resulting_revision, created_at,
          previous_hash, entry_hash)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)`,
        [
          envelope.commandId,
          actor.kind,
          actor.userId,
          JSON.stringify(envelope.command),
          JSON.stringify(snapshot),
          next.revision,
          now,
          previousHash,
          entryHash,
        ],
      );
      await client.query(
        'INSERT INTO published_snapshots(revision, snapshot) VALUES ($1, $2::jsonb)',
        [snapshot.payload.revision, JSON.stringify(snapshot)],
      );
      await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async republish(signer: SnapshotSigner, now: Date): Promise<SignedControlSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const state = await lockControlState(client);
      const snapshot = await signer.sign(state, now);
      await client.query(
        `INSERT INTO published_snapshots(revision, snapshot) VALUES ($1, $2::jsonb)
         ON CONFLICT (revision) DO UPDATE SET snapshot = EXCLUDED.snapshot`,
        [snapshot.payload.revision, JSON.stringify(snapshot)],
      );
      await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async readPublished(): Promise<SignedControlSnapshot | null> {
    const result = await this.pool.query<{ snapshot: unknown }>(
      'SELECT snapshot FROM published_snapshots ORDER BY revision DESC LIMIT 1',
    );
    return result.rowCount ? signedControlSnapshotSchema.parse(result.rows[0]!.snapshot) : null;
  }

  public async listAudit(limit: number): Promise<ControlAuditRecord[]> {
    const result = await this.pool.query(
      `SELECT command_id, actor_kind, actor_id, command, resulting_revision,
              created_at, previous_hash, entry_hash
       FROM control_commands ORDER BY resulting_revision DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      commandId: String(row.command_id),
      actor: { kind: row.actor_kind as Actor['kind'], userId: String(row.actor_id) },
      command: adminCommandSchema.parse(row.command),
      resultingRevision: Number(row.resulting_revision),
      createdAt: new Date(String(row.created_at)),
      previousHash: row.previous_hash ? String(row.previous_hash) : null,
      entryHash: String(row.entry_hash),
    }));
  }
}

async function lockControlState(client: PoolClient): Promise<MutableControlState> {
  const result = await client.query<{ state: MutableControlState }>(
    'SELECT state FROM control_state WHERE singleton = true FOR UPDATE',
  );
  if (result.rowCount !== 1) throw new Error('Control state is unavailable.');
  return result.rows[0]!.state;
}

function auditEntryHash(value: {
  previousHash: string | null;
  commandId: string;
  actorKind: Actor['kind'];
  actorId: string;
  command: AdminCommandEnvelope['command'];
  resultingRevision: number;
  createdAt: string;
}): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
