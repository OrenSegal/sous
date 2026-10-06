// Copyright 2026 Anthropic PBC
// Modifications copyright 2026 Oren Segal
// SPDX-License-Identifier: Apache-2.0
//
// Blast Shield is a modified fork of "Blast Radius" from anthropics/claude-code-playground
// (claude-code/mods/blast-radius). See NOTICE for what changed.
//
// Blast Shield: holds a risky Bash command and shows what it would change.
//
// tool.call (Bash): if the command is risky, work out its blast radius, open a
// pane with Proceed and Cancel, and hold the call until one is pressed.
// ui.render (Pane): draws the report. If the surface won't place the pane (a
// narrow terminal), the same report is drawn in the AbovePrompt band instead.
//
// Holding: a hook has 10 s of its own time, but time spent inside a `$` call is
// free. So the hold loop waits on a short `$.process.run(["sleep", ...])` until
// a button's onPress sets the decision.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions.

const PANE_ID = "blast-shield";
const POLL_SECONDS = "0.25";
const HOLD_LIMIT_MS = 10 * 60 * 1000;
const LIST_MAX = 10;

// The call being held, or null. One at a time: Bash calls in a turn run in order.
let held = null;

// The session's scoreboard, shown in the status line. Cosmetic: a reload resets it.
const tally = { held: 0, refused: 0, ran: 0 };

export function register(on) {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const risk = classify(String(e.command ?? ""));
    if (risk === null) {
      return next(e);
    }
    // One hold at a time. If another risky call is already held (a subagent's,
    // say), wait until it is answered. `held` is claimed with no await between
    // the check and the claim, so two waiting calls can't both get through.
    while (held !== null) {
      if (next.signal.aborted) {
        return { deny: "Blast Shield held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to." };
      }
      await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
    }
    const mine = { command: String(e.command), risk, report: null, decision: null, where: "pane" };
    held = mine;

    let opened = { isPlaced: false };
    let decision;
    let summary = risk.label;
    try {
      // Measure where the command will run: the session folder, moved by any
      // `cd dir &&` or `git -C dir` earlier in the same command line.
      const sessionCwd = await $.session.cwd();
      const cwd = risk.dir ? await resolveDir($, sessionCwd, risk.dir) : sessionCwd;
      mine.report = cwd === null
        ? { summary: `${risk.label} in ${risk.dir}`, lines: [], note: `Couldn't find the folder ${risk.dir}, so I couldn't measure what this would change.` }
        : await measure($, risk, cwd);
      summary = mine.report.summary;

      opened = await $.ui.open({ id: PANE_ID, title: "Blast Shield", focus: true, rows: paneRows(mine.report) });
      if (!opened.isPlaced) {
        mine.where = "band";
      }
      $.ui.invalidate("ui.render");

      const startedAt = await $.clock.now();
      while (mine.decision === null) {
        if (next.signal.aborted) {
          mine.decision = "interrupted";
          break;
        }
        if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
          mine.decision = "timeout";
          break;
        }
        await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
      }
    } catch {
      mine.decision = "error"; // anything unexpected refuses the command
    } finally {
      decision = mine.decision;
      // Close this call's pane before releasing the hold, so the next call's
      // pane can't be the one that gets closed.
      try {
        if (opened.isPlaced) {
          await $.ui.close({ id: PANE_ID });
        }
      } catch {
        // the pane is already gone
      }
      if (held === mine) {
        held = null;
      }
      $.ui.invalidate("ui.render");
    }

    tally.held += 1;
    if (decision === "proceed") {
      tally.ran += 1;
    } else {
      tally.refused += 1;
    }
    try {
      $.ui.status(`shield: ${tally.held} held, ${tally.refused} refused, ${tally.ran} ran`);
      if (decision === "cancel") {
        $.ui.toast(`Blast Shield spared you: ${summary}`);
      }
    } catch {
      // the scoreboard is cosmetic; never let it change the answer
    }

    if (decision === "proceed") {
      $.ui.toast("Blast Shield: running it");
      return next(e);
    }
    const why = {
      cancel: "the user pressed Cancel",
      timeout: "no answer within 10 minutes",
      interrupted: "the turn was interrupted",
      error: "Blast Shield hit an error while holding it",
    }[decision] ?? "no answer was recorded";
    return {
      deny: `Blast Shield held this command and did not run it: ${why}. It would have: ${summary}. It matched the rule for ${risk.label}.${impactForClaude(mine)} Do not retry it unless the user asks you to.`,
    };
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID || held === null || held.report === null) {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (held === null || held.report === null || held.where !== "band") {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });
}

function impactForClaude(held) {
  const lines = held?.report?.impact;
  return Array.isArray(lines) && lines.length > 0 ? ` Consequences: ${lines.join(" ")}` : "";
}

// ---- What counts as risky -------------------------------------------------

// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]);
// Commands that only read, so a bare word "migrate" in them isn't a migration.
const READ_ONLY = new Set(["ls", "cat", "echo", "printf", "grep", "rg", "find", "less", "head", "tail", "cd", "git"]);

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir, arg) {
  if (arg === undefined || arg === "~" || arg.startsWith("/") || arg.startsWith("~/")) {
    return arg ?? "~";
  }
  return dir ? `${dir}/${arg}` : arg;
}

