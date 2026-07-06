// Interactive release driver, run by `npm run release`.
//
// Shows the current version and asks what to release next (an explicit
// x.y.z, or a `patch` / `minor` / `major` keyword), then hands off to
// `npm version`, which runs the checks (preversion), prompts for CHANGELOG
// notes (the version hook), and creates the commit and tag. Finally it
// pushes the tag, which triggers the publish workflow.
//
// Set RELEASE_DRY_RUN=1 to print the commands instead of running them.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawnSync } from "node:child_process";

const dryRun = process.env.RELEASE_DRY_RUN === "1";
const { version: current } = JSON.parse(readFileSync("package.json", "utf8"));

const rl = createInterface({ input: stdin, output: stdout });
stdout.write(`\nCurrent version: ${current}\n`);
const answer = (
  await rl.question("New version — enter x.y.z, or patch / minor / major: ")
).trim();
rl.close();

if (!answer) {
  console.error("No version entered; aborting release.");
  process.exit(1);
}

function run(cmd, args) {
  if (dryRun) {
    stdout.write(`[dry-run] ${cmd} ${args.join(" ")}\n`);
    return 0;
  }
  return spawnSync(cmd, args, { stdio: "inherit" }).status ?? 1;
}

// `npm version` runs preversion (checks), then the version hook (which
// prompts for CHANGELOG notes), then commits and tags. It rejects an
// invalid version, so no need to validate here.
const versionStatus = run("npm", ["version", answer]);
if (versionStatus !== 0) process.exit(versionStatus);

process.exit(run("git", ["push", "--follow-tags"]));
