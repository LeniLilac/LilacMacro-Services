import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

const iterations = 4_096;

export function createPostgresScramVerifier(password: string, salt = randomBytes(16)): string {
  if (Buffer.byteLength(password, 'utf8') < 32 || salt.length < 16) {
    throw new Error('PostgreSQL runtime credential material was too short.');
  }
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key', 'utf8').digest();
  const storedKey = createHash('sha256').update(clientKey).digest('base64');
  const serverKey = createHmac('sha256', saltedPassword)
    .update('Server Key', 'utf8')
    .digest('base64');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}

export function createPostgresRoleProvisionStatement(
  role: string,
  password: string,
  exists: boolean,
): string {
  if (!/^lilacmacro_(api|control|worker)$/.test(role)) {
    throw new Error('Database role was invalid.');
  }
  const verb = exists ? 'ALTER ROLE' : 'CREATE ROLE';
  const verifier = createPostgresScramVerifier(password);
  return `${verb} ${role} WITH LOGIN PASSWORD '${verifier}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`;
}
