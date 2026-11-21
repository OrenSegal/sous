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
// tool.call (mcp__*): a tool named like a payment is held the same way, unless
// an optional daily allowance covers it. Every spend leaves a receipt line.
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

export function register(on, options = {}) {
  configureSpend(options);

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    if (writesReceipts(String(e.command ?? ""))) {
      return { deny: RECEIPTS_DENY };
    }
    const risk = classify(String(e.command ?? ""));
    if (risk === null) {
      return next(e);
    }
    const mine = { command: String(e.command), risk, report: null, decision: null, where: "pane" };
    let summary = risk.label;
    const decision = await holdForAnswer($, next, mine, async () => {
      if (risk.kind === "spend") {
        mine.report = { summary: `run ${risk.label}`, lines: [], note: "Blast Shield doesn't read amounts from shell commands, so Stripe CLI payments are always held, with or without a daily allowance. It does not reverse payments." };
        return;
      }
      // Measure where the command will run: the session folder, moved by any
      // `cd dir &&` or `git -C dir` earlier in the same command line.
      const sessionCwd = await $.session.cwd();
      const cwd = risk.dir ? await resolveDir($, sessionCwd, risk.dir) : sessionCwd;
      mine.report = cwd === null
        ? { summary: `${risk.label} in ${risk.dir}`, lines: [], note: `Couldn't find the folder ${risk.dir}, so I couldn't measure what this would change.` }
        : await measure($, risk, cwd);
      summary = mine.report.summary;
    });
    scoreboard($, decision, summary, risk.kind === "spend");

    if (risk.kind === "spend") {
      // The label is the CLI's resource and verb only: never the raw line, which can carry an API key.
      return settleHeldSpend($, e, next, decision, { tool: `Bash: ${risk.label}`, amount: null, currency: null, payee: null }, summary);
    }
    if (decision === "proceed") {
      $.ui.toast("Blast Shield: running it");
      return next(e);
    }
    return {
      deny: `Blast Shield held this command and did not run it: ${WHY[decision] ?? "no answer was recorded"}. It would have: ${summary}. It matched the rule for ${risk.label}.${impactForClaude(mine)} Do not retry it unless the user asks you to.`,
    };
   }).catch(($, e, next) => next.called
    ? next(e)
    : { deny: "Blast Shield held this command and did not run it: it hit an error while checking it. Do not retry it unless the user asks you to." });

  // MCP tools whose names look like payments. Every other tool passes straight through.
  on("tool.call", async ($, e, next) => {
    if (FILE_TOOLS.has(e.tool) && touchesReceipts(String(e.file_path ?? e.notebook_path ?? ""))) {
      return { deny: RECEIPTS_DENY };
    }
    const pattern = spendPatternOf(String(e.tool ?? ""));
    if (pattern === null) {
      return next(e);
    }
    return spendCall($, e, next, pattern);
  }).catch(($, e, next) => next.called
    ? next(e)
    : { deny: "Blast Shield held this payment and did not run it: it hit an error while checking it. Do not retry it unless the user asks you to." });

  // Only the tool_use_id is kept, and only until the call settles.
  on("classic.PostToolUse", ($, e, next) => {
    if (spendPatternOf(String(e.tool_name ?? "")) !== null) {
      ranCalls.add(e.tool_use_id);
    }
    return next(e);
  });
  on("classic.PostToolUseFailure", ($, e, next) => {
    if (spendPatternOf(String(e.tool_name ?? "")) !== null) {
      ranCalls.add(e.tool_use_id);
    }
    return next(e);
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

const WHY = {
  cancel: "the user pressed Cancel",
  timeout: "no answer within 10 minutes",
  interrupted: "the turn was interrupted",
  error: "Blast Shield hit an error while holding it",
};

/**
 * Holds `mine` until Proceed, Cancel, a timeout or an interrupt, and returns that decision.
 * `prepare` fills `mine.report` once this call owns the hold.
 */
async function holdForAnswer($, next, mine, prepare) {
  // One hold at a time. If another call is already held (a subagent's, say),
  // wait until it is answered. `held` is claimed with no await between the
  // check and the claim, so two waiting calls can't both get through.
  while (held !== null) {
    if (next.signal.aborted) {
      return "interrupted";
    }
    await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
  }
  held = mine;
  let opened = { isPlaced: false };
  try {
    await prepare();
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
    mine.decision = "error"; // anything unexpected refuses the call
  } finally {
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
  return mine.decision;
}

function scoreboard($, decision, summary, isSpend) {
  tally.held += 1;
  if (decision === "proceed") {
    tally.ran += 1;
  } else {
    tally.refused += 1;
  }
  try {
    $.ui.status(`${tally.held} held · ${tally.refused} refused · ${tally.ran} ran`);
    if (decision === "cancel") {
      $.ui.toast(isSpend ? `Blast Shield stopped a payment: ${summary}` : `Blast Shield spared you: ${summary}`);
    }
  } catch {
    // the scoreboard is cosmetic; never let it change the answer
  }
}

// ---- Spend: payments an agent makes -----------------------------------------
// MCP tools named like payments, and Stripe CLI payment commands, are held for
// Proceed or Cancel. An optional daily allowance lets small, readable payments
// through. Each decision is appended to a per-project receipts file.
//
// The allowance is reserve, then commit or release: a payment that may go
// through is written to the receipts as "allowed" (or "approved" after Proceed)
// before it runs, so it counts toward today's total while it is in flight. When
// the tool answers, a "commit" line settles it, or a "release" line takes it
// back out if the call never ran (it was denied). A tool error is committed,
// not released: the payment may have gone through.

// The receipts are the allowance's ledger, so the agent may read them but not change them.
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const RECEIPTS_DENY = "Blast Shield refused this: it would change the spend receipts in ~/.claude/blast-shield/, which the daily allowance is counted from. Reading them is fine. Do not retry it unless the user asks you to.";
export const touchesReceipts = (path) => /(^|\/)\.claude\/blast-shield(\/|$)/.test(path);
// shortcut: reads the command text, so a path built from variables gets past it; a permission deny rule is the hard block.
const WRITE_WORDS = />|\b(rm|mv|cp|tee|truncate|dd|ln|unlink|shred|chmod|chown|touch|rmdir|perl|ruby|node|python[\d.]*|vi|vim|nano|ed)\b|\bsed\b[^|;&]*\s-i/;
export const writesReceipts = (command) => /\.claude\/blast-shield\b/.test(command) && WRITE_WORDS.test(command);

const DEFAULT_SPEND_PATTERNS = "charge,payment,pay,transfer,refund,invoice,checkout,payout";
// A first word that only reads, so `list_invoices` or `get_payment` is not a payment.
const READ_VERBS = new Set(["list", "get", "retrieve", "search", "read", "fetch", "find", "describe", "count", "show", "view", "lookup"]);
const STRIPE_WRITE_VERBS = new Set(["create", "pay", "confirm", "capture", "finalize", "send", "post"]);
const MINOR_KEYS = ["amount_cents", "amount_in_cents", "cents", "amount_minor"];
const PAYEE_KEYS = ["payee", "recipient", "destination", "to", "customer", "merchant", "vendor", "account"];

const spend = { patterns: [], allowance: 0, currency: "usd", minorServers: [], payees: [] };

const commaList = (text) => String(text ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Reads the plugin's userConfig into `spend`. Called by register; tests call it directly. */
export function configureSpend(options = {}) {
  spend.patterns = commaList(options.spendPatterns ?? DEFAULT_SPEND_PATTERNS);
  const daily = Number(options.dailyAllowance ?? 0);
  spend.allowance = Number.isFinite(daily) && daily > 0 ? Math.round(daily * 100) : 0;
  spend.currency = String(options.allowanceCurrency ?? "usd").trim().toLowerCase();
  spend.minorServers = commaList(options.minorUnitServers);
  spend.payees = commaList(options.payeeAllowlist);
  return spend;
}
configureSpend();

/** Lowercase words of a name: `createPaymentIntent` and `create_payment_intent` give the same three. */
function nameWords(text) {
  return String(text).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** The pattern a word matches, whole or as its plural (`charges`, `invoices`), or undefined. */
function wordPattern(word) {
  return spend.patterns.find((p) => word === p || word === `${p}s` || word === `${p}es`);
}

/** The spend pattern an MCP tool's name matches, or null. Only the tool part counts, not the server's name. */
export function spendPatternOf(tool) {
  if (!tool.startsWith("mcp__")) {
    return null;
  }
  const words = nameWords(tool.split("__").slice(2).join("_"));
  if (words.length === 0 || READ_VERBS.has(words[0])) {
    return null;
  }
  for (const word of words) {
    const hit = wordPattern(word);
    if (hit) {
      return hit;
    }
  }
  return null;
}

/**
 * `stripe <resource> <verb>` (or `stripe post /v1/...`) that moves money; null otherwise.
 * Every bare word counts, flag values included: a stray "pay" in a description over-holds,
 * which is the safe side. The label names only the matched words, never a key or other value.
 */
function classifyStripe(args, dir) {
  const plain = args.filter((a) => !a.startsWith("-"));
  // Verbs can be compound: `stripe invoices finalize_invoice`, `send_invoice`.
  const verb = plain.find((w) => nameWords(w).some((word) => STRIPE_WRITE_VERBS.has(word)));
  const resource = plain.find((w) => w !== verb && nameWords(w).some((word) => wordPattern(word)));
  if (!verb || !resource) {
    return null;
  }
  const safe = (w, fallback) => (/^[\w/.-]{1,40}$/.test(w) ? w : fallback);
  const shown = safe(resource, "payment");
  return { kind: "spend", label: verb === "post" ? `stripe post ${shown}` : `stripe ${shown} ${safe(verb, "create")}`, dir };
}

/** A positive whole number of minor units (cents), or null when the value can't be trusted. */
function toMinor(value, isMinor) {
  const n = typeof value === "number" ? value : /^\s*\d+(\.\d+)?\s*$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  if (isMinor) {
    return Number.isInteger(n) ? n : null;
  }
  const cents = Math.round(n * 100);
  return Math.abs(cents - n * 100) < 1e-6 ? cents : null; // more than two decimals: not a plain money amount
}

/**
 * { amount, currency, payee } from a tool's input. amount is in minor units, or null.
 * A key named for cents is always minor units. A bare `amount` is minor units only for a
 * server listed in minorUnitServers; otherwise major, which over-counts a cents-based API
 * rather than under-counting a dollar-based one.
 */
export function readSpend(input, tool = String(input?.tool ?? "")) {
  const bareIsMinor = spend.minorServers.includes((tool.split("__")[1] ?? "").toLowerCase());
  const scopes = [input, ...Object.values(input ?? {}).filter((v) => v && typeof v === "object" && !Array.isArray(v))];
  let amount = null;
  let currency = null;
  let payee = null;
  for (const scope of scopes) {
    if (amount === null) {
      const minorKey = MINOR_KEYS.find((k) => scope[k] !== undefined);
      if (minorKey) {
        amount = toMinor(scope[minorKey], true);
      } else if (scope.amount !== undefined) {
        amount = toMinor(scope.amount, bareIsMinor);
      }
    }
    if (currency === null && typeof scope.currency === "string" && scope.currency.trim()) {
      currency = scope.currency.trim().toLowerCase();
    }
    if (payee === null) {
      const key = PAYEE_KEYS.find((k) => typeof scope[k] === "string" || typeof scope[k] === "number");
      if (key) {
        payee = String(scope[key]).trim() || null;
      }
    }
  }
  return { amount, currency, payee };
}

export function money(minor, currency) {
  return minor === null ? "an amount I couldn't read" : `${(minor / 100).toFixed(2)} ${(currency ?? "").toUpperCase()}`.trim();
}

/** The UTC calendar day of a time in ms, as YYYY-MM-DD. UTC, so it doesn't depend on the host's time zone. */
function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Parses JSONL receipts, skipping lines that don't parse (a partial write, a hand edit). */
export function parseReceipts(text) {
  return String(text).split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

const RESERVED = new Set(["allowed", "approved"]);

/** Today's reserved total in `currency` (minus released ones), and every payee that has been paid. */
export function ledger(receipts, day, currency) {
  const released = new Set(receipts.filter((r) => r.decision === "release").map((r) => r.id));
  let spent = 0;
  const paid = new Set();
  for (const r of receipts) {
    if (!RESERVED.has(r.decision) || released.has(r.id)) {
      continue;
    }
    if (typeof r.payee === "string") {
      paid.add(r.payee.toLowerCase());
    }
    if (dayOf(Date.parse(r.ts)) === day && r.currency === currency && Number.isFinite(r.amount)) {
      spent += r.amount;
    }
  }
  return { spent, paid };
}

/**
 * Why this payment needs a person, given the receipts so far (null = they couldn't be read).
 * An empty `reasons` means the allowance covers it.
 */
export function checkSpend(call, receipts, day) {
  const reasons = [];
  if (spend.payees.length > 0 && !spend.payees.includes(String(call.payee ?? "").toLowerCase())) {
    reasons.push(call.payee ? `${call.payee} is not on the payee allowlist` : "no payee found, and a payee allowlist is set");
  }
  const { spent, paid } = receipts ? ledger(receipts, day, spend.currency) : { spent: 0, paid: new Set() };
  const firstPayee = call.payee !== null && receipts !== null && !paid.has(call.payee.toLowerCase());
  if (spend.allowance === 0) {
    reasons.push("every payment is held (no daily allowance is set)");
  } else if (receipts === null) {
    reasons.push("the receipts file couldn't be read, so today's total is unknown");
  } else if (call.amount === null) {
    reasons.push("no amount found in the call");
  } else if (call.currency !== spend.currency) {
    reasons.push(call.currency ? `the allowance is in ${spend.currency.toUpperCase()}, this is ${call.currency.toUpperCase()}` : "no currency found in the call");
  } else if (spent + call.amount > spend.allowance) {
    reasons.push(`it would bring today's total to ${money(spent + call.amount, spend.currency)}, over the daily allowance of ${money(spend.allowance, spend.currency)}`);
  }
  return { reasons, firstPayee, spent };
}

// The receipts live outside the project, so they never land in git. One file per project folder.
const RECEIPTS = `f="$HOME/.claude/blast-shield/spend/$1.jsonl"`;
const READ_RECEIPTS = `${RECEIPTS}; [ -f "$f" ] || exit 0; cat -- "$f"`;
// A lock folder shared by every session in the project: mkdir either creates it or fails, atomically.
// A lock older than a minute is from a session that died holding it, and is broken. Waits up to 10 s.
const LOCK_RECEIPTS = `${RECEIPTS}; mkdir -p "$(dirname "$f")" || exit 1; i=0
while ! mkdir "$f.lock" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -ge 100 ]; then
    [ -n "$(find "$f.lock" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rmdir "$f.lock" 2>/dev/null && i=0 && continue
    exit 1
  fi
  sleep 0.1
done`;
const UNLOCK_RECEIPTS = `${RECEIPTS}; rmdir "$f.lock" 2>/dev/null; exit 0`;
// >> opens the file in append mode, so lines from two sessions don't overwrite each other.
const APPEND_RECEIPT = `${RECEIPTS}; mkdir -p "$(dirname "$f")" && printf '%s\\n' "$2" >> "$f"`;

/** { project, session } for receipts. */
async function spendContext($) {
  const cwd = await $.session.cwd();
  let session = "";
  try {
    session = await $.session.id();
  } catch {
    // older hosts: the receipt just has no session
  }
  return { project: String(cwd).replace(/[^A-Za-z0-9]+/g, "-"), session };
}

// shortcut: reads the whole receipts file on every payment; rotate it by hand if it grows to many MB.
async function readReceipts($, ctx) {
  try {
    const run = await $.process.run(["sh", "-c", READ_RECEIPTS, "blast-shield", ctx.project], { timeoutMs: 5000 });
    // A cut-off read could drop today's lines and under-count, so it holds like a failed one.
    return run.exitCode === 0 && !run.isStdoutTruncated ? parseReceipts(run.stdout) : null;
  } catch {
    return null;
  }
}

/** Appends one receipt line. Throws if it couldn't be written. */
async function writeReceipt($, ctx, row) {
  const line = JSON.stringify({ ts: new Date(await $.clock.now()).toISOString(), session: ctx.session, ...row });
  const run = await $.process.run(["sh", "-c", APPEND_RECEIPT, "blast-shield", ctx.project, line], { timeoutMs: 5000 });
  if (run.exitCode !== 0) {
    throw new Error(`couldn't write the receipt: ${run.stderr.trim().slice(0, 200)}`);
  }
}

// Read, check and reserve run one at a time, so two payments can't both fit under the same room:
// in this session through the queue, across sessions through the lock folder.
let spendQueue = Promise.resolve();
function oneAtATime(work) {
  const run = spendQueue.then(work);
  spendQueue = run.catch(() => {});
  return run;
}

let reservations = 0;

/**
 * Checks a payment against the allowance and, if it fits, reserves it with an "allowed"
 * receipt. Returns { id, reasons, firstPayee, spent }: id is set only when it was reserved.
 */
export function reserveSpend($, ctx, call) {
  return oneAtATime(async () => {
    const now = await $.clock.now();
    const locked = await $.process.run(["sh", "-c", LOCK_RECEIPTS, "blast-shield", ctx.project], { timeoutMs: 15000 }).then((r) => r.exitCode === 0, () => false);
    try {
      const receipts = locked ? await readReceipts($, ctx) : null;
      const check = checkSpend(call, receipts, dayOf(now));
      if (!locked) {
        check.reasons = check.reasons.filter((r) => !/receipts file/.test(r)).concat("another session held the receipts lock for over 10 seconds");
      }
      if (check.reasons.length > 0) {
        return check;
      }
      const id = `${now.toString(36)}-${(reservations += 1).toString(36)}-${ctx.session.slice(0, 8)}`;
      await writeReceipt($, ctx, { id, tool: call.tool, amount: call.amount, currency: call.currency, payee: call.payee, decision: "allowed", reason: "under the daily allowance" });
      return { ...check, id };
    } finally {
      if (locked) {
        await $.process.run(["sh", "-c", UNLOCK_RECEIPTS, "blast-shield", ctx.project], { timeoutMs: 5000 }).catch(() => {});
      }
    }
  });
}

// tool_use_ids of calls the tool actually ran, from the host's PostToolUse and PostToolUseFailure
// events. A call that errors without one was refused before it ran (a permission rule, the prompt).
const ranCalls = new Set();

/** Commits or releases a reservation once the tool has answered. */
async function settleSpend($, ctx, id, call, result, toolUseId) {
  // Only MCP calls are tracked; a shell command that errors is counted as before.
  const neverRan = result?.isError && call.tool.startsWith("mcp__") && toolUseId !== undefined && !ranCalls.has(toolUseId);
  ranCalls.delete(toolUseId);
  const released = result?.deny !== undefined || neverRan;
  const reason = result?.deny !== undefined ? "the call was denied, so nothing was paid"
    : neverRan ? "refused before the tool ran, so nothing was paid"
      : result?.isError ? "the tool reported an error; counted, because the payment may have gone through"
        : "the tool answered";
  try {
    await oneAtATime(() => writeReceipt($, ctx, { id, tool: call.tool, amount: call.amount, currency: call.currency, payee: call.payee, decision: released ? "release" : "commit", reason }));
  } catch {
    // the reservation stays counted, which keeps the cap on the safe side
  }
}

/** A payment the hook decided on: run it under a reservation, or refuse it, and leave a receipt either way. */
async function settleHeldSpend($, e, next, decision, call, summary) {
  const ctx = await spendContext($);
  if (decision !== "proceed") {
    const why = WHY[decision] ?? "no answer was recorded";
    try {
      await oneAtATime(() => writeReceipt($, ctx, { tool: call.tool, amount: call.amount, currency: call.currency, payee: call.payee, decision: decision ?? "error", reason: why }));
    } catch {
      // refusing doesn't depend on the receipt
    }
    return { deny: `Blast Shield held this payment and did not run it: ${why}. It would have: ${summary}. Do not retry it unless the user asks you to.` };
  }
  const id = `${(await $.clock.now()).toString(36)}-${(reservations += 1).toString(36)}-${ctx.session.slice(0, 8)}`;
  try {
    await oneAtATime(() => writeReceipt($, ctx, { id, tool: call.tool, amount: call.amount, currency: call.currency, payee: call.payee, decision: "approved", reason: "the user pressed Proceed" }));
  } catch {
    return { deny: "Blast Shield held this payment and did not run it: the user pressed Proceed, but the receipt couldn't be written. Do not retry it unless the user asks you to." };
  }
  $.ui.toast("Blast Shield: running it");
  let result;
  try {
    result = await next(e);
    return result;
  } finally {
    await settleSpend($, ctx, id, call, result ?? { isError: true }, e.tool_use_id);
  }
}

/** An MCP tool call that matched a spend pattern. */
async function spendCall($, e, next, pattern) {
  const tool = String(e.tool);
  const call = { tool, ...readSpend(e, tool) };
  const ctx = await spendContext($);
  const check = await reserveSpend($, ctx, call);
  const what = `pay ${money(call.amount, call.currency)} to ${call.payee ?? "a payee I couldn't read"}`;

  if (check.id) {
    try {
      $.ui.toast(`Blast Shield: allowed ${money(call.amount, call.currency)} (today ${money(check.spent + call.amount, spend.currency)} of ${money(spend.allowance, spend.currency)})${check.firstPayee ? `. First payment to ${call.payee}.` : ""}`);
    } catch {
      // cosmetic
    }
    let result;
    try {
      result = await next(e);
      return result;
    } finally {
      await settleSpend($, ctx, check.id, call, result ?? { isError: true }, e.tool_use_id);
    }
  }

  const { tool: _t, tool_use_id: _id, ...args } = e;
  const impact = check.firstPayee ? [`First payment to ${call.payee} in this project, by the receipts.`] : [];
  const mine = {
    command: `${tool} ${JSON.stringify(args)}`,
    risk: { kind: "spend", label: tool },
    title: "⚠ Blast Shield held this payment",
    why: `The tool name matches the spend pattern "${pattern}".`,
    report: { summary: what, lines: [], impact, note: `Held because ${check.reasons.join("; ")}. Blast Shield does not reverse payments.` },
    decision: null,
    where: "pane",
  };
  const decision = await holdForAnswer($, next, mine, async () => {});
  scoreboard($, decision, what, true);
  return settleHeldSpend($, e, next, decision, call, what);
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

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const PYTHON = /^(?:python[\d.]*|pypy3?)$/;
// The quoted script of `sh -c '...'` or `python -c '...'`. Its ; && | belong to the script, not this line.
const INLINE_SCRIPT = /((?:^|[\s;&|(])(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|python[\d.]*|pypy3?)(?:\s+[^\s;&|'"]+)*?\s+-[a-zA-Z]*c[a-zA-Z]*\s+)('[^']*'|"(?:[^"\\]|\\.)*")/g;

/** The line's segments, with inline scripts kept whole. */
function splitLine(command) {
  const scripts = [];
  return command
    .replace(INLINE_SCRIPT, (_, head, script) => `${head}\0${scripts.push(script) - 1}\0`)
    .split(/&&|\|\||;|\||\n/)
    .map((part) => part.replace(/\0(\d+)\0/g, (_, i) => scripts[i]));
}

/** The first risky segment of a shell command, or null. */
export function classify(command) {
  let dir = null; // where a `cd` earlier on the line moved to; null means the session folder
  const scopes = []; // dir to restore when a ( subshell ) closes
  const pushed = []; // pushd stack, for popd
  for (const raw of splitLine(command)) {
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
    const base = cmd.split("/").pop();
    const scriptAt = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    const script = scriptAt >= 0 ? args[scriptAt + 1]?.replace(/\\(["\\$`])/g, "$1") : undefined;
    if (SHELLS.has(base) && script !== undefined) {
      const inner = classify(script);
      if (inner !== null) {
        return { ...inner, dir: inner.dir ? joinDir(dir, inner.dir) : dir };
      }
    }
    if (PYTHON.test(base) && script !== undefined && /\brmtree\s*\(/.test(script)) {
      const literal = script.match(/\brmtree\s*\(\s*(['"])([^'"]+)\1\s*[,)]/);
      return literal
        ? { kind: "rm", label: "python shutil.rmtree", targets: [literal[2]], dir }
        : { kind: "opaque", label: "python shutil.rmtree", note: "The path is worked out when the script runs, so I can't list what it would delete." };
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
    if (cmd === "find") {
      const exec = classifyFindExec(args, dir);
      if (exec !== null) {
        return exec;
      }
    }
    if (base === "stripe") {
      const payment = classifyStripe(args, dir);
      if (payment !== null) {
        return payment;
      }
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
      if (sub === "push") {
        const plain = rest.filter((a) => !a.startsWith("-"));
        const flagged = rest.some((a) => a === "--delete" || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a));
        const refs = plain.slice(1).filter((a) => flagged || /^:./.test(a)).map((a) => a.replace(/^:/, "").replace(/^refs\/heads\//, ""));
        if (refs.length > 0) {
          return { kind: "git-push-delete", label: "git push that deletes a remote branch", remote: plain[0], refs, dir: gitDir };
        }
      }
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

const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** find running rm, or any other risky command, per match; otherwise null. */
function classifyFindExec(args, dir) {
  const rest = []; // the find without its rm clauses: what the dry run prints
  let deletes = false;
  for (let i = 0; i < args.length; i += 1) {
    if (!FIND_EXEC.has(args[i])) {
      rest.push(args[i]);
      continue;
    }
    // The line split leaves `\` or `'` where `\;` or `';'` ended the clause.
    let end = i + 1;
    while (end < args.length && !/^(?:\\?;|\\|\+|')$/.test(args[end])) {
      end += 1;
    }
    const words = args.slice(i + 1, end);
    if (words[0]?.split("/").pop() === "rm") {
      deletes = true;
    } else {
      const inner = classify(words.map((w) => (/\s/.test(w) ? JSON.stringify(w) : w)).join(" "));
      if (inner !== null) {
        return { kind: "opaque", label: `find ${args[i]} (${inner.label})`, note: "It runs that command once per match, so I can't measure what it would change." };
      }
      rest.push(...args.slice(i, end + 1));
    }
    i = end;
  }
  return deletes ? { kind: "find-delete", label: "find -exec rm", args: rest, dir } : null;
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
    if (risk.kind === "opaque" || risk.kind === "spend") {
      return { summary: risk.label, lines: [], note: risk.note };
    }
    if (risk.kind === "find-delete") {
      return await measureFindDelete($, risk, cwd);
    }
    if (risk.kind === "git-branch-delete") {
      return await measureBranchDelete($, risk, cwd);
    }
    if (risk.kind === "git-push-delete") {
      return await measurePushDelete($, risk, cwd);
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

  if (risk.kind === "git-push-delete") {
    for (const ref of risk.refs.filter((r) => SHARED_BRANCH.test(r))) {
      add(`"${ref}" looks like a shared branch: everyone using it loses it on their next fetch.`);
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
  // The tokenizer keeps $VAR, $(...) and backticks as text; the shell would expand them.
  const unresolved = risk.targets.filter((t) => /[$`]|^~[^/]/.test(t));
  if (unresolved.length > 0) {
    return { summary: `${verb} paths I can't resolve: ${unresolved.join(" ")}`, lines: [], note: "The paths use shell variables or substitutions. An empty variable can widen the target, so I can't measure it." };
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

// git status --porcelain codes (index, worktree) in words; the worktree column wins, as it is what gets discarded.
function porcelainWord(row) {
  const code = row[1] !== " " ? row[1] : row[0];
  return { M: "modified", D: "deleted", A: "added", R: "renamed", C: "copied", U: "conflicted", T: "type changed" }[code] ?? code;
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
  // Git matches the paths itself: relative to cwd, with ./ prefixes and globs.
  const pathspec = risk.paths ?? [];
  const status = await $.process.run(["git", "status", "--porcelain", "--", ...pathspec], { cwd, timeoutMs: 15000 });
  if (status.exitCode !== 0) {
    return { summary: `${risk.label} (not a git repo here?)`, lines: [], note: status.stderr.trim().slice(0, 200) };
  }
  const rows = status.stdout.split("\n").filter((l) => l.length > 3 && !l.startsWith("??"));
  // reset --hard drops staged and unstaged changes; checkout -- paths drops unstaged ones.
  const lost = risk.kind === "git-reset" ? rows : rows.filter((l) => l[1] !== " ");
  const stat = await $.process.run(["git", "diff", "--shortstat", ...(risk.kind === "git-reset" ? ["HEAD"] : ["--", ...pathspec])], { cwd, timeoutMs: 15000 });
  return {
    summary: lost.length === 0 ? "discard nothing: no uncommitted changes" : `discard uncommitted changes in ${lost.length} ${lost.length === 1 ? "file" : "files"}`,
    lines: lost.slice(0, LIST_MAX).map((l) => `${porcelainWord(l)}  ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note: stat.stdout.trim() !== "" ? `${stat.stdout.trim()}.` : "From git status --porcelain.",
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

// find actions that run commands or write files: the dry run would perform them.
const FIND_SIDE_EFFECTS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

async function measureFindDelete($, risk, cwd) {
  if (risk.args.some((a) => FIND_SIDE_EFFECTS.has(a))) {
    return { summary: "find with its delete action", lines: [], note: "This find also runs commands or writes files, so I didn't dry-run it." };
  }
  // No shell runs this dry run, so $VAR, ~ and start-path globs would be taken literally and match nothing.
  const firstTest = risk.args.findIndex((a) => /^(?:-[a-zA-Z]{2,}|[(!\\])/.test(a));
  const unresolved = risk.args.filter((a, i) => /[$`]/.test(a) || ((firstTest < 0 || i < firstTest) && /^~|[*?[]/.test(a)));
  if (unresolved.length > 0) {
    return { summary: `delete paths I can't resolve: ${unresolved.join(" ")}`, lines: [], note: "The arguments use shell variables, substitutions, ~ or globs that the shell would expand, so I can't measure it." };
  }
  // The same find with the delete action swapped for -print: what it would remove.
  const argv = ["find", ...risk.args.filter((a) => a !== "-" + "delete"), "-print"];
  const run = await $.process.run(argv, { cwd, timeoutMs: 15000 });
  const found = run.stdout.split("\n").filter((l) => l !== "");
  if (found.length === 0 && run.exitCode !== 0) {
    return { summary: "find failed, so I could not measure what it would delete", lines: [], note: run.stderr.trim().slice(0, 200) };
  }
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

async function measurePushDelete($, risk, cwd) {
  const lines = [];
  const unknown = [];
  for (const name of risk.refs.slice(0, LIST_MAX)) {
    const ref = `${risk.remote}/${name}`;
    const known = await $.process.run(["git", "rev-parse", "--verify", "--quiet", ref], { cwd, timeoutMs: 10000 });
    if (known.exitCode !== 0) {
      unknown.push(ref);
      continue;
    }
    const log = await $.process.run(["git", "log", "--oneline", "--no-decorate", ref, "--not", "--branches", "--"], { cwd, timeoutMs: 15000 });
    lines.push(...log.stdout.split("\n").filter((l) => l !== "").map((l) => `${ref}: ${l}`));
  }
  return {
    summary: `delete ${risk.refs.map((r) => `${risk.remote}/${r}`).join(", ")} on the remote`,
    lines: lines.slice(0, LIST_MAX),
    more: Math.max(0, lines.length - LIST_MAX),
    note: unknown.length > 0 ? `No local copy of ${unknown.join(", ")}, so I can't tell which commits only it has. Run git fetch first.` : "Commits listed are on no local branch, as of the last fetch.",
  };
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
  "git-push-delete": "Back only by pushing it again from a clone that still has it.",
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
  if (state.why) {
    return state.why;
  }
  const part = risk.segment ?? command;
  const partial = part.trim() !== command.trim();
  const shown = part.length > 80 ? `${part.slice(0, 80)}...` : part;
  return partial
    ? `Only "${shown}" was measured; Proceed runs the whole line.`
    : `Matched the rule for ${risk.label}.`;
}

function undoLine(risk) {
  if (risk.verb) {
    return "Old modes and owners aren't recorded, so there is no automatic undo.";
  }
  return UNDO[risk.kind] ?? null;
}

export function draw(t, state) {
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
      Text({ key: "title", bold: true, color: "yellow", children: state.title ?? "⚠ Blast Shield held this command" }),
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
