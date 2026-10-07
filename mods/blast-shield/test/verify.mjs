import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { classify, measure } = await import(new URL("../hooks/blast-shield.mjs", import.meta.url).href);

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

// classifier robustness
for (const c of ["", "   ", ";;", "rm", "git", "git -C", "sudo", "timeout", "timeout 5", "env", "find", "xargs", "kubectl", "terraform", "docker", "psql", "chmod -R", "git restore", "git branch -D", "((("]) {
  try { classify(c); check(`no throw: ${JSON.stringify(c)}`, true); } catch (e) { check(`no throw: ${JSON.stringify(c)}`, false, String(e)); }
}
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