/** The first risky segment of a shell command, or null. */
export function classify(command) {
  let dir = null; // where a `cd` earlier on the line moved to; null means the session folder
  const scopes = []; // dir to restore when a ( subshell ) closes
  const pushed = []; // pushd stack, for popd
  for (const raw of command.split(/&&|\|\||;|\||\n/)) {
    const opens = (raw.match(/^\s*\(+/)?.[0].trim().length) ?? 0;
    // Trailing redirects and & don't hide a closing ) : `(cd sub && make) > log`.
    const tail = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, "");
    const closes = (tail.match(/\)+\s*$/)?.[0].trim().length) ?? 0;
    for (let k = 0; k < opens; k += 1) {
      scopes.push(dir);
    }
    const risk = classifySegment(raw, dir, pushed);
    if (risk !== null && risk.cd === undefined) {
      return { ...risk, segment: raw.trim() }; // which part of the line matched, for the pane
    }
    if (risk !== null) {
      dir = risk.cd; // a cd, pushd or popd moved the folder
    }
    for (let k = 0; k < closes && scopes.length > 0; k += 1) {
      dir = scopes.pop(); // a cd inside ( ... ) doesn't outlive it
    }
  }
  return null;
}

// Words that can come before the real command without changing what it does.
const PREFIXES = new Set(["exec", "nohup", "then", "do", "else", "!"]);

/** One segment: a risk, { cd } for a folder change, or null. */
function classifySegment(segment, dir, pushed) {
  {
    const words = tokenize(segment.trim().replace(/^[({]+\s*/, "").replace(/\s*[)}]+$/, ""));
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      words.shift(); // leading VAR=value
    }
    if (words[0] === "sudo") {
      words.shift();
      while (words.length > 0 && words[0].startsWith("-")) {
        const option = words.shift();
        if (SUDO_VALUE_OPTIONS.has(option)) {
          words.shift();
        }
      }
    }
    while (words.length > 0 && (PREFIXES.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
      words.shift();
    }
    // Wrappers with their own options or a value: `timeout 5 rm`, `doas rm`, `env -i rm`, `time -p rm`.
    for (let guard = 0; guard < 4 && words.length > 0; guard += 1) {
      if (words[0] === "doas") {
        words.shift();
        while (words[0]?.startsWith("-")) {
          words.splice(0, words[0] === "-u" ? 2 : 1);
        }
      } else if (words[0] === "timeout") {
        words.shift();
        while (words[0]?.startsWith("-")) {
          words.splice(0, /^-[ks]$/.test(words[0]) ? 2 : 1);
        }
        words.shift(); // the duration
      } else if (words[0] === "env" || words[0] === "time" || words[0] === "command") {
        words.shift();
        while (words[0]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
          words.shift();
        }
      } else {
        break;
      }
    }
    if (words[0] === "nice") {
      words.shift();
      if (words[0] === "-n") {
        words.splice(0, 2);
      } else if (/^-\d+$/.test(words[0] ?? "")) {
        words.shift();
      }
    }
    const [first, ...args] = words;
    if (first === undefined) {
      return null;
    }
    const cmd = first.replace(/^\\/, ""); // \rm skips aliases; it's still rm
    if (cmd === "cd") {
      return { cd: args[0] === "-" ? "-" : joinDir(dir, args[0]) };
    }
    if (cmd === "pushd") {
      pushed.push(dir);
      return { cd: joinDir(dir, args[0]) };
    }
    if (cmd === "popd") {
      return { cd: pushed.length > 0 ? pushed.pop() : "-" };
    }
    if (cmd === "rm" || cmd.endsWith("/rm")) {
      const flags = args.filter((a) => a.startsWith("-"));
      const recursive = flags.some((f) => f === "--recursive" || (/^-[^-]/.test(f) && /[rR]/.test(f)));
      const force = flags.some((f) => f === "--force" || (/^-[^-]/.test(f) && f.includes("f")));
      if (recursive || force) {
        const targets = args.filter((a) => !a.startsWith("-") || a === "-");
        return { kind: "rm", label: `rm ${flags.join(" ")}`.trim(), targets, dir };
      }
    }
    if (cmd === "xargs" && args.some((a) => a === "rm" || a.endsWith("/rm"))) {
      return { kind: "opaque", label: "xargs rm", note: "The files come from standard input, so I can't list them before it runs." };
    }
    if (cmd === "find" && args.includes("-" + "delete")) {
      return { kind: "find-delete", label: "find with its delete action", args, dir };
    }
    const infra = classifyInfra(cmd, args, dir);
    if (infra !== null) {
      return infra;
    }
    if (cmd === "git") {
      // Git's own options come before the subcommand; -C moves where it runs.
      let gitDir = dir;
      let i = 0;
      while (i < args.length && args[i].startsWith("-")) {
        if (args[i] === "-C" && i + 1 < args.length) {
          gitDir = joinDir(gitDir, args[i + 1]);
          i += 2;
        } else if (args[i] === "-c" && i + 1 < args.length) {
          i += 2;
        } else {
          i += 1;
        }
      }
      const sub = args[i];
      const rest = args.slice(i + 1);
      if (sub === "reset" && rest.includes("--hard")) {
        return { kind: "git-reset", label: "git reset --hard", args: rest, dir: gitDir };
      }
      if (sub === "clean") {
        return { kind: "git-clean", label: "git clean", args: rest, dir: gitDir };
      }
      if (sub === "push" && rest.some((a) => a === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a.startsWith("--force-with-lease") || /^\+/.test(a))) {
        return { kind: "git-push-force", label: "git push --force", args: rest, dir: gitDir };
      }
      if (sub === "branch" && rest.some((a) => /^-[a-zA-Z]*D[a-zA-Z]*$/.test(a))) {
        return { kind: "git-branch-delete", label: "git branch -D", args: rest, dir: gitDir };
      }
      if (sub === "stash" && (rest[0] === "drop" || rest[0] === "clear")) {
        return { kind: "git-stash", label: `git stash ${rest[0]}`, args: rest, dir: gitDir };
      }
      const stagedOnly = sub === "restore" && rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W");
      if ((sub === "checkout" || sub === "restore") && !stagedOnly) {
        // `git checkout -- paths` and `git restore paths` overwrite worktree files; a bare
        // `git checkout branch` doesn't. Paths follow `--`, or (restore) the flags.
        const dd = rest.indexOf("--");
        let paths = [];
        if (dd >= 0) {
          paths = rest.slice(dd + 1);
        } else if (sub === "restore") {
          paths = rest.filter((a, i) => !a.startsWith("-") && rest[i - 1] !== "--source" && rest[i - 1] !== "-s");
        } else if (rest.includes(".")) {
          paths = ["."];
        }
        if (paths.length > 0) {
          return { kind: "git-checkout", label: `git ${sub} ${paths.join(" ")}`, args: rest, paths, dir: gitDir };
        }
      }
    }
    const joined = words.join(" ");
    if (/\balembic\s+upgrade\b/.test(joined)) {
      return { kind: "migrate", tool: "alembic", label: "alembic upgrade", dir };
    }
    if (/\bdb:migrate(?!:status\b)/.test(joined)) {
      return { kind: "migrate", tool: "rails", label: "db:migrate", dir };
    }
    if (/\bprisma\s+migrate\b/.test(joined)) {
      return { kind: "migrate", tool: "prisma", label: "prisma migrate", dir };
    }
    if (/\bmanage\.py\s+migrate\b/.test(joined)) {
      return { kind: "migrate", tool: "django", label: "manage.py migrate", dir };
    }
    if (!READ_ONLY.has(cmd) && args.includes("migrate")) {
      return { kind: "migrate", tool: "unknown", label: "migrate", dir };
    }
  }
  return null;
}

