import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { classify, measure, draw, register, configureSpend, spendPatternOf, readSpend, checkSpend, ledger, reserveSpend, parseReceipts } = await import(new URL("../hooks/blast-shield.mjs", import.meta.url).href);

const $ = { process: { run: async (argv, o = {}) => {
  const r = spawnSync(argv[0], argv.slice(1), { cwd: o.cwd, encoding: "utf8", timeout: o.timeoutMs });
  if (r.error) throw r.error;
  return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
} } };
const sh = (c, cwd) => execFileSync("bash", ["-c", c], { cwd, stdio: "pipe" });
let fails = 0;
const check = (name, ok, got) => { if (!ok) fails++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : JSON.stringify(got)); };

const d = mkdtempSync(join(tmpdir(), "br-"));
sh("git init -q && git config user.email a@b && git config user.name a && mkdir src build && echo a>src/a.js && echo b>src/b.js && echo c>build/x && echo d>build/.hidden && git add . && git commit -qm init && echo changed>src/a.js && echo changed>src/b.js && git checkout -q -b feat && echo z>z && git add z && git commit -qm z && git checkout -q -", d);

const m = async (cmd) => { const r = classify(cmd); return { r, rep: r ? await measure($, r, d) : null }; };

let x = await m("git checkout -- src/a.js");
check("checkout path only lists a.js", x.rep.lines.length === 1 && x.rep.lines[0].includes("src/a.js"), x.rep);
x = await m("git restore src");
check("restore dir lists both", x.rep.lines.length === 2, x.rep);
x = await m("git checkout .");
check("checkout . lists both", x.rep.lines.length === 2, x.rep);
x = await m("rm -rf build");
check("rm counts 1 file (no dotglob on dir, find recurses -> 2)", /delete [12] file/.test(x.rep.summary), x.rep);
x = await m("find build -name x -" + "delete");
check("find dry run lists build/x", x.rep.lines.join().includes("build/x") && x.rep.lines.length === 1, x.rep);
x = await m("git branch -D feat");
check("branch -D flags unpushed", x.rep.lines[0].includes("unpushed"), x.rep);
sh("echo q>q && git add q && git stash -q", d);
x = await m("git stash drop");
check("stash drop lists 1", x.rep.lines.length === 1, x.rep);
x = await m("git stash clear");
check("stash clear is held and lists 1", x.r?.kind === "git-stash" && x.rep.lines.length === 1, x.rep);
x = await m("chmod -R 755 src");
check("chmod -R measures 2 files", /chmod -R would touch 2 files/.test(x.rep.summary), x.rep);
x = await m("kubectl delete pod nope");
check("kubectl missing/failing is reported, not thrown", x.rep.summary.includes("could not dry-run") || x.rep.summary.includes("delete"), x.rep);
x = await m("terraform destroy");
check("terraform missing/failing is reported, not thrown", x.rep.summary.length > 0, x.rep);
x = await m("rm -rf -- '-delete'");
check("odd filename survives", x.rep.summary.length > 0, x.rep);
// review fixes: unresolved shell expansions, git pathspecs, find side effects
sh("echo again>src/a.js && echo again>src/b.js", d); // the stash above took the earlier edits
x = await m('rm -rf "$BLAST_SHIELD_UNSET/"');
check("rm with a shell variable is unresolved, not 'nothing'", /can't resolve/.test(x.rep.summary) && !/nothing/.test(x.rep.summary), x.rep);
x = await m("rm -rf `pwd`/build");
check("rm with a command substitution is unresolved", /can't resolve/.test(x.rep.summary), x.rep);
x = { rep: await measure($, classify("cd src && git checkout -- a.js"), join(d, "src")) };
check("checkout from a subfolder lists src/a.js", x.rep.lines.length === 1 && x.rep.lines[0].includes("src/a.js"), x.rep);
x = await m("git checkout -- ./src/a.js");
check("checkout ./src/a.js lists it", x.rep.lines.length === 1 && x.rep.lines[0].includes("src/a.js"), x.rep);
x = await m("git restore 'src/*.js'");
check("restore glob lists both", x.rep.lines.length === 2, x.rep);
x = await m("git checkout -- src/a.js");
check("checkout shortstat counts only the target", /^1 file changed/.test(x.rep.note), x.rep);
x = await m("find build -name x -exec touch " + join(d, "pwned") + " {} + -" + "delete");
check("find with -exec is not dry-run", !existsSync(join(d, "pwned")) && /didn't dry-run/.test(x.rep.note), x.rep);
x = await m("find build -name x -fprint " + join(d, "pwned2") + " -" + "delete");
check("find with -fprint is not dry-run", !existsSync(join(d, "pwned2")) && /didn't dry-run/.test(x.rep.note), x.rep);

x = await m("git push -uf origin main");
check("push -uf reports no remote copy", x.rep.note.includes("origin/main") || x.rep.summary.includes("force-push"), x.rep);

// consequences beyond the code
sh("mkdir -p .github/workflows db/migrations && echo x>.github/workflows/ci.yml && echo s>.env && echo m>db/migrations/0002_drop_users.sql && git add -f . && git commit -qm more", d);
const imp = (r) => (r.rep.impact ?? []).join(" | ");
x = await m("rm -rf .env");
check("rm .env: restorable count and env warning", /tracked and unmodified/.test(imp(x)) && /environment file/.test(imp(x)), x.rep);
x = await m("rm -rf db/migrations");
check("rm migrations: drift warning", /migration/.test(imp(x)), x.rep);
x = await m("git push --force origin feat");
check("force push: CI workflow noted", /CI workflow/.test(imp(x)), x.rep);
x = await m("psql -c 'DROP TABLE users CASCADE'");
check("sql: cascade noted", /CASCADE/.test(imp(x)), x.rep);
x = await m("kubectl delete namespace prod-x");
check("kubectl: never throws, has report", x.rep.summary.length > 0 && Array.isArray(x.rep.impact ?? []), x.rep);
x = await m("chmod -R 777 /");
check("chmod 777 /: broad and world-writable", /broad folder/.test(imp(x)) && /every local user/.test(imp(x)), x.rep);

// unresolved find paths are unknown blast, not zero
const DEL = "-" + "delete";
for (const c of ["find $PWD/build " + DEL, 'find "$(pwd)/build" ' + DEL, "find `pwd`/build " + DEL, "find ~/x " + DEL, "find bui* " + DEL, 'find . -name "$X" ' + DEL]) {
  x = await m(c);
  check(`unresolved find is not "nothing": ${c}`, /can't resolve/.test(x.rep.summary) && !/nothing/.test(x.rep.summary), x.rep);
}
x = await m("find build -name '*.nomatch' " + DEL);
check("find with a quoted -name glob is still measured", /delete nothing/.test(x.rep.summary), x.rep);
x = await m("find no-such-dir " + DEL);
check("find that fails with no matches does not say nothing", /could not measure/.test(x.rep.summary), x.rep);

// holds that hide inside another command
const RF = "rm -" + "rf";
const held = (c, kind) => check(`holds ${c}`, classify(c)?.kind === kind, classify(c));
held(`sh -c '${RF} build'`, "rm");
held(`bash -lc "${RF} build"`, "rm");
held(`/bin/zsh -c '${RF} build; echo done'`, "rm");
held(`sh -c 'echo hi && ${RF} build'`, "rm");
held(`bash -c "sh -c '${RF} build'"`, "rm");
held(`timeout 5 sh -c '${RF} build'`, "rm");
x = await m(`sh -c '${RF} build; echo done'`);
check("sh -c measures the script's target", /delete 2 files/.test(x.rep.summary) && x.r.targets[0] === "build", x.rep);
check("sh -c script keeps the outer cd", classify(`cd sub && sh -c 'cd in && ${RF} y'`)?.dir === "sub/in", classify(`cd sub && sh -c 'cd in && ${RF} y'`));
check("sh -c harmless script is not held", classify("sh -c 'echo hi; ls'") === null);
check("sh script.sh is not held", classify("sh script.sh") === null);

held(`find build -name x -exec ${RF} {} +`, "find-delete");
held(`find build -name x -exec ${RF} {} \\;`, "find-delete");
held("find build -type f -execdir rm {} +", "find-delete");
held("find build -ok rm {} ';'", "find-delete");
x = await m(`find build -name x -exec ${RF} {} +`);
check("find -exec rm lists what it matches", x.rep.lines.length === 1 && x.rep.lines[0].includes("build/x") && /delete 1 path/.test(x.rep.summary), x.rep);
x = await m(`find build -name x -exec touch ${join(d, "pwned3")} {} + -exec ${RF} {} +`);
check("find -exec rm with another -exec is not dry-run", !existsSync(join(d, "pwned3")) && /didn't dry-run/.test(x.rep.note), x.rep);
held(`find build -exec sh -c '${RF} "$1"' _ {} \\;`, "opaque");
held("find build -exec git reset --hard \\;", "opaque");
check("find -exec with a harmless command is not held", classify("find . -name x -exec cat {} +") === null);

const TREE = "shutil." + "rmtree";
held(`python3 -c "import shutil; ${TREE}('build')"`, "rm");
x = await m(`python3 -c "import shutil; ${TREE}('build')"`);
check("python rmtree of a literal is measured", /delete 2 files/.test(x.rep.summary), x.rep);
held(`python -c 'import shutil, sys; ${TREE}(sys.argv[1])' build`, "opaque");
check("python -c without rmtree is not held", classify("python3 -c 'import os; print(1)'") === null);

const push = (a) => "git push " + a;
held(push("origin :main"), "git-push-delete");
held(push("origin :refs/heads/feat"), "git-push-delete");
held(push("origin --" + "delete feat"), "git-push-delete");
held(push("-d origin feat"), "git-push-delete");
held(push("--force origin :feat"), "git-push-delete");
check("git push of a src:dst refspec is not held", classify("git push origin feat:feat") === null);
check("git push origin main is not held", classify("git push origin main") === null);
sh("git update-ref refs/remotes/origin/gone HEAD && git update-ref refs/remotes/origin/only $(git commit-tree HEAD^{tree} -p HEAD -m only)", d);
x = await m(push("origin :only"));
check("remote branch delete lists commits no local branch has", /delete origin\/only/.test(x.rep.summary) && x.rep.lines.length === 1, x.rep);
x = await m(push("origin :gone"));
check("remote branch delete with nothing unique says so", /delete origin\/gone/.test(x.rep.summary) && x.rep.lines.length === 0, x.rep);
x = await m(push("origin :unknown"));
check("remote branch delete with no local copy says so", /fetch/.test(x.rep.note), x.rep);
x = await m(push("origin :main"));
check("remote delete of a shared branch is flagged", /shared branch/.test(imp(x)), x.rep);


// pane copy: nothing said twice, status codes in words
sh("rm src/b.js", d);
x = await m("git checkout -- src/b.js 2>&1 | tail -1; echo done");
check("checkout row says deleted, not D", x.rep.lines[0] === "deleted  src/b.js", x.rep);
check("checkout note does not repeat the undo line", !/recovered/.test(x.rep.note), x.rep);
const flat = (n) => (n == null ? "" : typeof n === "string" ? n : Array.isArray(n) ? n.map(flat).join("") : flat(n.children));
const tt = { Box: (o) => o, Text: (o) => o, Button: (o) => o };
const pane = flat(draw(tt, { risk: x.r, command: "git checkout -- src/b.js 2>&1 | tail -1; echo done", report: x.rep, decision: null }));
check("pane does not repeat the matched command in the title or Held", pane.split("git checkout -- src/b.js").length === 3 && !/Matched/.test(pane), pane);
check("pane says the unrecoverable warning once", pane.split("can't be recovered").length === 2, pane);

// classifier robustness
for (const c of ["", "   ", ";;", "rm", "git", "git -C", "sudo", "timeout", "timeout 5", "env", "find", "xargs", "kubectl", "terraform", "docker", "psql", "chmod -R", "git restore", "git branch -D", "(((", "sh -c", "bash -c ''", "python3 -c", "find . -exec", "git push origin :"]) {
  try { classify(c); check(`no throw: ${JSON.stringify(c)}`, true); } catch (e) { check(`no throw: ${JSON.stringify(c)}`, false, String(e)); }
}

// ---- spend: payments --------------------------------------------------------
const spendHome = mkdtempSync(join(tmpdir(), "bs-home-"));
process.env.HOME = spendHome; // receipts go under $HOME/.claude/blast-shield/spend
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
let clock = Date.parse("2026-11-20T15:00:00");
const spendRun = async (argv, o = {}) => {
  if (argv[0] === "sleep") { await sleepMs(5); return { exitCode: 0, stdout: "", stderr: "" }; }
  await sleepMs(Math.random() * 20); // let concurrent calls interleave between read and append
  return $.process.run(argv, o);
};
const ui = { opened: 0, toasts: [] };
let paneHook = null;
let answer = "proceed";
const findKey = (n, key) => !n || typeof n !== "object" ? null : n.key === key ? n : [].concat(n.children ?? []).map((c) => findKey(c, key)).find(Boolean) ?? null;
const S = (project) => ({
  process: { run: spendRun },
  clock: { now: async () => clock },
  session: { cwd: async () => `/work/${project}`, id: async () => "sess-1234abcd" },
  ui: {
    open: async () => { ui.opened += 1; setTimeout(() => findKey(paneHook(S(project), { requestId: "blast-shield" }, () => null), answer)?.onPress(), 20); return { isPlaced: true }; },
    close: async () => {}, invalidate: () => {}, status: () => {}, toast: (t) => ui.toasts.push(t),
    resolve: () => tt,
  },
});
const hooks = [];
const on = (ev, a, b) => { hooks.push({ ev, matcher: b ? a : null, fn: b ?? a }); return { catch() {} }; };
register(on, {});
const mcpHook = hooks.find((h) => h.ev === "tool.call" && h.matcher === null).fn;
paneHook = hooks.find((h) => h.ev === "ui.render" && h.matcher?.component === "Pane").fn;
const nextOk = Object.assign(async (e) => ({ result: { ok: true }, text: "ok" }), { signal: { aborted: false } });
const nextDeny = Object.assign(async (e) => ({ deny: "permission denied" }), { signal: { aborted: false } });
const postFailure = () => hooks.find((h) => h.ev === "classic.PostToolUseFailure").fn;
// The tool ran and failed: the host raises PostToolUseFailure before the call resolves.
const nextErr = Object.assign(async (e) => { await postFailure()({}, { tool_name: e.tool, tool_use_id: e.tool_use_id }, (x) => x); return { isError: true, result: "boom", text: "boom" }; }, { signal: { aborted: false } });
// Refused before it ran (a permission rule or the prompt): an error with no PostToolUse event.
const nextRefused = Object.assign(async (e) => ({ isError: true, result: "Permission denied", text: "Permission denied" }), { signal: { aborted: false } });
const receiptsOf = (project) => {
  try { return parseReceipts(execFileSync("cat", [join(spendHome, ".claude/blast-shield/spend", `-work-${project}.jsonl`)], { encoding: "utf8" })); } catch { return []; }
};

// matcher
configureSpend({});
for (const [tool, want] of [
  ["mcp__stripe__create_charge", "charge"], ["mcp__stripe__create_payment_intent", "payment"], ["mcp__acme__createPaymentIntent", "payment"],
  ["mcp__bank__send_transfer", "transfer"], ["mcp__stripe__create_refund", "refund"], ["mcp__shop__checkout", "checkout"],
  ["mcp__inv__pay_invoice", "pay"], ["mcp__stripe__create_payout", "payout"], ["mcp__billing__invoices_create", "invoice"],
  ["mcp__stripe__list_invoices", null], ["mcp__stripe__get_payment", null], ["mcp__stripe__retrieve_charge", null],
  ["mcp__x__display", null], ["mcp__x__send_payload", null], ["mcp__x__transfer_file_upload", "transfer"], ["mcp__payments__create_customer", null],
  ["Bash", null], ["Read", null], ["mcp__x__", null],
]) check(`spend matcher: ${tool} -> ${want}`, spendPatternOf(tool) === want, spendPatternOf(tool));
configureSpend({ spendPatterns: "donate, tip" });
check("spend patterns come from config", spendPatternOf("mcp__x__send_tip") === "tip" && spendPatternOf("mcp__stripe__create_charge") === null);
configureSpend({});
check("stripe CLI charge is held as spend", classify("stripe charges create --amount 2000 --currency usd")?.kind === "spend");
check("stripe CLI behind sudo and env is held", classify("sudo env STRIPE_X=1 stripe payouts create --amount 5")?.kind === "spend");
check("stripe CLI label never carries flag values", classify("stripe --api-key sk_test_123 refunds create --charge ch_1")?.label === "stripe refunds create");
check("stripe CLI compound verbs are held", classify("stripe invoices finalize_invoice in_1")?.label === "stripe invoices finalize_invoice" && classify("stripe invoices send_invoice in_1")?.kind === "spend" && classify("stripe invoices pay in_1")?.kind === "spend");
check("stripe CLI reads are not held", classify("stripe charges list") === null && classify("stripe customers create") === null && classify("stripe listen") === null);

// amounts
configureSpend({});
let r = readSpend({ amount: 20, currency: "USD", destination: "acct_1" });
check("bare amount reads as major units by default", r.amount === 2000 && r.currency === "usd" && r.payee === "acct_1", r);
check("cents keys are minor units", readSpend({ amount_cents: 1999 }).amount === 1999);
check("nested amount is found", readSpend({ transfer: { amount: "12.50", currency: "eur", recipient: "a@b.c" } }).amount === 1250);
for (const bad of [0, -5, "abc", NaN, Infinity, "1e3", 1.234, null]) check(`untrusted amount ${String(bad)} is null`, readSpend({ amount: bad }).amount === null);
check("fractional cents are null", readSpend({ cents: 10.5 }).amount === null);
configureSpend({ minorUnitServers: "stripe, Square" });
check("listed server: bare amount 2000 is 20.00", readSpend({ amount: 2000 }, "mcp__stripe__create_refund").amount === 2000 && readSpend({ amount: 20.5 }, "mcp__square__pay").amount === null);
check("unlisted server: bare amount stays major", readSpend({ amount: 20 }, "mcp__paypal__create_payout").amount === 2000);

// allowance math
configureSpend({ dailyAllowance: 20, allowanceCurrency: "usd" });
const day = "2026-11-20";
const at = "2026-11-20T10:00:00";
const rows = [
  { ts: at, id: "a", decision: "allowed", amount: 1500, currency: "usd", payee: "acct_1" },
  { ts: at, id: "b", decision: "approved", amount: 300, currency: "usd", payee: "acct_2" },
  { ts: at, id: "b2", decision: "allowed", amount: 900, currency: "usd", payee: "acct_9" },
  { ts: at, id: "b2", decision: "release", amount: 900, currency: "usd" },
  { ts: at, decision: "cancel", amount: 9999, currency: "usd", payee: "acct_3" },
  { ts: "2026-11-19T10:00:00", id: "c", decision: "allowed", amount: 1900, currency: "usd", payee: "acct_4" },
  { ts: at, id: "d", decision: "allowed", amount: 5000, currency: "eur", payee: "acct_5" },
];
const L = ledger(rows, day, "usd");
check("ledger counts today's reserved usd, minus releases, not cancels", L.spent === 1800, L);
check("ledger knows paid payees, not cancelled or released ones", L.paid.has("acct_4") && !L.paid.has("acct_3") && !L.paid.has("acct_9"), [...L.paid]);
let c = checkSpend({ amount: 200, currency: "usd", payee: "acct_1" }, rows, day);
check("fits exactly at the cap", c.reasons.length === 0 && !c.firstPayee, c);
c = checkSpend({ amount: 201, currency: "usd", payee: "acct_1" }, rows, day);
check("one cent over the cap is held", /over the daily allowance/.test(c.reasons.join()), c);
check("no amount is held", /no amount/.test(checkSpend({ amount: null, currency: "usd", payee: "x" }, rows, day).reasons.join()));
check("other currency is held", /EUR/.test(checkSpend({ amount: 1, currency: "eur", payee: "x" }, rows, day).reasons.join()));
check("missing currency is held", /no currency/.test(checkSpend({ amount: 1, currency: null, payee: "x" }, rows, day).reasons.join()));
check("unreadable receipts are held", /couldn't be read/.test(checkSpend({ amount: 1, currency: "usd", payee: "x" }, null, day).reasons.join()));
check("first payee is flagged", checkSpend({ amount: 1, currency: "usd", payee: "acct_new" }, rows, day).firstPayee === true);
configureSpend({});
check("allowance off holds everything", /no daily allowance/.test(checkSpend({ amount: 1, currency: "usd", payee: "x" }, [], day).reasons.join()));
configureSpend({ dailyAllowance: 20, payeeAllowlist: "acct_1, Shop@Example.com" });
check("allowlisted payee passes", checkSpend({ amount: 1, currency: "usd", payee: "shop@example.com" }, [], day).reasons.length === 0);
check("payee off the allowlist is held", /not on the payee allowlist/.test(checkSpend({ amount: 1, currency: "usd", payee: "acct_2" }, [], day).reasons.join()));
check("no payee with an allowlist is held", /no payee found/.test(checkSpend({ amount: 1, currency: "usd", payee: null }, [], day).reasons.join()));

// concurrent reservations: ten 6.00 payments against 20.00, all at once
configureSpend({ dailyAllowance: 20 });
const ctx = { project: "-work-race", session: "sess-1" };
const results = await Promise.all(Array.from({ length: 10 }, () => reserveSpend(S("race"), ctx, { tool: "mcp__x__pay", amount: 600, currency: "usd", payee: "acct_1" })));
const passed = results.filter((x) => x.id).length;
check("the lock folder is gone after the race", !existsSync(join(spendHome, ".claude/blast-shield/spend/-work-race.jsonl.lock")));
check("concurrent reservations never pass the cap", passed === 3, results.map((x) => x.id ?? x.reasons[0]));
check("each reservation left one allowed receipt", receiptsOf("race").filter((x) => x.decision === "allowed").length === 3, receiptsOf("race"));

// through the hook: under the allowance runs with no pane, and leaves receipts
ui.opened = 0;
let out = await mcpHook(S("hook"), { tool: "mcp__stripe__create_charge", tool_use_id: "t1", amount: 5, currency: "usd", customer: "cus_1", api_key: "sk_live_secret" }, nextOk);
let rec = receiptsOf("hook");
check("under the allowance: runs, no pane", out.result?.ok === true && ui.opened === 0, out);
check("under the allowance: reserve then commit", rec.map((x) => x.decision).join() === "allowed,commit" && rec[0].id === rec[1].id && rec[0].amount === 500, rec);
check("receipt has the listed fields only", JSON.stringify(Object.keys(rec[0]).sort()) === JSON.stringify(["amount", "currency", "decision", "id", "payee", "reason", "session", "tool", "ts"]) && !JSON.stringify(rec).includes("sk_live"), rec[0]);
check("first payment to a payee is toasted", ui.toasts.some((t) => /First payment to cus_1/.test(t)), ui.toasts);
ui.toasts.length = 0;
await mcpHook(S("hook"), { tool: "mcp__stripe__create_charge", tool_use_id: "t2", amount: 5, currency: "usd", customer: "cus_1" }, nextOk);
check("second payment to the same payee is not flagged", !ui.toasts.some((t) => /First payment/.test(t)), ui.toasts);
out = await mcpHook(S("hook"), { tool: "mcp__stripe__create_charge", tool_use_id: "t3", amount: 5, currency: "usd", customer: "cus_1" }, nextDeny);
rec = receiptsOf("hook");
check("a denied call releases its reservation", rec.at(-1).decision === "release" && rec.at(-1).id === rec.at(-2).id, rec);
out = await mcpHook(S("hook"), { tool: "mcp__stripe__create_charge", tool_use_id: "t4", amount: 5, currency: "usd", customer: "cus_1" }, nextErr);
rec = receiptsOf("hook");
check("a tool error is committed, not released", rec.at(-1).decision === "commit" && /may have gone through/.test(rec.at(-1).reason), rec.at(-1));
out = await mcpHook(S("hook"), { tool: "mcp__stripe__create_charge", tool_use_id: "t4b", amount: 5, currency: "usd", customer: "cus_1" }, nextRefused);
rec = receiptsOf("hook");
check("an error with no PostToolUse (refused before running) releases", rec.at(-1).decision === "release" && /before the tool ran/.test(rec.at(-1).reason), rec.at(-1));
// 15.00 counted (5 + 5 + 5 errored); 6.00 more is over 20.00
answer = "cancel";
out = await mcpHook(S("hook"), { tool: "mcp__stripe__create_charge", tool_use_id: "t5", amount: 6, currency: "usd", customer: "cus_1" }, nextOk);
rec = receiptsOf("hook");
check("over the allowance: held, Cancel denies", ui.opened === 1 && /did not run it: the user pressed Cancel\. It would have: pay 6\.00 USD to cus_1\./.test(out.deny ?? ""), out);
check("a cancel leaves a cancel receipt with no id", rec.at(-1).decision === "cancel" && rec.at(-1).id === undefined, rec.at(-1));
answer = "proceed";
out = await mcpHook(S("hook"), { tool: "mcp__stripe__create_charge", tool_use_id: "t6", amount: 6, currency: "usd", customer: "cus_1" }, nextOk);
rec = receiptsOf("hook");
check("over the allowance: Proceed runs it as approved, then commits", out.result?.ok === true && rec.slice(-2).map((x) => x.decision).join() === "approved,commit", rec.slice(-2));
out = await mcpHook(S("hook"), { tool: "mcp__stripe__create_charge", tool_use_id: "t7", currency: "usd", customer: "cus_1" }, nextOk);
check("no amount: always held", ui.opened === 3, ui.opened);
clock += 24 * 3600 * 1000;
ui.opened = 0;
await mcpHook(S("hook"), { tool: "mcp__stripe__create_charge", tool_use_id: "t8", amount: 5, currency: "usd", customer: "cus_1" }, nextOk);
check("a new day starts a new allowance", ui.opened === 0, ui.opened);
out = await mcpHook(S("hook"), { tool: "mcp__notes__list_payments", tool_use_id: "t9" }, nextOk);
check("non-payment MCP tools pass straight through", out.result?.ok === true && ui.opened === 0);

// UTC day: 23:30 UTC on the 20th and 00:30 UTC on the 21st are different days wherever the host is
configureSpend({ dailyAllowance: 20 });
const late = [{ ts: "2026-11-20T23:30:00.000Z", id: "u1", decision: "allowed", amount: 1900, currency: "usd", payee: "p" }];
check("the allowance day is the UTC day", ledger(late, "2026-11-20", "usd").spent === 1900 && ledger(late, "2026-11-21", "usd").spent === 0);

// the agent may read receipts, not change them
const bashHook = hooks.find((h) => h.ev === "tool.call" && h.matcher?.tool === "Bash").fn;
for (const cmd of ["echo '{}' >> ~/.claude/blast-shield/spend/x.jsonl", "rm -f $HOME/.claude/blast-shield/spend/x.jsonl", "sed -i '' 1d ~/.claude/blast-shield/spend/x.jsonl", "python3 -c 'open(\"/Users/a/.claude/blast-shield/spend/x.jsonl\",\"w\")'"]) {
  out = await bashHook(S("guard"), { tool: "Bash", command: cmd }, nextOk);
  check(`receipts guard refuses: ${cmd}`, /spend receipts/.test(out.deny ?? ""), out);
}
out = await bashHook(S("guard"), { tool: "Bash", command: "jq -c . ~/.claude/blast-shield/spend/*.jsonl | tail -5" }, nextOk);
check("receipts guard lets reads through", out.result?.ok === true, out);
for (const [tool, file_path] of [["Write", "/Users/a/.claude/blast-shield/spend/x.jsonl"], ["Edit", "~/.claude/blast-shield/spend/x.jsonl"]]) {
  out = await mcpHook(S("guard"), { tool, file_path }, nextOk);
  check(`receipts guard refuses ${tool}`, /spend receipts/.test(out.deny ?? ""), out);
}
out = await mcpHook(S("guard"), { tool: "Write", file_path: "/repo/blast-shield/README.md" }, nextOk);
check("receipts guard leaves other files alone", out.result?.ok === true, out);

// across processes: four sessions, five 3.00 payments each, against 20.00 at once
const child = `
const m = await import(${JSON.stringify(new URL("../hooks/blast-shield.mjs", import.meta.url).href)});
const { spawnSync } = await import("node:child_process");
m.configureSpend({ dailyAllowance: 20 });
const $ = { clock: { now: async () => ${clock} }, process: { run: async (argv, o = {}) => { await new Promise((r) => setTimeout(r, Math.random() * 15)); const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: o.timeoutMs }); return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }; } } };
const out = await Promise.all(Array.from({ length: 5 }, () => m.reserveSpend($, { project: "-work-xproc", session: "p" + process.pid }, { tool: "mcp__x__pay", amount: 300, currency: "usd", payee: "a" })));
console.log(out.filter((x) => x.id).length);
`;
const { spawn } = await import("node:child_process");
const counts = await Promise.all(Array.from({ length: 4 }, () => new Promise((res) => {
  const p = spawn(process.execPath, ["--input-type=module", "-e", child], { env: { ...process.env, HOME: spendHome } });
  let o = ""; p.stdout.on("data", (b) => (o += b)); p.stderr.on("data", (b) => (o += b)); p.on("close", () => res(o.trim()));
})));
const total = counts.reduce((a, b) => a + Number(b), 0);
check("reservations across processes never pass the cap", total === 6 && receiptsOf("xproc").filter((x) => x.decision === "allowed").length === 6, counts);

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
