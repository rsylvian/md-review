#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { startReviewServer } from './server.ts';
import { sidecarPathFor } from './store.ts';
import { resolveClientRuntime } from './vendor.ts';
import { installSkill } from './skill.ts';
import { readVersion } from './version.ts';

/**
 * `md-review <file>` serves a markdown file for review and blocks until the reviewer is
 * done — either by pressing Send or by closing the tab. The review then goes to stdout,
 * which is how the agent that launched the command receives it.
 *
 * Everything except the review itself goes to stderr, so an agent reading stdout gets
 * only the report.
 */

const PACKAGE_ROOT = join(import.meta.dirname, '..');

type Options = {
  port: string;
  open: boolean;
  grace: string;
  installSkill?: boolean;
};

function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(command, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    });
    child.on('error', () => note(`Could not open a browser. Visit ${url}`));
    child.unref();
  } catch {
    note(`Could not open a browser. Visit ${url}`);
  }
}

function readTarget(file: string): { absolute: string; source: string; modifiedAt: string } {
  const absolute = resolve(process.cwd(), file);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(absolute);
  } catch {
    throw new Error(`no such file: ${file}`);
  }
  if (!stats.isFile()) throw new Error(`not a file: ${file}`);
  return {
    absolute,
    source: readFileSync(absolute, 'utf8'),
    modifiedAt: stats.mtime.toISOString(),
  };
}

async function review(file: string, options: Options): Promise<void> {
  const { source, modifiedAt } = readTarget(file);
  const sidecarPath = sidecarPathFor(file);

  const server = await startReviewServer({
    filePath: file,
    source,
    sourceModifiedAt: modifiedAt,
    sidecarPath,
    clientDir: join(PACKAGE_ROOT, 'client'),
    vendorFile: resolveClientRuntime(),
    port: Number(options.port),
    graceMs: Number(options.grace),
  });

  note(`Reviewing ${file} at ${server.url}`);
  note('Leave comments, then press Send or just close the tab.');
  if (options.open) openBrowser(server.url);

  const onSignal = (): void => {
    note('\nInterrupted — writing the review as it stands.');
    server.finalize('signal');
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const result = await server.finished;
  await server.close();
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  // Saved alongside the comment store, so the report survives stdout being lost — a
  // backgrounded run whose output was never read, say. Structured data belongs in the
  // sidecar, which already holds every comment; a second JSON copy here would only
  // duplicate it.
  const base = sidecarPath.replace(/\.json$/, '');
  mkdirSync(dirname(sidecarPath), { recursive: true });
  writeFileSync(`${base}.review.md`, result.report, 'utf8');

  const reason =
    result.reason === 'sent'
      ? 'Review sent'
      : result.reason === 'tab-closed'
        ? 'Tab closed'
        : 'Interrupted';
  note(`${reason} — ${result.payload.openCount} open, ${result.payload.resolvedCount} resolved.`);
  note(`Saved to ${base}.review.md`);

  process.stdout.write(result.report);
}

const program = new Command();

program
  .name('md-review')
  .description('Review a markdown file in the browser and hand the comments back to your agent.')
  // Worth quoting in a bug report, so it goes to stdout like any other asked-for output.
  .version(readVersion(PACKAGE_ROOT), '-v, --version', 'print the version and exit')
  .argument('[file]', 'markdown file to review')
  .option('-p, --port <number>', 'port to listen on', '5710')
  .option('--no-open', 'do not open a browser automatically')
  .option(
    '--grace <ms>',
    'how long to wait after the tab closes before finalising, so reloads do not end the review',
    '1500',
  )
  .option('--install-skill', 'install the Claude Code skill into ~/.claude/skills and exit')
  .action(async (file: string | undefined, options: Options) => {
    try {
      if (options.installSkill === true) {
        const target = installSkill(PACKAGE_ROOT);
        note(`Installed the md-review skill to ${target}`);
        return;
      }
      if (file === undefined) {
        program.help({ error: true });
        return;
      }
      await review(file, options);
    } catch (error) {
      note(`md-review: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