const SQL_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlcmd", "mongosh", "redis-cli", "duckdb"]);
// DROP, TRUNCATE, and a DELETE with no WHERE. Matched on the word list, so a quoted statement counts.
const DESTRUCTIVE_SQL = /\bdrop\s+(?:table|database|schema|index|view)\b|\btruncate\s+(?:table\s+)?[\w."`]+|\bdelete\s+from\s+[\w."`]+\s*;?\s*$|\bflushall\b|\bflushdb\b|\bdropDatabase\b/i;

/** Docker, kubectl, terraform, SQL clients and recursive chmod/chown, or null. */
function classifyInfra(cmd, args, dir) {
  const base = cmd.split("/").pop();
  const plain = args.filter((a) => !a.startsWith("-"));
  if (base === "docker" || base === "podman") {
    const [a, b] = plain;
    const flags = args.filter((x) => x.startsWith("-"));
    if ((a === "system" && b === "prune") || (a === "volume" && (b === "prune" || b === "rm" || b === "remove")) || (a === "image" && b === "prune" && flags.some((f) => /^-[a-z]*a/.test(f) || f === "--all"))) {
      return { kind: "opaque", label: `${base} ${a} ${b}`, docker: { bin: base, a, b, names: plain.slice(2) }, note: "Removes containers, images or volumes. Volumes hold data that can't be recovered. I can't list them before it runs." };
    }
    if (a === "compose" || base === "docker-compose") {
      const sub = a === "compose" ? b : a;
      if (sub === "down" && flags.some((f) => f === "-v" || f === "--volumes")) {
        return { kind: "opaque", label: `${base} compose down -v`, note: "Also deletes the named volumes, and the data in them." };
      }
    }
    return null;
  }
  if (base === "docker-compose" && plain[0] === "down" && args.some((f) => f === "-v" || f === "--volumes")) {
    return { kind: "opaque", label: "docker-compose down -v", note: "Also deletes the named volumes, and the data in them." };
  }
  if (base === "kubectl" || base === "oc") {
    // The subcommand is the first word that isn't a global flag or that flag's value.
    let sub;
    for (let i = 0; i < args.length; i += 1) {
      if (/^(-n|-s|--namespace|--context|--kubeconfig|--cluster|--user|--server)$/.test(args[i])) {
        i += 1;
      } else if (!args[i].startsWith("-")) {
        sub = i;
        break;
      }
    }
    if (sub !== undefined && args[sub] === "delete") {
      return { kind: "kubectl-delete", label: `${base} delete`, bin: base, args: args.filter((a) => !a.startsWith("--dry-run")), dir };
    }
    return null;
  }
  if (base === "terraform" || base === "tofu") {
    const sub = plain[0];
    if (sub === "destroy" || (sub === "apply" && args.some((a) => a === "-destroy"))) {
      return { kind: "terraform-destroy", label: `${base} destroy`, bin: base, dir };
    }
    return null;
  }
  if (SQL_CLIENTS.has(base) && DESTRUCTIVE_SQL.test(args.join(" "))) {
    return { kind: "opaque", label: `${base}: destructive statement`, note: "The statement drops, truncates or deletes without a WHERE. I can't tell how many rows or objects it affects." };
  }
  if ((base === "chmod" || base === "chown" || base === "chgrp") && args.some((a) => a === "--recursive" || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(a))) {
    const rest = args.filter((a) => !a.startsWith("-"));
    return { kind: "rm", verb: `${base} -R`, label: `${base} -R`, mode: rest[0], targets: rest.slice(1), dir };
  }
  return null;
}

// Resolves a `cd` target to an absolute folder, or null if it doesn't exist.
// The target is passed as an argument, never as source.
const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && pwd -P`;

async function resolveDir($, sessionCwd, dir) {
  if (dir === "-") {
    return null; // `cd -` depends on the shell's history
  }
  const run = await $.process.run(["bash", "-c", CD_SCRIPT, "blast-shield", dir], { cwd: sessionCwd, timeoutMs: 5000 });
  const out = run.stdout.trim();
  return run.exitCode === 0 && out !== "" ? out : null;
}

/** Splits one segment into words, honouring quotes. Good enough to read flags and paths. */
function tokenize(text) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3]);
  }
  return words;
}

