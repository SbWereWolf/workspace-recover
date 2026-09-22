#!/usr/bin/env node
import { main, printSession } from '../src/cli.mjs';

try {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode ?? 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.session) printSession(error.session, { stateDir: error.stateRoot });
  process.stderr.write(`workspace-recover: ${message}\n`);
  process.exitCode = 1;
}
