import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { classify, measure, draw } = await import(new URL("../hooks/blast-shield.mjs", import.meta.url).href);

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
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
