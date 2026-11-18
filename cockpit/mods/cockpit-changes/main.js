// Source control for the focused folder's repository, after VS Code's: a message and Commit on
// top, Push / Pull beside the branch, then Staged Changes and Changes. Each file is staged (+),
// unstaged (−) or discarded (↶, after a confirmation) by hand; a click shows its diff below.
// The branch name opens the branch list: switch, create, and see which branches live in
// another worktree (a second folder of the same repository), which git won't check out here.
// With an agent in the focused pane, the list can also show everything that changed since
// that agent started (its commits included), read-only, for review.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, home, nextCommand, checking, agents, shared, setShared } from "herdr";
import { tokenize, commentMarker } from "./syntax.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

// Vivid git status colors (GitHub's), one set per appearance: the theme's ANSI
// green and red read too faint for added, modified and deleted lines and files.
// The diff row backgrounds are solid and pure in hue: the ones Claude Code paints in its own diffs.
// cockpit-files has the same table (mods cannot import each other): keep both in step.
function gitColors() {
  return settings()?.dark === false
    ? { add: "#1a7f37", mod: "#9a6700", del: "#cf222e", addBg: "#b4ecc0", delBg: "#ffc9d0", addNum: "#1a7f37", delNum: "#cf222e" }
    : { add: "#3fb950", mod: "#e3b341", del: "#f85149", addBg: "#022800", delBg: "#3d0100", addNum: "#56d364", delNum: "#ff7b72" };
}
// Code colors over those rows: bright enough to read on the green and on the red.
function syntaxColors() {
  return settings()?.dark === false
    ? { keyword: "#cf222e", string: "#0a3069", number: "#0550ae", constant: "#0550ae", function: "#8250df", type: "#953800", comment: "#6e7781" }
    : { keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9", constant: "#bd93f9", function: "#50fa7b", type: "#8be9fd", comment: "#8b949e" };
}
const ROW = 22; // px, one diff line
const CHAR = 7.55; // px, one character of the 12.5px code font
const GUTTER = 60; // px, line number plus the +/− column

// Cuts a line's tokens into visual lines of at most `cols` characters, so a long line
// wraps instead of scrolling sideways. A token that fits on a line of its own moves down whole.
function wrapTokens(tokens, cols) {
  const lines = [[]];
  let used = 0;
  for (const tok of tokens) {
    let text = tok.text;
    if (used > 0 && text.length > cols - used && text.length <= cols) { lines.push([]); used = 0; }
    while (text.length) {
      if (used >= cols) { lines.push([]); used = 0; }
      const part = text.slice(0, cols - used);
      lines.at(-1).push({ text: part, kind: tok.kind });
      used += part.length; text = text.slice(part.length);
    }
  }
  return lines;
}
const markColor = (c, mark) => (mark === "A" || mark === "?" ? c.add : mark === "D" || mark === "U" ? c.del : c.mod);
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

// One listed change: a path on one side. staged: what the next commit takes (index against
// HEAD); otherwise what is only in the working tree, untracked files included.
// Where each agent started: terminal address → { head, at }. The commit an agent's folder was
// on when this mod first saw it, kept in shared state so it survives restarts and other mods
// (cockpit-worktrees) read it. An agent seen late starts from the commit it was on by then.
const BASELINES = "cockpit.agent-baselines";

// The agent in the focused pane, when the focus is on one.
function focusedAgent() {
  const f = focused(), pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (!pane?.program?.agent || !pane.terminal) return null;
  const title = (agents().find((a) => a.pane === pane.pane)?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return { address: pane.terminal, name: !title || /^[0-9a-f]{8}-/i.test(title) ? pane.program.name : title };
}

const tilde = (path) => (path.startsWith(home()) ? `~${path.slice(home().length)}` : path);
const itemKey = (item) => `${item.staged ? "s" : "w"}:${item.path}`;
// The letter VS Code shows: U is an untracked file, C a conflict.
const letterColor = (c, letter) => (letter === "A" || letter === "U" ? c.add : letter === "D" || letter === "C" ? c.del : c.mod);

export default class Changes extends View {
  init(_props, cx) {
    this.items = []; this.rows = []; this.visual = []; this.cols = 80; this.message = ""; this.handle = cx.focus_handle();
    this.hovered = null; this.confirm = null; this.sync = null; this.picking = false; this.branches = null; this.worktree = null;
    this.scope = "work"; this.review = null;
    this.branchInput = InputState.new({ placeholder: "New branch name (Enter creates it)" });
    this.branchInput.on("submit", (_e, cx) => this.askCreate(cx));
    this.input = InputState.new({ placeholder: "Message (Enter commits)" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.askCommit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    if (checking()) return;
    // Commands, bindable in keys.json. "cockpit-changes.branches" opens and closes the branch list.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "branches") this.togglePicker(cx);
        // "cockpit-changes.review" flips between the working tree and the focused agent's review.
        else if (command === "review" && this.review) this.setScope(this.scope === "agent" ? "work" : "agent", cx);
      }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  // Notes the commit each local agent's folder is on the first time it is seen, and forgets
  // agents that are gone. Never forgets while no pane is listed (the window is still loading).
  async recordBaselines() {
    const known = shared(BASELINES) ?? {}, live = new Map();
    for (const p of panes()) if (p.program?.agent && p.terminal && p.cwd && !p.terminal.includes("/")) live.set(p.terminal, p.cwd);
    if (!live.size) return;
    const next = {};
    let changed = Object.keys(known).some((address) => !live.has(address));
    for (const [address, cwd] of live) {
      if (known[address]) { next[address] = known[address]; continue; }
      const r = await exec("git", ["rev-parse", "HEAD"], { cwd }).catch(() => null);
      if (r?.code === 0) { next[address] = { head: r.stdout.trim(), at: Date.now() }; changed = true; }
    }
    if (changed) setShared(BASELINES, next);
  }

  refresh(cx) {
    // Asked while a read or an action runs: read once more when it ends, so nothing shown is stale.
    if (this.loading || this.busy) { this.again = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.items = []; this.open = null; this.sync = null; this.confirm = null; this.picking = false; this.branches = null; this.worktree = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        await this.recordBaselines().catch(() => {});
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.items = []; this.setLines([]); this.open = null; this.sync = null; this.review = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const numstat = async (args) => {
          const out = {}, r = await git(["diff", ...args, "--numstat", "-z", "--no-renames"]);
          if (r.code !== 0) throw new Error(r.stderr);
          for (const entry of r.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (parts.length) out[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
          }
          return out;
        };
        const stagedStats = await numstat(["--cached"]), workStats = await numstat([]);
        let items = [];
        const none = { add: 0, del: 0 };
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const x = entry[0], y = entry[1], path = entry.slice(3);
          if (x === "?" && y === "?") { items.push({ path, staged: false, letter: "U", fresh: true, ...none }); continue; }
          if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) { items.push({ path, staged: false, letter: "C", ...(workStats[path] ?? none) }); continue; }
          if (x !== " ") items.push({ path, staged: true, letter: x, ...(stagedStats[path] ?? none) });
          if (y !== " ") items.push({ path, staged: false, letter: y, ...(workStats[path] ?? none) });
        }
        // What Push and Pull would move: commits ahead of and behind the branch's upstream.
        const branch = (await git(["branch", "--show-current"])).stdout.trim();
        const counts = head.code === 0 ? await git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]) : null;
        let sync = { branch, ahead: 0, behind: 0, upstream: false, remote: null };
        if (counts?.code === 0) {
          const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
          sync = { branch, ahead, behind, upstream: true, remote: null };
        } else if (head.code === 0 && branch) {
          sync.remote = (await git(["remote"])).stdout.split("\n").filter(Boolean)[0] ?? null;
        }
        // The focused agent's review: what changed in this folder since it started, its commits included.
        const me = on ? null : focusedAgent(), base = me ? (shared(BASELINES) ?? {})[me.address] : null;
        let review = null;
        if (base) {
          const count = await git(["rev-list", "--count", `${base.head}..HEAD`]);
          review = { agent: me.name, head: base.head, at: base.at, commits: count.code === 0 ? Number(count.stdout.trim()) : 0, log: [] };
          if (this.scope === "agent") {
            const names = await git(["diff", "--name-status", "--no-renames", "-z", base.head]);
            if (names.code !== 0) throw new Error(names.stderr);
            const stats = await numstat([base.head]), fields = names.stdout.split("\0").filter(Boolean);
            const fresh = items.filter((f) => f.fresh).map((f) => ({ ...f, review: true }));
            items = [];
            for (let i = 0; i + 1 < fields.length; i += 2) items.push({ path: fields[i + 1], staged: false, review: true, letter: fields[i][0], ...(stats[fields[i + 1]] ?? none) });
            items.push(...fresh);
            const log = await git(["log", "--format=%h%x09%s", "-n", "30", `${base.head}..HEAD`]);
            review.log = log.stdout.split("\n").filter(Boolean).map((line) => { const [hash, ...subject] = line.split("\t"); return { hash, subject: subject.join("\t") }; });
          }
        }
        if (!base) this.scope = "work";
        // A linked worktree keeps its own git dir under the main checkout's .git.
        const dirs = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"])).stdout.trim().split("\n");
        const worktree = dirs.length === 2 && dirs[0] !== dirs[1] ? { main: dirs[0].replace(/\/\.git$/, "") } : null;
        if (key() !== context) return;
        this.worktree = worktree; this.review = review;
        if (this.picking) await this.loadBranches(root, on);
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.items = items; this.sync = sync; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        // A staged or unstaged file keeps its diff open on the side it moved to.
        if (this.open && !items.some((f) => itemKey(f) === this.open)) {
          const moved = items.find((f) => f.path === this.open.slice(2));
          this.open = moved ? itemKey(moved) : null;
          this.setLines([]);
        }
        // The first file listed (staged ones come first) shows its diff until you pick another.
        if (!this.open && !this.closed && items.length) this.open = itemKey(items.find((f) => f.staged) ?? items[0]);
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  async load(id, context) {
    const item = this.items.find((f) => itemKey(f) === id), root = this.root, on = this.on;
    if (!item) return;
    let lines;
    if (item.fresh) {
      const text = await readTextFile(`${root}/${item.path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        item.add = countLines(text);
        lines = [`@@ -0,0 +1,${item.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      // Staged: what the commit takes. Unstaged: what is still only in the working tree.
      // Review: everything since the agent's starting commit.
      const r = await exec("git", [...READ, "diff", ...(item.review ? [this.review.head] : item.staged ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", item.path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [item.binary ? "Binary file changed" : item.letter === "D" ? "File deleted" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === id) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.marker = commentMarker(this.open?.slice(2));
    this.layout();
  }

  pick(id, cx) {
    this.open = this.open === id ? null : id; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(id, context); }
      catch (e) { if (key() === context && this.open === id) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  // Runs git commands one after the other, then reads the repository again. `label` is what
  // the busy button says; a failure stops the run and shows git's own words.
  act(label, steps, cx, done) {
    if (!this.root || this.busy || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = label; this.note = null; this.confirm = null;
    cx.spawn(async (cx) => {
      try {
        for (const [cmd, args, timeout] of steps) {
          const r = await exec(cmd, args, { cwd: root, on, timeout: timeout ?? 30000 });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `${cmd} failed`);
        }
        if (key() === context) done?.();
      } catch (e) { if (key() === context) this.note = `${label} failed: ${e.message || e}`; }
      finally { this.busy = null; this.again = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  stage(paths, cx) {
    this.act("Stage", [["git", ["add", "-A", "--", ...paths]]], cx);
  }

  unstage(paths, cx) {
    // Before the first commit there is no HEAD to restore the index from.
    this.act("Unstage", [["git", this.hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "-r", "-q", "--cached", "--", ...paths]]], cx);
  }

  // Throws away working-tree changes: tracked files go back to what is staged (or committed),
  // untracked ones to the Trash on this Mac, else they are removed. Asked for by `confirm`.
  discard(items, cx) {
    const tracked = items.filter((f) => !f.fresh).map((f) => f.path), fresh = items.filter((f) => f.fresh).map((f) => `${this.root}/${f.path}`);
    const steps = [];
    if (tracked.length) steps.push(["git", ["restore", "--worktree", "--", ...tracked]]);
    if (fresh.length) steps.push(this.trashes() ? ["trash", fresh] : ["rm", ["-rf", "--", ...fresh]]);
    this.act("Discard", steps, cx);
  }

  trashes() {
    return !this.on && window()?.platform === "macos";
  }

  // Everything that can't be taken back with one click (discard, commit, push, pull) asks
  // first, in a bar: what will happen, a button that does it, and Cancel.
  ask(text, label, run, cx) {
    this.confirm = { text, label, run };
    cx.notify();
  }

  askDiscard(items, cx) {
    const fresh = items.filter((f) => f.fresh).length, where = this.trashes() ? "go to the Trash" : "are deleted for good";
    const text = items.length === 1
      ? (fresh ? `${this.trashes() ? "Move the new file to the Trash" : "Delete the new file for good"}: ${items[0].path}?` : `Discard the changes in ${items[0].path}? This can't be undone.`)
      : `Discard all ${items.length} changes? This can't be undone${fresh ? `; ${fresh} new file(s) ${where}` : ""}.`;
    this.ask(text, "Discard", (cx) => this.discard(items, cx), cx);
  }

  askCommit(cx) {
    const message = this.message.trim();
    if (!message || !this.items.length || this.busy || this.loading) return;
    const staged = this.items.filter((f) => f.staged);
    const what = staged.length ? `${staged.length} staged file(s)` : `all ${this.items.length} change(s), since nothing is staged`;
    this.ask(`Commit ${what} to ${this.sync?.branch || "this branch"}: "${message}"?`, "Commit", (cx) => this.commit(cx), cx);
  }

  askPush(cx) {
    const s = this.sync;
    if (!s) return;
    this.ask(s.upstream ? `Push ${s.ahead} commit(s) of ${s.branch} to the remote?` : `Publish ${s.branch} to ${s.remote} and track it?`, s.upstream ? "Push" : "Publish", (cx) => this.push(cx), cx);
  }

  askPull(cx) {
    this.ask(`Pull ${this.sync.behind} commit(s) into ${this.sync.branch}? Your files change to match.`, "Pull", (cx) => this.pull(cx), cx);
  }

  // With something staged, commits exactly that. With nothing staged, commits every change,
  // as VS Code's smart commit does.
  commit(cx) {
    const message = this.message.trim();
    if (!message || !this.items.length || this.loading) return;
    const staged = this.items.some((f) => f.staged);
    this.act("Commit", [...(staged ? [] : [["git", ["add", "-A"]]]), ["git", ["commit", "-m", message]]], cx,
      () => { this.message = ""; this.input.set_value(""); });
  }

  push(cx) {
    const s = this.sync;
    if (!s) return;
    this.act("Push", [["git", s.upstream ? ["push"] : ["push", "-u", s.remote, s.branch], 120000]], cx);
  }

  pull(cx) {
    this.act("Pull", [["git", ["pull"], 120000]], cx);
  }

  // Local branches, newest commit first, and for each the other worktree that holds it, if any.
  async loadBranches(root, on) {
    const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
    const [refs, trees] = await Promise.all([
      git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(committerdate:relative)", "refs/heads"]),
      git(["worktree", "list", "--porcelain"]),
    ]);
    const where = {};
    let path = null;
    for (const line of trees.stdout.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch refs/heads/")) where[line.slice(18)] = path;
    }
    this.branches = refs.stdout.split("\n").filter(Boolean).map((line) => {
      const [name, when] = line.split("\t");
      return { name, when, worktree: where[name] && where[name] !== root ? where[name] : null };
    });
  }

  // "work": the working tree, to stage and commit. "agent": since the focused agent started.
  setScope(scope, cx) {
    if (this.scope === scope) return;
    this.scope = scope; this.open = null; this.closed = false; this.confirm = null; this.setLines([]);
    this.refresh(cx);
    cx.notify();
  }

  togglePicker(cx) {
    this.picking = !this.picking;
    if (this.picking && this.root) {
      const root = this.root, on = this.on;
      cx.spawn(async (cx) => { await this.loadBranches(root, on).catch(() => { this.branches = []; }); cx.notify(); });
    }
    cx.notify();
  }

  askSwitch(name, cx) {
    const carry = this.items.length ? ` Your ${this.items.length} uncommitted change(s) come along; git refuses if they would be overwritten.` : "";
    this.ask(`Switch this folder from ${this.sync?.branch || "the current commit"} to ${name}?${carry}`, "Switch",
      (cx) => this.act("Switch", [["git", ["switch", name]]], cx, () => { this.picking = false; }), cx);
  }

  askCreate(cx) {
    const name = this.branchInput.value().trim();
    if (!name) return;
    this.ask(`Create the branch ${name} from ${this.sync?.branch || "the current commit"} and switch to it?`, "Create",
      (cx) => this.act("Create branch", [["git", ["switch", "-c", name]]], cx, () => { this.picking = false; this.branchInput.set_value(""); }), cx);
  }

  // A worktree is another folder: it opens beside this tab instead of changing this one.
  openFolder(folder, name) {
    run("tab.new", { folder, name });
  }

  // The rows as drawn: each diff line wrapped to the panel's width. Only the first visual
  // line of a diff line carries its number and sign.
  layout() {
    this.visual = this.rows.flatMap((row) => {
      if (row.kind === "@" || row.kind === "") return [row];
      return wrapTokens(tokenize(row.text, this.marker), this.cols)
        .map((tokens, i) => ({ kind: row.kind, number: i === 0 ? row.number : undefined, first: i === 0, tokens }));
    });
  }

  diffRow(row, t) {
    const { kind, number, text } = row;
    if (kind === "@") return div().w_full().px(12).h(ROW).flex_none().flex().items_center().truncate().bg(t.raised).text_color(t.muted).child(text);
    if (kind === "") return div().w_full().px(12).h(ROW).flex_none().truncate().text_color(t.muted).child(text);
    const c = gitColors(), syn = syntaxColors(), edge = kind === "+" ? c.addNum : kind === "-" ? c.delNum : t.dim;
    return h_flex().w_full().h(ROW).flex_none().items_center().text_color(t.foreground)
      .when(kind === "+", (e) => e.bg(c.addBg)).when(kind === "-", (e) => e.bg(c.delBg))
      .child(div().w(38).flex_none().text_right().text_color(edge).child(number === undefined ? "" : String(number)))
      .child(div().w(22).flex_none().flex().justify_center().font_bold().text_color(edge).child(!row.first ? "" : kind === "+" ? "+" : kind === "-" ? "−" : ""))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
        .children(row.tokens.map((tok) => div().flex_none().when(Boolean(tok.kind), (e) => e.text_color(syn[tok.kind])).child(tok.text))));
  }

  // A small square button of a row or a section: its click never reaches the row under it.
  action(id, glyph, tip, t, run) {
    return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(3).cursor_pointer().text_size(14).text_color(t.muted)
      .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); run(cx); })
      .child(glyph);
  }

  section(id, title, items, t, actions) {
    return h_flex().id(`section-${id}`).h(26).flex_none().px(8).gap(6).items_center().text_size(11.5).font_medium().text_color(t.muted)
      .child(div().flex_none().child(title))
      .child(div().flex_none().px(5).rounded(3).bg(t.raised).text_size(10.5).child(String(items.length)))
      .child(div().flex_1())
      .children(actions);
  }

  fileRow(f, t, c) {
    const id = itemKey(f), parts = f.path.split("/"), name = parts.pop(), hot = this.hovered === id;
    return h_flex().id(`change-${id}`).h(28).flex_none().px(8).gap(8).items_center().rounded(3).cursor_pointer()
      .when(this.open === id, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hovered = id; else if (this.hovered === id) this.hovered = null;
        cx.notify();
      })
      .on_click((_e, cx) => this.pick(id, cx))
      .child(h_flex().flex_1().min_w(0).gap(6)
        .child(div().flex_initial().min_w(0).truncate().text_color(letterColor(c, f.letter)).when(f.letter === "D", (e) => e.line_through()).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(parts.join("/"))))
      // The row's buttons take the place of its numbers while the pointer is on it.
      .when(hot && !f.staged && !f.review, (e) => e
        .child(this.action(`discard-${id}`, "↶", f.fresh ? "Delete this new file" : "Discard changes", t, (cx) => this.askDiscard([f], cx)))
        .child(this.action(`stage-${id}`, "+", "Stage: include in the commit", t, (cx) => this.stage([f.path], cx))))
      .when(hot && f.staged, (e) => e.child(this.action(`unstage-${id}`, "−", "Unstage: leave out of the commit", t, (cx) => this.unstage([f.path], cx))))
      .when(!hot && f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(c.add).child(`+${f.add}`)))
      .when(!hot && f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(c.del).child(`−${f.del}`)))
      .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(letterColor(c, f.letter)).child(f.letter));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), c = gitColors(), s = this.sync;
    const staged = this.items.filter((f) => f.staged), work = this.items.filter((f) => !f.staged);
    const add = this.items.reduce((n, f) => n + f.add, 0), del = this.items.reduce((n, f) => n + f.del, 0);
    const canCommit = Boolean(this.message.trim() && this.root && this.items.length && !this.busy && !this.loading);
    const button = (id, text, primary, enabled, tip, run) => div().id(id).h(28).px(12).flex_none().flex().items_center().rounded(3).text_size(12)
      .bg(primary && enabled ? t.solid : t.raised).text_color(primary && enabled ? t.solid_foreground : enabled ? t.foreground : t.dim)
      .when(enabled, (e) => e.cursor_pointer().hover((st) => st.opacity(0.88)).on_click((_e, cx) => run(cx))).tooltip(tip).child(text);
    // Section headers and rows share one scrolling list, so its height follows the count.
    const list = [], reviewing = this.scope === "agent" && Boolean(this.review);
    let listHeight;
    const since = this.review ? new Date(this.review.at) : null;
    const clock = since ? `${String(since.getHours()).padStart(2, "0")}:${String(since.getMinutes()).padStart(2, "0")}` : "";
    const segment = (id, text, on, tip) => div().id(`scope-${id}`).h(24).px(9).flex_initial().min_w(0).flex().items_center().rounded(3).text_size(11.5).cursor_pointer().truncate()
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((st) => st.text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => this.setScope(id, cx)).child(text);
    if (reviewing) {
      list.push(this.section("review", "Changed since it started", work, t, []));
      for (const f of work) list.push(this.fileRow(f, t, c));
      list.push(this.section("commits", "Its commits", this.review.log, t, []));
      for (const k of this.review.log) list.push(h_flex().id(`commit-${k.hash}`).h(26).flex_none().px(8).gap(8).items_center().text_size(12)
        .child(div().flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5).text_color(c.mod).child(k.hash))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(k.subject)));
      listHeight = work.length * 28 + this.review.log.length * 26 + 52 + 12 + (work.length ? 0 : 36);
    } else if (staged.length) {
      list.push(this.section("staged", "Staged Changes", staged, t, [
        this.action("unstage-all", "−", "Unstage all", t, (cx) => this.unstage(staged.map((f) => f.path), cx))]));
      for (const f of staged) list.push(this.fileRow(f, t, c));
    }
    if (!reviewing && (work.length || !staged.length)) {
      list.push(this.section("work", "Changes", work, t, work.length ? [
        this.action("discard-all", "↶", "Discard all changes", t, (cx) => this.askDiscard(work, cx)),
        this.action("stage-all", "+", "Stage all changes", t, (cx) => this.stage(work.map((f) => f.path), cx))] : []));
      for (const f of work) list.push(this.fileRow(f, t, c));
    }
    listHeight ??= (staged.length + work.length) * 28 + (staged.length ? 26 : 0) + (work.length || !staged.length ? 26 : 0) + 12;
    return v_flex().id("changes").size_full().min_h(0).rounded(3).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().child("Changes"))
        .when(Boolean(s), (e) => e.child(h_flex().id("branch-button").flex_initial().min_w(0).h(24).px(7).gap(5).items_center().rounded(3).cursor_pointer().text_size(12)
          .bg(this.picking ? t.selected : t.raised).text_color(t.foreground).hover((st) => st.opacity(0.88)).tooltip("Branches: switch, create, see worktrees")
          .on_click((_e, cx) => this.togglePicker(cx))
          .child(div().flex_initial().min_w(0).truncate().child(s.branch || "detached"))
          .child(div().flex_none().text_color(t.muted).child(this.picking ? "▴" : "▾"))))
        .child(div().flex_1())
        .child(div().flex_none().text_size(11).font_semibold().text_color(c.add).child(`+${add}`))
        .child(div().flex_none().text_size(11).font_semibold().text_color(c.del).child(`−${del}`)))
      // With an agent in focus: the working tree, or everything since that agent started.
      .when(Boolean(this.review), (el) => el.child(h_flex().flex_none().px(10).py(6).gap(4).items_center().border_b(1).border_color(t.border)
        .child(segment("work", "Working tree", !reviewing, "What is changed now: stage, commit, discard"))
        .child(segment("agent", `Since ${this.review.agent} started${this.review.commits ? ` · ${this.review.commits} commit(s)` : ""}`, reviewing,
          `Everything that changed in this folder since ${clock} (commit ${this.review.head.slice(0, 7)}), committed or not. Read-only.`))))
      // In a worktree, say so: it is the usual reason a branch "can't be entered" elsewhere.
      .when(Boolean(this.worktree), (el) => el.child(h_flex().flex_none().px(14).py(7).gap(8).items_center().border_b(1).border_color(t.border).bg(t.raised).text_size(11.5)
        .child(div().flex_1().min_w(0).text_color(t.muted).child(`This folder is a worktree: a separate copy of ${this.worktree.main.split("/").pop()} on the branch ${s?.branch || "(detached)"}. The main folder is ${tilde(this.worktree.main)}.`))
        .child(button("open-main", "Open main folder", false, true, "Open the main folder in a new tab", () => this.openFolder(this.worktree.main, this.worktree.main.split("/").pop())))))
      .when(this.picking, (el) => el.child(v_flex().flex_none().border_b(1).border_color(t.border)
        .child(div().px(14).pt(8).pb(4).text_size(11.5).font_medium().text_color(t.muted).child("Branches"))
        .child(v_flex().id("branch-list").max_h(196).overflow_y_scrollbar().px(6)
          .children((this.branches ?? []).map((b) => {
            const current = b.name === s?.branch;
            return h_flex().id(`branch-${b.name}`).h(28).flex_none().px(8).gap(8).items_center().rounded(3)
              .when(current, (e) => e.bg(t.selected))
              .when(!current && !b.worktree, (e) => e.cursor_pointer().hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.askSwitch(b.name, cx)))
              .child(div().w(12).flex_none().text_color(c.add).child(current ? "✓" : ""))
              .child(div().flex_initial().min_w(0).truncate().text_color(b.worktree ? t.muted : t.foreground).child(b.name))
              .when(Boolean(b.worktree), (e) => e
                .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(`in the worktree ${tilde(b.worktree)}`))
                .child(this.action(`open-${b.name}`, "↗", "Open that worktree in a new tab (git can't switch to it here)", t, () => this.openFolder(b.worktree, b.name))))
              .when(!b.worktree, (e) => e.child(div().flex_1()).child(div().flex_none().text_size(11.5).text_color(t.dim).child(current ? "current" : b.when ?? "")));
          }))
          .when(this.branches === null, (e) => e.child(div().p(8).text_size(12).text_color(t.dim).child("Loading branches…"))))
        .child(div().id("branch-new").mx(10).my(8).h(30).px(10).flex().items_center().rounded(3).border_1().border_color(t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.branchInput).h_full().text_size(12).text_color(t.foreground)))))
      // Message, Commit and the branch's Push / Pull, on top as in VS Code.
      .when(Boolean(this.root) && !reviewing, (el) => el.child(v_flex().flex_none().p(10).gap(8).border_b(1).border_color(t.border)
        .child(div().id("commit-message").h(32).px(10).flex().items_center().rounded(3).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(h_flex().gap(8).items_center()
          .child(button("commit", this.busy === "Commit" ? "Committing…" : staged.length ? `Commit ${staged.length} staged` : "Commit all", true, canCommit,
            staged.length ? "Commit the staged changes" : "Nothing is staged: commit every change", (cx) => this.askCommit(cx)))
          .child(div().flex_1())
          .when(Boolean(s?.upstream) && s.behind > 0, (e) => e.child(button("pull", this.busy === "Pull" ? "Pulling…" : `Pull ↓${s.behind}`, false, !this.busy, `Pull ${s.behind} commit(s) from the remote`, (cx) => this.askPull(cx))))
          .when(Boolean(s?.upstream) && s.ahead > 0, (e) => e.child(button("push", this.busy === "Push" ? "Pushing…" : `Push ↑${s.ahead}`, s.behind === 0, !this.busy, `Push ${s.ahead} commit(s) to the remote`, (cx) => this.askPush(cx))))
          .when(Boolean(s) && !s.upstream && Boolean(s.remote), (e) => e.child(button("publish", this.busy === "Push" ? "Publishing…" : "Publish branch", false, !this.busy, `Push ${s.branch} to ${s.remote} and track it`, (cx) => this.askPush(cx))))
          .when(Boolean(s?.upstream) && s.ahead === 0 && s.behind === 0, (e) => e.child(div().flex_none().text_size(11.5).text_color(t.dim).child("Up to date with the remote"))))))
      // The confirmation bar: nothing that can't be undone runs without a second click.
      .when(Boolean(this.confirm), (el) => el.child(h_flex().flex_none().px(14).py(8).gap(8).items_center().border_b(1).border_color(t.accent).bg(t.raised).text_size(12)
        .child(div().flex_1().min_w(0).child(this.confirm.text))
        .child(button("confirm-yes", this.confirm.label, true, true, this.confirm.label, (cx) => { const run = this.confirm.run; this.confirm = null; run(cx); }))
        .child(button("confirm-cancel", "Cancel", false, true, "Do nothing", (cx) => { this.confirm = null; cx.notify(); }))))
      .when(Boolean(this.note), (e) => e.child(h_flex().flex_none().px(14).py(6).gap(8).border_b(1).border_color(t.border).text_size(11.5)
        .child(div().flex_1().min_w(0).text_color(c.del).child(this.note))
        .child(div().id("note-close").flex_none().px(4).cursor_pointer().text_color(t.dim).hover((st) => st.text_color(t.foreground)).on_click((_e, cx) => { this.note = null; cx.notify(); }).child("×"))))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(70).max_h(listHeight).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(list)
          .when(!this.items.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : reviewing ? "" : this.root ? "No changes: the working tree is clean" : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12.5)
        .child(div().id("changes-diff-box").size_full()
          .on_size_change((size, cx) => {
            const cols = Math.max(20, Math.floor((size.width - GUTTER - 16) / CHAR));
            if (cols !== this.cols) { this.cols = cols; this.layout(); cx.notify(); }
          })
          .child(v_virtual_list("changes-diff", this.visual.length, ROW, (i) => String(i),
            (range) => this.visual.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full()))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.items.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))));
  }
}
