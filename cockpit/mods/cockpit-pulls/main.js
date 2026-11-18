// Open pull requests of the focused folder's GitHub repository, grouped like the
// VS Code GitHub Pull Requests extension: local branches, waiting for my review,
// created by me, all open. One `gh pr list` per repository; a click opens the PR.
// Idea from lw396/herdr-plugin-github (Apache-2.0); no code is copied from it.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, theme, window, checking } from "herdr";

const DIR = "mods/cockpit-pulls";
const LIMIT = 100; // gh pr list cap: more open PRs than this shows as "100+"
const POLL = 120000; // ms; PRs change slowly and the copy keeps running while hidden
const FIELDS = "number,title,url,isDraft,author,headRefName,reviewRequests,updatedAt";
const GROUPS = [
  { id: "local", title: "Local Pull Request Branches", empty: "No open pull request for a local branch" },
  { id: "review", title: "Waiting For My Review", empty: "Nothing waiting for your review" },
  { id: "mine", title: "Created By Me", empty: "No open pull request of yours" },
  { id: "all", title: "All Open", empty: "No open pull requests" },
];

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on };
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / (86400 * 30))}mo`;
}

const run = (cmd, args, cwd, on) =>
  exec(cmd, args, { cwd, on, timeout: 30000 }).catch((e) => ({ code: 1, stdout: "", stderr: String(e.message || e) }));

export default class Pulls extends View {
  init(_props, cx) {
    this.cache = new Map(); // repository root → { repo, pulls, groups, error, at }
    this.login = new Map(); // machine → gh login
    this.loading = false;
    try { this.open = JSON.parse(localStorage.getItem("open") ?? "null") ?? { all: true }; } catch { this.open = { all: true }; }
    this.load(cx);
    if (checking()) return;
    cx.timer.every(POLL, (cx) => this.load(cx, true));
  }

  // Where the focused folder's repository is; a new place loads, a known one shows its last list.
  load(cx, force = false) {
    const { cwd, on } = location();
    const key = JSON.stringify({ cwd, on });
    if (!force && key === this.key) return;
    this.key = key;
    if (!cwd) { this.root = null; cx.notify(); return; }
    cx.spawn(async (cx) => {
      const top = await run("git", ["rev-parse", "--show-toplevel"], cwd, on);
      if (this.key !== key) return;
      this.root = top.code === 0 ? JSON.stringify({ root: top.stdout.trim(), on }) : null;
      cx.notify();
      if (!this.root || (!force && this.cache.has(this.root))) return;
      await this.fetch(top.stdout.trim(), on, this.root, cx);
    });
  }

  async fetch(root, on, id, cx) {
    this.loading = true; cx.notify();
    try {
      if (!this.login.has(on)) {
        const me = await run("gh", ["api", "user", "--jq", ".login"], root, on);
        if (me.code === 0) this.login.set(on, me.stdout.trim());
      }
      const [repo, list, heads] = await Promise.all([
        run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], root, on),
        run("gh", ["pr", "list", "--state", "open", "--limit", String(LIMIT), "--json", FIELDS], root, on),
        run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], root, on),
      ]);
      if (list.code !== 0) {
        const why = (list.stderr || repo.stderr || "").trim();
        this.cache.set(id, { repo: repo.stdout.trim(), error: /no git remotes|not a git|none of the git remotes/i.test(why) ? "This repository has no GitHub remote." : why || "gh couldn't list pull requests." });
        return;
      }
      const pulls = JSON.parse(list.stdout || "[]");
      const me = (this.login.get(on) ?? "").toLowerCase();
      const branches = new Set(heads.stdout.split("\n").filter(Boolean));
      const groups = {
        local: pulls.filter((p) => branches.has(p.headRefName)),
        review: pulls.filter((p) => me && (p.reviewRequests ?? []).some((r) => r.login?.toLowerCase() === me)),
        mine: pulls.filter((p) => me && p.author?.login?.toLowerCase() === me),
        all: pulls,
      };
      this.cache.set(id, { repo: repo.stdout.trim(), groups, capped: pulls.length >= LIMIT, error: null });
    } catch (e) {
      this.cache.set(id, { error: String(e.message || e) });
    } finally {
      this.loading = false;
      cx.notify();
    }
  }

  toggle(id, cx) {
    this.open = { ...this.open, [id]: !this.open[id] };
    localStorage.setItem("open", JSON.stringify(this.open));
    cx.notify();
  }

  // Opens on this computer: a remote machine has no browser of its own to show it.
  openPull(p) {
    const opener = window()?.platform === "windows" ? ["cmd", ["/c", "start", "", p.url]] : window()?.platform === "linux" ? ["xdg-open", [p.url]] : ["open", [p.url]];
    exec(...opener).catch(() => {});
  }

  row(p, t) {
    return h_flex().id(`pr-${p.number}`).h(28).flex_none().px(8).gap(8).items_center().rounded(3)
      .hover((s) => s.bg(t.hover)).on_click(() => this.openPull(p)).tooltip(`#${p.number} ${p.title}\nOpen on GitHub`)
      .child(svg(`${DIR}/${p.isDraft ? "git-pull-request-draft" : "git-pull-request"}.svg`).size(14).flex_none().text_color(p.isDraft ? t.dim : t.done))
      .child(div().flex_1().min_w(0).truncate().text_color(p.isDraft ? t.muted : t.foreground)
        .child(`#${p.number} ${p.title}`))
      .child(div().flex_none().max_w(110).truncate().text_size(12).text_color(t.dim)
        .child(p.author?.login ? `@${p.author.login}` : "ghost"))
      .child(div().flex_none().w(30).text_right().text_size(12).text_color(t.dim).child(ago(p.updatedAt)));
  }

  group(g, rows, capped, t) {
    const open = Boolean(this.open[g.id]);
    const count = g.id === "all" && capped ? `${rows.length}+` : String(rows.length);
    const el = v_flex().flex_none()
      .child(h_flex().id(`group-${g.id}`).h(26).px(6).gap(6).items_center().rounded(3).text_size(12).text_color(t.dim)
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.toggle(g.id, cx))
        .child(svg(`${DIR}/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(g.title))
        .child(div().flex_none().child(count)));
    if (!open) return el;
    if (!rows.length) return el.child(div().pl(26).py(4).text_size(12).text_color(t.dim).child(g.empty));
    return el.children(rows.map((p) => this.row(p, t)));
  }

  render(cx) {
    const t = theme();
    if (JSON.stringify(location()) !== this.key) this.load(cx);
    const data = this.root ? this.cache.get(this.root) : null;
    const message = (text) => div().p(14).text_size(12).text_color(t.dim).child(text);
    let body;
    if (!this.root) body = message("Focus a terminal inside a Git repository to see its pull requests.");
    else if (!data) body = message("Loading pull requests…");
    else if (data.error) body = message(data.error);
    else body = v_flex().id("pr-list").flex_1().min_h(0).p(6).gap(2).overflow_y_scrollbar()
      .children(GROUPS.map((g) => this.group(g, data.groups[g.id], data.capped, t)));

    return v_flex().id("pulls").size_full().min_h(0).rounded(3).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().child("Pull Requests"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(data?.repo ?? ""))
        .child(div().id("pr-refresh").flex_none().px(4).rounded(3).text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .tooltip(this.loading ? "Refreshing…" : "Refresh")
          .on_click((_e, cx) => { if (!this.loading) this.load(cx, true); })
          .child(this.loading ? div().child("⠋").frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90) : div().child("↻"))))
      .child(body);
  }
}