// ---- Measuring the blast radius -------------------------------------------

/** { summary, lines, note } for the pane. Never throws: a failed read is said, not hidden. */
export async function measure($, risk, cwd) {
  const report = await measureCore($, risk, cwd);
  try {
    const impact = await consequences($, risk, cwd, report);
    if (impact.length > 0) {
      report.impact = impact;
    }
  } catch {
    // consequences are extra context; a failed probe must never hide the report
  }
  return report;
}

async function measureCore($, risk, cwd) {
  try {
    if (risk.kind === "rm") {
      return await measureRm($, risk, cwd);
    }
    if (risk.kind === "migrate") {
      return await measureMigrations($, risk, cwd);
    }
    if (risk.kind === "kubectl-delete") {
      return await measureKubectl($, risk, cwd);
    }
    if (risk.kind === "terraform-destroy") {
      return await measureTerraform($, risk, cwd);
    }
    if (risk.kind === "opaque") {
      return { summary: risk.label, lines: [], note: risk.note };
    }
    if (risk.kind === "find-delete") {
      return await measureFindDelete($, risk, cwd);
    }
    if (risk.kind === "git-branch-delete") {
      return await measureBranchDelete($, risk, cwd);
    }
    if (risk.kind === "git-stash") {
      return await measureStash($, risk, cwd);
    }
    return await measureGit($, risk, cwd);
  } catch (error) {
    return { summary: `${risk.label} (could not measure it)`, lines: [], note: `Could not measure: ${String(error?.message ?? error).slice(0, 200)}` };
  }
}

// ---- Consequences beyond the command ----------------------------------------
// What else this touches: git recoverability, CI, pull requests, databases, clusters,
// secrets. Every line comes from something read here (a file name, a probe's output),
// never a guess about your project. Probes are read-only and time-limited.

const IMPACT_MAX = 5;
const PROD = /\b(prod|production|prd|live)\b/i;
const BUILD_DIRS = /(^|\/)(node_modules|dist|build|out|target|\.next|\.nuxt|__pycache__|\.cache|coverage|\.turbo|\.venv|venv)\/?$/;
const SHARED_BRANCH = /^(main|master|develop|development|trunk|release.*|prod|production|staging)$/;
const DATA_STORE = /(aws_db_|aws_rds|aws_dynamodb|aws_s3_bucket|aws_elasticache|aws_ebs|aws_efs|google_sql|google_storage_bucket|google_bigquery|google_spanner|azurerm_(sql|mssql|storage|cosmosdb|postgresql|mysql)|kubernetes_persistent|_database\b|_bucket\b|_volume\b|_disk\b)/i;
const DESTRUCTIVE_NAME = /(drop|remove|delete|destroy|truncate|purge)/i;
const BROAD_TARGET = /^(\/|~|\.|\.\.|\*|\/\*)$/;

