import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rootDir = process.cwd();
const changelogPath = resolve(rootDir, 'CHANGELOG.md');
const packageJsonPath = resolve(rootDir, 'package.json');

function parseArgs(argv) {
  const args = argv.slice(2);
  let version;
  let date = new Date().toISOString().slice(0, 10);
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (token === '--date') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('`--date` requires a value like 2026-02-17');
      }
      date = value;
      index += 1;
      continue;
    }

    if (!version) {
      version = token;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return { version, date, dryRun };
}

function getPackageVersion() {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return packageJson.version;
}

function isSemverLike(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function collectSections(unreleasedBody) {
  const hintBullets = new Set([
    '- Features added in CLI / daemon / runtime / tools',
    '- Changes to existing behavior (explicitly note compatibility impact when applicable)',
    '- Bug fixes (briefly note reproduction conditions and impact scope)',
    '- Security-related fixes and evaluation rule updates',
    '- Major dependency updates (include rationale when applicable)',
    '- Release notes and supplements (migration steps, known limitations, etc.)',
    '-',
    '- '
  ]);

  const orderedHeadings = [
    '### Added',
    '### Changed',
    '### Fixed',
    '### Security',
    '### Dependencies',
    '### Notes'
  ];

  const sectionMap = new Map();
  for (const heading of orderedHeadings) {
    sectionMap.set(heading, []);
  }

  let currentHeading = null;

  for (const rawLine of unreleasedBody.split('\n')) {
    const line = rawLine.trimEnd();

    if (sectionMap.has(line.trim())) {
      currentHeading = line.trim();
      continue;
    }

    if (!currentHeading) {
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith('-')) {
      continue;
    }

    if (hintBullets.has(trimmed)) {
      continue;
    }

    const text = trimmed.replace(/^-\s*/, '').trim();
    if (!text) {
      continue;
    }

    sectionMap.get(currentHeading).push(`- ${text}`);
  }

  const outputLines = [];
  for (const heading of orderedHeadings) {
    const entries = sectionMap.get(heading);
    if (!entries || entries.length === 0) {
      continue;
    }

    outputLines.push(heading);
    outputLines.push(...entries);
    outputLines.push('');
  }

  while (outputLines.length > 0 && outputLines[outputLines.length - 1] === '') {
    outputLines.pop();
  }

  return outputLines.join('\n');
}

function main() {
  const { version: inputVersion, date, dryRun } = parseArgs(process.argv);
  const version = inputVersion ?? getPackageVersion();

  if (!isSemverLike(version)) {
    throw new Error(`Invalid version: ${version}`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date: ${date}`);
  }

  const content = readFileSync(changelogPath, 'utf8');

  const heading = `## [${version}] - ${date}`;
  if (content.includes(heading)) {
    throw new Error(`Version section already exists: ${heading}`);
  }

  const unreleasedRegex = /^## \[Unreleased\]\n([\s\S]*?)(?=^## \[[^\]]+\]|\Z)/m;
  const match = content.match(unreleasedRegex);

  if (!match) {
    throw new Error('`## [Unreleased]` section not found in CHANGELOG.md');
  }

  const unreleasedBody = match[1].trim();
  const releaseBody = collectSections(unreleasedBody);

  if (!releaseBody) {
    throw new Error('No releasable changelog entries found in [Unreleased]');
  }

  const unreleasedTemplate = [
    '## [Unreleased]',
    '',
    '### Added',
    '- Features added in CLI / daemon / runtime / tools',
    '',
    '### Changed',
    '- Changes to existing behavior (explicitly note compatibility impact when applicable)',
    '',
    '### Fixed',
    '- Bug fixes (briefly note reproduction conditions and impact scope)',
    '',
    '### Security',
    '- Security-related fixes and evaluation rule updates',
    '',
    '### Dependencies',
    '- Major dependency updates (include rationale when applicable)',
    '',
    '### Notes',
    '- Release notes and supplements (migration steps, known limitations, etc.)'
  ].join('\n');

  const releaseSection = `${heading}\n\n${releaseBody}`;
  const replacement = `${unreleasedTemplate}\n\n${releaseSection}\n\n`;
  const updated = content.replace(unreleasedRegex, replacement);

  if (dryRun) {
    console.log('Dry run: CHANGELOG.md would be updated with:');
    console.log('');
    console.log(releaseSection);
    return;
  }

  writeFileSync(changelogPath, updated, 'utf8');
  console.log(`Updated CHANGELOG.md with ${heading}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
