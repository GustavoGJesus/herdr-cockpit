// Every worktree of the focused folder's repository, in one list: the folder, its branch,
// the agents working in it, uncommitted changes, commits ahead of the main branch and its
// pull request. A worktree is a second folder of the same repository on another branch;
// agents make them to work side by side, and git won't check their branch out anywhere else.
// A click goes to the agent there (or opens the folder in a tab); a finished one is removed here.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, theme, settings, run, home, checking } from "herdr";

const POLL = 30000; // ms: the copy keeps running while hidden
// Reads write nothing under .git, so no folder watch wakes up because of them.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const STATUS = { working: "working", blocked: "blocked", done: "done", idle: "idle" };

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on };
}
const tilde = (path) => (path.startsWith(home()) ? `~${path.slice(home().length)}` : path);
const inside = (cwd, path) => cwd === path || cwd.startsWith(path + "/");

export default class Worktrees extends View {
  init(_props, cx) {
    this.trees = null; this.error = null; this.note = null; this.confirm = null; this.hovered = null; this.loading = false;
    this.load(cx);
    if (checking()) return;
    cx.timer.every(POLL, (cx) => this.load(cx, true));
  }

  load(cx, force = false) {
    const { cwd, on } = location(), key = JSON.stringify({ cwd, on });
    if (!force && key === this.key) return;
    if (this.loading) { this.again = true; return; }
    if (key !== this.key) { this.confirm = null; this.note = null; }
    this.key = key;
    if (!cwd) { this.trees = null; this.error = "No folder"; cx.notify(); return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const git = (args, at = cwd) => exec("git", [...READ, ...args], { cwd: at, on }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
        const list = await git(["worktree", "list", "--porcelain"]);
        if (this.key !== key) return;
        if (list.code !== 0) { this.trees = null; this.error = "Not a git repository"; return; }
        const trees = [];
        for (const block of list.stdout.split("\n\n")) {
          const tree = {};
          for (const line of block.split("\n")) {
            if (line.startsWith("worktree ")) tree.path = line.slice(9);
            else if (line.startsWith("branch refs/heads/")) tree.branch = line.slice(18);
            else if (line === "detached") tree.detached = true;
            else if (line === "bare") tree.bare = true;
            else if (line.startsWith("prunable")) tree.missing = true;
          }
          if (tree.path && !tree.bare) trees.push(tree);
        }
        // The first one listed is the main folder; the others are compared with its branch.
        const main = trees[0];
        if (main) main.main = true;
        await Promise.all(trees.map(async (tree) => {
          if (tree.missing) return;
          const [status, last, ahead] = await Promise.all([
            git(["status", "--porcelain", "--untracked-files=normal"], tree.path),
            git(["log", "-1", "--format=%cr"], tree.path),
            !tree.main && main?.branch && tree.branch ? git(["rev-list", "--left-right", "--count", `${main.branch}...${tree.branch}`]) : null,
          ]);
          tree.dirty = status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : 0;
          tree.last = last.stdout.trim();
          if (ahead?.code === 0) [tree.behind, tree.ahead] = ahead.stdout.trim().split(/\s+/).map(Number);
        }));
        // Pull requests by branch, when gh is there and signed in; without it the column is empty.
        const prs = await exec("gh", ["pr", "list", "--state", "all", "--limit", "100", "--json", "number,headRefName,state,isDraft,url"], { cwd, on }).catch(() => null);
        if (prs?.code === 0) {
          const byBranch = {};
          for (const pr of JSON.parse(prs.stdout || "[]")) byBranch[pr.headRefName] ??= pr; // newest first
          for (const tree of trees) if (tree.branch && !tree.main) tree.pr = byBranch[tree.branch] ?? null;
        }
        if (this.key !== key) return;
        this.trees = trees; this.here = cwd; this.on = on; this.error = null;
      } catch (e) { if (this.key === key) this.error = String(e.message || e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.load(cx, true); }
      }
    });
  }

  // The agents in each worktree: a pane belongs to the deepest worktree its folder is in
  // (a worktree can live inside the main folder, e.g. .claude/worktrees/x).
  agentsIn(tree) {
    const paths = (this.trees ?? []).map((w) => w.path);
    return panes().filter((p) => p.program?.agent && p.cwd && !(p.terminal ?? "").includes("/") === !this.on
      && paths.filter((path) => inside(p.cwd, path)).sort((a, b) => b.length - a.length)[0] === tree.path);
  }

  open(tree) {
    const agent = this.agentsIn(tree)[0];
    if (agent) run("pane.focus", { pane: agent.pane });
    else run("tab.new", { folder: tree.path, name: tree.branch || tree.path.split("/").pop() });
  }

  // Removing deletes the folder, never the branch. Refused while it has uncommitted changes
  // or an agent in it: those are the two ways to lose work here.
  askRemove(tree, cx) {
    const agents = this.agentsIn(tree).length, name = tree.path.split("/").pop();
    if (agents) this.note = `${name} has ${agents} agent(s) working in it. Close them first.`;
    else if (tree.dirty) this.note = `${name} has ${tree.dirty} uncommitted change(s). Commit or discard them first.`;
    else { this.note = null; this.confirm = tree; }
    cx.notify();
  }

  remove(cx) {
    const tree = this.confirm, main = this.trees?.[0];
    if (!tree || !main) return;
    this.confirm = null;
    cx.spawn(async (cx) => {
      const r = await exec("git", ["worktree", "remove", tree.path], { cwd: main.path, on: this.on }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.note = r.code === 0 ? `Removed the worktree ${tree.path.split("/").pop()}. The branch ${tree.branch ?? ""} is still there.` : `Could not remove it: ${(r.stderr || "").trim()}`;
      this.load(cx, true);
      cx.notify();
    });
  }

  action(id, glyph, tip, t, run) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(3).cursor_pointer().text_size(13).text_color(t.muted)
      .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); run(cx); })
      .child(glyph);
  }

  row(tree, t) {
    const here = this.here && (this.trees ?? []).map((w) => w.path).filter((path) => inside(this.here, path)).sort((a, b) => b.length - a.length)[0] === tree.path;
    const agents = this.agentsIn(tree), hot = this.hovered === tree.path;
    const badge = (text, color) => div().flex_none().px(5).rounded(3).bg(t.raised).text_size(10.5).text_color(color ?? t.muted).child(text);
    const fact = (text, color) => div().flex_none().text_color(color ?? t.dim).child(text);
    const pr = tree.pr, prColor = !pr ? t.dim : pr.state === "MERGED" ? "#a371f7" : pr.state === "CLOSED" ? "#f85149" : pr.isDraft ? t.muted : "#3fb950";
    return v_flex().id(`tree-${tree.path}`).flex_none().px(10).py(7).gap(4).rounded(3).cursor_pointer()
      .when(here, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => { if (on) this.hovered = tree.path; else if (this.hovered === tree.path) this.hovered = null; cx.notify(); })
      .on_click(() => this.open(tree))
      .tooltip(agents.length ? "Go to the agent working here" : "Open this folder in a new tab")
      .child(h_flex().gap(7).items_center().h(22)
        .child(div().flex_initial().min_w(0).truncate().font_medium().text_color(tree.missing ? t.dim : t.foreground).child(tree.branch || (tree.detached ? "detached" : "no branch")))
        .when(tree.main, (e) => e.child(badge("main folder")))
        .when(here, (e) => e.child(badge("you are here", t.accent)))
        .when(tree.missing, (e) => e.child(badge("folder missing", "#f85149")))
        .child(div().flex_1())
        .when(hot && !tree.missing, (e) => e.child(this.action(`tab-${tree.path}`, "↗", "Open this folder in a new tab", t, () => run("tab.new", { folder: tree.path, name: tree.branch || tree.path.split("/").pop() }))))
        .when(hot && !tree.main, (e) => e.child(this.action(`remove-${tree.path}`, "×", "Remove this worktree (the branch stays)", t, (cx) => this.askRemove(tree, cx)))))
      .when(agents.length > 0, (e) => e.child(h_flex().gap(10).flex_wrap().text_size(12)
        .children(agents.map((a) => h_flex().gap(5).items_center()
          .child(div().size(7).flex_none().rounded(3).bg(t[STATUS[a.status] ?? "idle"]))
          .child(div().max_w(220).truncate().text_color(t.muted).child(`${a.program.name}${a.status ? ` · ${a.status}` : ""}`))))))
      .child(h_flex().gap(10).items_center().text_size(11.5)
        .child(div().flex_initial().min_w(0).truncate().text_color(t.dim).child(tilde(tree.path)))
        .when(tree.dirty > 0, (e) => e.child(fact(`${tree.dirty} uncommitted`, "#e3b341")))
        .when(tree.ahead > 0, (e) => e.child(fact(`↑${tree.ahead} ahead`)))
        .when(tree.behind > 0, (e) => e.child(fact(`↓${tree.behind} behind`)))
        .when(Boolean(pr), (e) => e.child(fact(`PR #${pr.number} ${pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase()}`, prColor)))
        .when(Boolean(tree.last), (e) => e.child(fact(tree.last))));
  }

  render(cx) {
    const t = theme();
    if (JSON.stringify(location()) !== this.key) this.load(cx);
    const button = (id, text, primary, run) => div().id(id).h(26).px(10).flex_none().flex().items_center().rounded(3).text_size(12).cursor_pointer()
      .bg(primary ? t.solid : t.background).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.88)).on_click((_e, cx) => run(cx)).child(text);
    const trees = this.trees ?? [], linked = trees.length - 1;
    return v_flex().id("worktrees").size_full().min_h(0).rounded(3).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().child("Worktrees"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(trees[0] ? trees[0].path.split("/").pop() : ""))
        .child(div().id("wt-refresh").flex_none().px(4).rounded(3).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .tooltip(this.loading ? "Refreshing…" : "Refresh").on_click((_e, cx) => this.load(cx, true))
          .child(this.loading ? div().child("⠋").frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90) : div().child("↻"))))
      .when(Boolean(this.confirm), (el) => el.child(h_flex().flex_none().px(14).py(8).gap(8).items_center().border_b(1).border_color(t.accent).bg(t.raised).text_size(12)
        .child(div().flex_1().min_w(0).child(`Remove the worktree ${tilde(this.confirm.path)}? The folder is deleted; the branch ${this.confirm.branch ?? ""} and its commits stay.`))
        .child(button("wt-remove-yes", "Remove", true, (cx) => this.remove(cx)))
        .child(button("wt-remove-no", "Cancel", false, (cx) => { this.confirm = null; cx.notify(); }))))
      .when(Boolean(this.note), (el) => el.child(h_flex().flex_none().px(14).py(7).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_1().min_w(0).text_color(t.muted).child(this.note))
        .child(div().id("wt-note-close").flex_none().px(4).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.note = null; cx.notify(); }).child("×"))))
      .when(!this.trees, (el) => el.child(div().p(14).text_size(12).text_color(t.dim).child(this.error || "Loading worktrees…")))
      .when(Boolean(this.trees), (el) => el.child(v_flex().id("wt-list").flex_1().min_h(0).p(6).gap(2).overflow_y_scrollbar()
        .children(trees.map((tree) => this.row(tree, t)))
        .when(linked === 0, (e) => e.child(div().px(10).py(8).text_size(12).text_color(t.dim)
          .child("Only the main folder: no other worktree. When an agent (or Herdr's New worktree) makes one, it shows up here with its branch and who is working in it.")))));
  }
}
