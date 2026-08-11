import { execSync } from 'node:child_process';

const DEADLINE = Date.now() + 90_000;

process.stdout.write('Waiting for Postgres');
while (Date.now() < DEADLINE) {
  try {
    execSync('docker exec reep-postgres pg_isready -U reep -d reep_dev', {
      stdio: 'ignore',
    });
    console.log('\nPostgres is ready.');
    process.exit(0);
  } catch {
    process.stdout.write('.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
}

console.error('\nTimed out waiting for Postgres. Is `npm run db:up` running?');
process.exit(1);