// What a path name says about what else breaks. First hit per rule.
const PATH_FACTS = [
  [/(^|[\/\s])\.env(\.|$|\s)/, "Includes an environment file (.env): secrets in it may exist nowhere else."],
  [/(^|[\/\s])\.git(\/|$)/, "Includes .git: that deletes this folder's repository history."],
  [/\.(sqlite3?|db)(\s|$)/i, "Includes a local database file: its data is not in git unless it was committed."],
  [/(^|[\/\s])\.ssh(\/|$)|id_(rsa|ed25519)|\.pem(\s|$)/, "Includes SSH keys or certificates: deleting or loosening them can lock you out of servers."],
  [/(^|[\/\s])\.(aws|kube|config)(\/|$)/, "Includes credentials or config for cloud tooling."],
  [/(^|[\/\s])(migrations?|schema)(\/|\.|$)/i, "Touches database migration or schema files: environments that already applied them will drift."],
  [/(^|[\/\s])\.github\/workflows(\/|$)/, "Touches CI workflows: pipelines will stop or change on the next push."],
  [/(^|[\/\s])(public|static|assets)\//, "Touches files served to users: pages or images may break."],
  [/(^|[\/\s])(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum)(\s|$)/, "Touches dependency manifests or lockfiles: builds and CI may resolve different versions."],
];

async function consequences($, risk, cwd, report) {
  const out = [];
  const add = (text) => {
    if (text && out.length < IMPACT_MAX && !out.includes(text)) {
      out.push(text);
    }
  };
  const run = (argv, ms = 8000) => runOrFail($, argv, cwd, ms);
  const lines = report.lines ?? [];

  const prod = (risk.segment ?? "").match(PROD);
  if (prod) {
    add(`The command line mentions "${prod[0]}": this may be a live system.`);
  }

  if (risk.kind === "rm" && !risk.verb) {
    const tracked = await run(["git", "ls-files", "--", ...risk.targets]);
    if (tracked.exitCode !== 0) {
      add("Not inside a git repo here, or outside it, so git can't restore these.");
    } else if (report.files > 0) {
      const modified = await run(["git", "ls-files", "-m", "--", ...risk.targets]);
      const count = (r) => r.stdout.split("\n").filter((l) => l !== "").length;
      const back = Math.max(0, count(tracked) - count(modified));
      const gone = Math.max(0, report.files - back);
      add(`${back} of ${report.files} files are tracked and unmodified, so git can restore them. ${gone} can't be restored from git.`);
    }
    if (risk.targets.length > 0 && risk.targets.every((t) => BUILD_DIRS.test(t))) {
      add("Looks like regenerable build output or dependencies: rebuilding or reinstalling should recreate it.");
    }
  }

  if (risk.kind === "rm" || risk.kind === "find-delete" || risk.kind.startsWith("git-")) {
    const names = [...(risk.targets ?? []), ...lines];
    for (const [pattern, text] of PATH_FACTS) {
      if (names.some((n) => pattern.test(n))) {
        add(text);
      }
    }
  }

  if (risk.verb) {
    if ((risk.targets ?? []).some((t) => BROAD_TARGET.test(t))) {
      add("A recursive change on a broad folder can lock you out (SSH keys need strict modes) or strip executable bits.");
    }
    if (/^(0?777|0?666|a\+[rwx]*w|o\+[rwx]*w)/.test(risk.mode ?? "")) {
      add("That mode makes files writable by every local user.");
    }
    if (risk.verb.startsWith("chown") || risk.verb.startsWith("chgrp")) {
      add("Services that run as the old owner may lose access to these files.");
    }
  }

  if (risk.kind === "git-push-force") {
    const flows = await run(["bash", "-c", "ls .github/workflows 2>/dev/null | wc -l"], 5000);
    const n = Number(flows.stdout.trim()) || 0;
    if (n > 0) {
      add(`${n} CI workflow ${n === 1 ? "file" : "files"} in .github/workflows: a push re-runs the ones that trigger on push.`);
    }
    if (risk.branch) {
      if (SHARED_BRANCH.test(risk.branch)) {
        add(`"${risk.branch}" looks like a shared branch: anyone who pulled it will have diverged history.`);
      }
      const pr = await run(["gh", "pr", "list", "--head", risk.branch, "--json", "number,title", "--limit", "3"]);
      if (pr.exitCode === 0) {
        let prs = [];
        try {
          prs = JSON.parse(pr.stdout || "[]");
        } catch {
          prs = [];
        }
        for (const p of prs) {
          add(`Open pull request #${p.number} "${String(p.title).slice(0, 50)}" is on this branch: a force-push rewrites it and can stale reviews and approvals.`);
        }
      }
    }
  }

  if (risk.kind === "migrate") {
    const bad = lines.filter((l) => DESTRUCTIVE_NAME.test(l));
    if (bad.length > 0) {
      add(`${bad.length} pending ${bad.length === 1 ? "migration has a" : "migrations have"} destructive-looking ${bad.length === 1 ? "name" : "names"} (drop, remove, delete): ${bad[0].trim().slice(0, 60)}. Read ${bad.length === 1 ? "it" : "them"} for data loss.`);
    }
    add("Migrations run on the database your environment points to (settings, DATABASE_URL), which may not be your local one.");
  }

  if (risk.kind === "kubectl-delete") {
    const ctx = await run([risk.bin, "config", "current-context"], 5000);
    if (ctx.exitCode === 0 && ctx.stdout.trim() !== "") {
      const name = ctx.stdout.trim();
      add(`Cluster context: ${name}${PROD.test(name) ? " (looks like production)" : ""}.`);
    }
    const kinds = lines.map((l) => l.split(/[\s/.]/)[0].toLowerCase());
    if (kinds.some((k) => k === "namespace" || k === "ns")) {
      add("Deleting a namespace deletes everything inside it.");
    }
    if (kinds.some((k) => /^(persistentvolumeclaim|pvc|persistentvolume|pv|statefulset)/.test(k))) {
      add("Persistent storage is involved: data may be deleted with it, depending on the reclaim policy.");
    }
    if (kinds.some((k) => /^(deployment|daemonset|service|ingress|statefulset)/.test(k))) {
      add("Running workloads or routes stop: traffic to them fails until they are recreated.");
    }
  }

  if (risk.kind === "terraform-destroy") {
    const ws = await run([risk.bin, "workspace", "show"], 8000);
    if (ws.exitCode === 0 && ws.stdout.trim() !== "") {
      const name = ws.stdout.trim();
      add(`Workspace: ${name}${PROD.test(name) ? " (looks like production)" : ""}.`);
    }
    const stores = lines.filter((l) => DATA_STORE.test(l));
    if (stores.length > 0) {
      add(`Includes data stores (${stores.slice(0, 3).join(", ")}): destroying them deletes their data unless it is backed up.`);
    }
  }

  if (risk.docker) {
    const { bin, a, b, names } = risk.docker;
    if (a === "system" && b === "prune") {
      const df = await run([bin, "system", "df"], 10000);
      if (df.exitCode === 0) {
        add(`Current usage: ${df.stdout.trim().split("\n").slice(1, 5).map((l) => l.trim().replace(/\s{2,}/g, " ")).join("; ")}`);
      }
    }
    if (a === "volume" && b === "prune") {
      const vols = await run([bin, "volume", "ls", "-f", "dangling=true", "-q"], 8000);
      const list = vols.stdout.split("\n").filter((l) => l !== "");
      if (vols.exitCode === 0) {
        add(list.length === 0 ? "No unused volumes right now." : `${list.length} unused ${list.length === 1 ? "volume" : "volumes"} would be deleted: ${list.slice(0, 5).join(", ")}.`);
      }
    }
    if (a === "volume" && (b === "rm" || b === "remove")) {
      for (const name of names.slice(0, 3)) {
        const users = await run([bin, "ps", "-a", "--filter", `volume=${name}`, "--format", "{{.Names}}"], 8000);
        const list = users.stdout.split("\n").filter((l) => l !== "");
        if (users.exitCode === 0 && list.length > 0) {
          add(`Volume ${name} is used by: ${list.slice(0, 4).join(", ")}.`);
        }
      }
    }
  }

  if (risk.kind === "opaque" && /: destructive statement$/.test(risk.label)) {
    if (/\bcascade\b/i.test(risk.segment ?? "")) {
      add("CASCADE also drops dependent objects, such as views and foreign-key tables.");
    }
    add("Anything reading this data (the app, jobs, reports) sees it gone at once; recovery needs a backup or point-in-time restore.");
  }

  if (risk.kind === "find-delete" || risk.kind === "opaque" && risk.label === "xargs rm") {
    add("Deleted files skip the trash, and a different match later can delete different files.");
  }
  return out;
}

// The paths are passed to bash as arguments, never as source, so nothing in
// them runs. compgen -G expands a glob without command substitution.
const RM_SCRIPT = `
shopt -s nullglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
# A relative path gets ./ in front, so find never reads a name like -delete as an action.
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}
`;

async function measureRm($, risk, cwd) {
  const verb = risk.verb ? `${risk.verb} would touch` : "delete";
  if (risk.targets.length === 0) {
    return { summary: "rm with no paths", lines: [], note: "No paths to expand." };
  }
  const run = await $.process.run(["bash", "-c", RM_SCRIPT, "blast-shield", ...risk.targets], { cwd, timeoutMs: 15000 });
  const [head, ...rest] = run.stdout.split("\n").filter((l) => l !== "");
  const [files, bytes, found] = (head ?? "0 0 0").split(" ").map(Number);
  if (!found) {
    return { summary: `${verb} nothing: no file matches ${risk.targets.join(" ")}`, lines: [], note: "The paths don't exist, so there is nothing to change." };
  }
  if (!files) {
    return { summary: `${verb} ${found} ${found === 1 ? "path" : "paths"} with no files in ${found === 1 ? "it" : "them"}`, lines: [], note: `Paths: ${risk.targets.join(" ")}` };
  }
  return {
    files,
    summary: `${verb} ${files} ${files === 1 ? "file" : "files"} (about ${size(bytes)})`,
    lines: rest.map((l) => l.replace(/^\.\//, "")),
    more: Math.max(0, files - rest.length),
    note: `Paths: ${risk.targets.join(" ")}`,
  };
}

async function measureGit($, risk, cwd) {
  if (risk.kind === "git-push-force") {
    return await measurePush($, risk, cwd);
  }
  if (risk.kind === "git-clean") {
    const flags = [];
    const paths = [];
    for (let i = 0; i < risk.args.length; i += 1) {
      const a = risk.args[i];
      if (a === "--") {
        paths.push(...risk.args.slice(i + 1));
        break;
      }
      if (a === "-e" || a === "--exclude") {
        flags.push(a, risk.args[i + 1] ?? "");
        i += 1;
      } else if (a.startsWith("--exclude=") || /^-e./.test(a)) {
        flags.push(a);
      } else if (/^-[a-zA-Z]+$/.test(a)) {
        const kept = a.replace(/[finq]/g, ""); // -n is added below; -f, -i and -q would change the dry run
        if (kept !== "-") {
          flags.push(kept);
        }
      } else if (!a.startsWith("-")) {
        paths.push(a);
      }
    }
    const run = await $.process.run(["git", "clean", "-n", ...flags, "--", ...paths], { cwd, timeoutMs: 15000 });
    if (run.exitCode !== 0) {
      return { summary: "git clean (could not dry-run it)", lines: [], note: run.stderr.trim().slice(0, 200) };
    }
    const gone = run.stdout.split("\n").filter((l) => l.startsWith("Would remove ")).map((l) => l.slice(13));
    return {
      summary: gone.length === 0 ? "remove nothing: no untracked files match" : `remove ${gone.length} untracked ${gone.length === 1 ? "path" : "paths"}`,
      lines: gone.slice(0, LIST_MAX),
      more: Math.max(0, gone.length - LIST_MAX),
      note: "From git clean -n. Untracked files are not in git, so they can't be recovered.",
    };
  }
  const status = await $.process.run(["git", "status", "--porcelain"], { cwd, timeoutMs: 15000 });
  if (status.exitCode !== 0) {
    return { summary: `${risk.label} (not a git repo here?)`, lines: [], note: status.stderr.trim().slice(0, 200) };
  }
  const rows = status.stdout.split("\n").filter((l) => l.length > 3 && !l.startsWith("??"));
  // reset --hard drops staged and unstaged changes; checkout -- . drops unstaged ones.
  const inPaths = (l) => risk.paths === undefined || risk.paths.includes(".") || risk.paths.some((p) => {
    const f = l.slice(3);
    const q = p.replace(/\/+$/, "");
    return f === q || f.startsWith(`${q}/`);
  });
  const lost = risk.kind === "git-reset" ? rows : rows.filter((l) => l[1] !== " " && inPaths(l));
  const stat = await $.process.run(["git", "diff", "--shortstat", risk.kind === "git-reset" ? "HEAD" : "--"], { cwd, timeoutMs: 15000 });
  return {
    summary: lost.length === 0 ? "discard nothing: no uncommitted changes" : `discard uncommitted changes in ${lost.length} ${lost.length === 1 ? "file" : "files"}`,
    lines: lost.slice(0, LIST_MAX).map((l) => `${l.slice(0, 2)} ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note: stat.stdout.trim() !== "" ? `${stat.stdout.trim()}. Uncommitted changes can't be recovered.` : "From git status --porcelain.",
  };
}

// Argument vectors only: nothing the model wrote is ever read as shell. A missing or
// failing tool is reported in the pane; the command is still held.
async function runOrFail($, argv, cwd, timeoutMs) {
  try {
    return await $.process.run(argv, { cwd, timeoutMs });
  } catch (error) {
    return { exitCode: -1, stdout: "", stderr: String(error?.message ?? error) };
  }
}

async function measureKubectl($, risk, cwd) {
  const run = await runOrFail($, [risk.bin, ...risk.args, "--dry-run=client"], cwd, 20000);
  if (run.exitCode !== 0) {
    return { summary: `${risk.label} (could not dry-run it)`, lines: [], note: `${risk.bin} --dry-run=client failed: ${run.stderr.trim().slice(0, 160)}` };
  }
  const gone = run.stdout.split("\n").filter((l) => /\(dry run\)/.test(l)).map((l) => l.replace(/\s*\((?:client )?dry run\)\s*$/, ""));
  return {
    summary: gone.length === 0 ? "delete nothing: no resource matches" : `delete ${gone.length} ${gone.length === 1 ? "resource" : "resources"}`,
    lines: gone.slice(0, LIST_MAX),
    more: Math.max(0, gone.length - LIST_MAX),
    note: `From ${risk.bin} delete --dry-run=client, against your current context.`,
  };
}

async function measureTerraform($, risk, cwd) {
  const run = await runOrFail($, [risk.bin, "plan", "-destroy", "-no-color", "-input=false", "-lock=false"], cwd, 60000);
  if (run.exitCode !== 0) {
    return { summary: `${risk.label} (could not plan it)`, lines: [], note: `${risk.bin} plan -destroy failed: ${(run.stderr || run.stdout).trim().slice(-160)}` };
  }
  const gone = run.stdout.split("\n").filter((l) => /^\s*# .* will be destroyed/.test(l)).map((l) => l.replace(/^\s*# /, "").replace(/ will be destroyed.*$/, ""));
  const plan = run.stdout.split("\n").find((l) => /^(?:Plan:|No changes)/.test(l));
  return {
    summary: gone.length === 0 ? "destroy nothing: the plan has no resources to destroy" : `destroy ${gone.length} ${gone.length === 1 ? "resource" : "resources"}`,
    lines: gone.slice(0, LIST_MAX),
    more: Math.max(0, gone.length - LIST_MAX),
    note: `From ${risk.bin} plan -destroy.${plan ? ` ${plan}` : ""}`,
  };
}

async function measureFindDelete($, risk, cwd) {
  // The same find with the delete action swapped for -print: what it would remove.
  const argv = ["find", ...risk.args.filter((a) => a !== "-" + "delete"), "-print"];
  const run = await $.process.run(argv, { cwd, timeoutMs: 15000 });
  const found = run.stdout.split("\n").filter((l) => l !== "");
  return {
    summary: found.length === 0 ? "delete nothing: find matches nothing" : `delete ${found.length} ${found.length === 1 ? "path" : "paths"}`,
    lines: found.slice(0, LIST_MAX),
    more: Math.max(0, found.length - LIST_MAX),
    note: `From the same find, printing instead of deleting.${run.exitCode !== 0 ? " find reported an error, so the list may be incomplete." : ""}`,
  };
}

async function measureBranchDelete($, risk, cwd) {
  const names = risk.args.filter((a) => !a.startsWith("-"));
  const lines = [];
  for (const name of names.slice(0, LIST_MAX)) {
    const log = await $.process.run(["git", "log", "--oneline", "--no-decorate", "-n", "1", name, "--not", "--remotes", "--"], { cwd, timeoutMs: 10000 });
    lines.push(log.stdout.trim() !== "" ? `${name}: unpushed commits, tip ${log.stdout.trim()}` : `${name}: all commits exist on a remote branch`);
  }
  return { summary: `force-delete ${names.length} ${names.length === 1 ? "branch" : "branches"}`, lines, more: Math.max(0, names.length - LIST_MAX), note: "Unpushed commits are only reachable through the reflog after this." };
}

async function measureStash($, risk, cwd) {
  const list = await $.process.run(["git", "stash", "list"], { cwd, timeoutMs: 10000 });
  const all = list.stdout.split("\n").filter((l) => l !== "");
  const clear = risk.args[0] === "clear";
  const lines = clear ? all : all.slice(0, 1);
  return {
    summary: clear ? `drop ${all.length} ${all.length === 1 ? "stash" : "stashes"}` : "drop the latest stash (or the one named)",
    lines: lines.slice(0, LIST_MAX),
    more: Math.max(0, lines.length - LIST_MAX),
    note: "Dropped stashes can only be recovered with git fsck.",
  };
}

async function measurePush($, risk, cwd) {
  const positional = risk.args.filter((a) => !a.startsWith("-"));
  const remote = positional[0] ?? "origin";
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positional[1] ?? "").replace(/^\+/, "");
  let [source, branch] = spec.includes(":") ? spec.split(":") : [spec, spec];
  branch = (branch ?? "").replace(/^refs\/heads\//, "");
  if (!branch) {
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  } else if (branch === "HEAD") {
    // `git push origin HEAD` pushes the current branch to its namesake.
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  }
  source = source || "HEAD";
  risk.branch = branch;
  const ref = `${remote}/${branch}`;
  const known = await $.process.run(["git", "rev-parse", "--verify", "--quiet", ref], { cwd, timeoutMs: 10000 });
  if (known.exitCode !== 0) {
    return { summary: `force-push to ${ref}`, lines: [], note: `No local copy of ${ref}, so I can't tell which commits the push would drop. Run git fetch first.` };
  }
  const log = await $.process.run(["git", "log", "--oneline", "--no-decorate", `${source}..${ref}`], { cwd, timeoutMs: 15000 });
  const dropped = log.stdout.split("\n").filter((l) => l !== "");
  return {
    summary: dropped.length === 0 ? `force-push to ${ref}: drops no commits` : `force-push to ${ref}: drops ${dropped.length} ${dropped.length === 1 ? "commit" : "commits"}`,
    lines: dropped.slice(0, LIST_MAX),
    more: Math.max(0, dropped.length - LIST_MAX),
    note: `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
  };
}

const MIGRATION_LISTERS = {
  django: { argv: ["python3", "manage.py", "showmigrations", "--plan"], pending: (l) => l.startsWith("[ ]"), strip: (l) => l.slice(4) },
  alembic: { argv: ["alembic", "history", "-r", "current:head"], pending: (l) => l.includes("->"), strip: (l) => l },
  rails: { argv: ["bin/rails", "db:migrate:status"], pending: (l) => /^\s*down\b/.test(l), strip: (l) => l.trim() },
  prisma: { argv: ["npx", "--no-install", "prisma", "migrate", "status"], pending: (l) => /^\s{2}\S/.test(l), strip: (l) => l.trim() },
};

async function measureMigrations($, risk, cwd) {
  const lister = MIGRATION_LISTERS[risk.tool];
  if (lister === undefined) {
    return { summary: "run migrations", lines: [], note: "I can't list the pending migrations for this tool, so the list is not shown." };
  }
  let run;
  try {
    run = await $.process.run(lister.argv, { cwd, timeoutMs: 20000 });
  } catch (error) {
    run = { exitCode: -1, stdout: "", stderr: String(error?.message ?? error) };
  }
  if (run.exitCode !== 0) {
    return { summary: `run ${risk.label}`, lines: [], note: `Couldn't list pending migrations (${lister.argv.join(" ")} failed).` };
  }
  const pending = run.stdout.split("\n").filter(lister.pending).map(lister.strip);
  return {
    summary: pending.length === 0 ? `run ${risk.label}: nothing pending` : `apply ${pending.length} pending ${pending.length === 1 ? "migration" : "migrations"}`,
    lines: pending.slice(0, LIST_MAX),
    more: Math.max(0, pending.length - LIST_MAX),
    note: `From ${lister.argv.join(" ")}.`,
  };
}

function size(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = -1;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---- Drawing --------------------------------------------------------------

function paneRows(report) {
  return Math.min(31, 15 + (report.impact?.length ?? 0) + report.lines.length + (report.more ? 1 : 0));
}

// Whether the user can take it back, in plain words, by kind of risk.
const UNDO = {
  rm: "No undo. rm skips the trash.",
  "find-delete": "No undo. Deleted files skip the trash.",
  "git-reset": "Uncommitted changes can't be recovered. Committed work stays in the reflog.",
  "git-checkout": "Uncommitted changes to those files can't be recovered.",
  "git-clean": "No undo. Untracked files are not in git.",
  "git-push-force": "Dropped commits survive only in clones that have them.",
  "git-branch-delete": "Recoverable from the reflog for a while, if you know the commit.",
  "git-stash": "Hard to recover: only through git fsck.",
  migrate: "May need a down-migration, or a database backup, to reverse.",
  "kubectl-delete": "Back only if you still have the manifests. Data in volumes may be gone.",
  "terraform-destroy": "Destroys real infrastructure. State and data may not come back.",
  opaque: "Assume no undo unless you have a backup.",
};

// Why this command was held, and whether only part of it was looked at.
function whyHeld(state) {
  const { risk, command } = state;
  const part = risk.segment ?? command;
  const partial = part.trim() !== command.trim();
  const shown = part.length > 80 ? `${part.slice(0, 80)}...` : part;
  return partial
    ? `Matched "${shown}" (${risk.label}). Only that part was measured; Proceed runs the whole line.`
    : `Matched the rule for ${risk.label}.`;
}

function undoLine(risk) {
  if (risk.verb) {
    return "Old modes and owners aren't recorded, so there is no automatic undo.";
  }
  return UNDO[risk.kind] ?? null;
}

function draw(t, state) {
  const { Box, Text, Button } = t;
  const { report } = state;
  const list = report.lines.map((line, i) => Text({ key: `l${i}`, children: `  ${line}`, wrap: "truncate-end" }));
  if (report.more) {
    list.push(Text({ key: "more", dimColor: true, children: `  + ${report.more} more` }));
  }
  // The buttons answer the call this pane was drawn for, never whichever one is held now.
  const decide = (choice) => () => {
    if (state.decision === null) {
      state.decision = choice;
    }
  };
  return Box({
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "yellow",
    paddingX: 1,
    children: [
      Text({ key: "title", bold: true, color: "yellow", children: `⚠ Blast Shield · ${state.risk.label}` }),
      Text({ key: "cmd", children: [Text({ dimColor: true, children: "Command  " }), Text({ bold: true, children: state.command.length > 300 ? `${state.command.slice(0, 300)}... (${state.command.length} characters)` : state.command })], wrap: "wrap" }),
      Text({ key: "sum", children: [Text({ dimColor: true, children: "Would    " }), Text({ color: "red", bold: true, children: report.summary })], wrap: "wrap" }),
      Text({ key: "why", children: [Text({ dimColor: true, children: "Held     " }), Text({ children: whyHeld(state) })], wrap: "wrap" }),
      report.impact && report.impact.length > 0
        ? Box({
            key: "impact",
            flexDirection: "column",
            children: [
              Text({ key: "ih", dimColor: true, children: "Impact" }),
              ...report.impact.map((line, i) => Text({ key: `i${i}`, children: `  · ${line}`, wrap: "wrap" })),
            ],
          })
        : null,
      undoLine(state.risk) ? Text({ key: "undo", children: [Text({ dimColor: true, children: "Undo     " }), Text({ children: undoLine(state.risk) })], wrap: "wrap" }) : null,
      Box({ key: "list", flexDirection: "column", marginTop: 1, children: list }),
      report.note ? Text({ key: "note", dimColor: true, italic: true, children: report.note, wrap: "wrap" }) : null,
      Box({
        key: "buttons",
        marginTop: 1,
        gap: 2,
        children: [
          Button({ key: "proceed", label: "Proceed", hotkey: "1", plain: true, onPress: decide("proceed") }),
          Button({ key: "cancel", label: "Cancel", hotkey: "2", plain: true, autoFocus: true, onPress: decide("cancel") }),
          Text({ key: "hint", dimColor: true, children: "1 runs it as written, 2 refuses it. Claude is waiting." }),
        ],
      }),
    ],
  });
}
