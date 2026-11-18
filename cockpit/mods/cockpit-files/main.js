// A lazy file browser for the focused pane's folder. On this computer a file opens in an
// editor (cmd+s or ctrl+s saves) and the header makes new files and folders; on another
// machine files are read-only previews, because Herdr only writes local files.
// A right-click (cockpit-file-menu) renames, deletes or makes entries; dragging a row onto a
// folder moves it there. Those run as programs (mv, mkdir, touch, trash) on the folder's machine.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, nextCommand, checking, openOverlay, shared } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());

// Vivid git status colors (GitHub's), one set per appearance: the theme's ANSI
// green and red read too faint for added, modified and deleted files.
// cockpit-changes has the same table (mods cannot import each other): keep both in step.
function gitColors() {
  return settings()?.dark === false
    ? { add: "#1a7f37", mod: "#9a6700", del: "#cf222e" }
    : { add: "#3fb950", mod: "#e3b341", del: "#f85149" };
}
// Code colors for the file preview, the same as cockpit-changes paints over its diff rows.
function syntaxColors() {
  return settings()?.dark === false
    ? { keyword: "#cf222e", string: "#0a3069", number: "#0550ae", constant: "#0550ae", function: "#8250df", type: "#953800", comment: "#6e7781" }
    : { keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9", constant: "#bd93f9", function: "#50fa7b", type: "#8be9fd", comment: "#8b949e" };
}
const markColor = (c, mark) => (mark === "A" || mark === "A•" || mark === "?" ? c.add : mark === "D" || mark === "U" ? c.del : c.mod);
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const MAX_EDIT = 400000; // characters; a longer file opens truncated and read-only

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.dirty = false; this.note = null; this.target = ""; this.selected = null; this.creating = null;
    this.drag = null; this.over = null; this.deleting = null; this.treeNote = null;
    // Menu choices made before this copy started are not replayed.
    this.lastAction = shared("cockpit-files.action")?.id ?? 0;
    this.handle = cx.focus_handle();
    this.nameInput = InputState.new({ placeholder: "name, or path/name" });
    this.nameInput.on("submit", (_e, cx) => this.create(cx));
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    if (checking()) return;
    // keys.json binds cmd-s / ctrl-s to "cockpit-files.save" while this panel has the keyboard.
    // "cockpit-files.expand" unfolds every folder, as an editor's Expand All does.
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "save") this.save(cx);
        else if (command === "expand") cx.spawn(cx => this.expandAll(cx));
      }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      // Unsaved edits keep the panel on their file: following the focus would drop them.
      if (this.dirty) return;
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false; this.target = ""; this.selected = null; this.creating = null; this.drag = null; this.over = null; this.deleting = null; this.treeNote = null;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  // Unfolds the whole tree, breadth first, up to 200 folders; dependency folders stay shut.
  async expandAll(cx) {
    const context = this.context, queue = [""];
    while (queue.length && this.folders.size < 200 && this.current(context)) {
      const path = queue.shift();
      if (path) {
        this.folders.add(path);
        if (!this.entries.has(path)) await this.loadFolder(path, context).catch(() => {});
      }
      for (const entry of this.entries.get(path) ?? []) if (entry.dir && !["node_modules", "target", "dist"].includes(entry.name)) queue.push(path ? `${path}/${entry.name}` : entry.name);
    }
    cx.notify();
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    this.dirty = false; this.original = null; this.editable = false; this.note = null; this.leaving = false;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const ext = path.includes(".") ? path.split(".").pop() : "txt";
        // Only a whole local file is edited: a truncated one would be saved cut short.
        this.editable = !on && text.length <= MAX_EDIT;
        this.original = text;
        const code = EditorState.new({ language: LANG[ext] ?? ext, readonly: !this.editable,
          value: text.length > MAX_EDIT ? text.slice(0, MAX_EDIT) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12, soft_wrap: true,
          syntax: syntaxColors() });
        code.on("change", (_e, cx) => {
          const dirty = code.value() !== this.original;
          if (dirty !== this.dirty || this.note) { this.dirty = dirty; this.note = null; cx.notify(); }
        });
        this.code = code;
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // Writes the editor's text back. The write is refused when the file changed on disk since
  // it was read, so an agent's edit is never silently overwritten.
  save(cx) {
    if (!this.code || !this.editable || !this.dirty || this.saving) return;
    const path = this.file, value = this.code.value(), abs = `${this.root}/${path}`;
    this.saving = true;
    cx.spawn(async cx => {
      try {
        await writeTextFile(abs, value, this.original);
        if (this.file !== path) return;
        this.original = value; this.dirty = this.code.value() !== value; this.leaving = false;
        this.note = { text: "Saved", ok: true };
      } catch (e) {
        if (this.file === path) this.note = { text: /stale|match|changed/i.test(String(e)) ? "The file changed on disk since you opened it. Discard to load the new version." : `Could not save: ${e.message || e}`, ok: false };
      } finally { this.saving = false; cx.notify(); }
    });
  }

  // Leaves the open file; with unsaved edits it asks first (the bar under the header).
  close(cx) {
    if (this.dirty && !this.leaving) { this.leaving = true; cx.notify(); return; }
    this.show(null); this.refresh(cx); cx.notify();
  }

  discard(cx) {
    const path = this.file;
    this.show(this.leaving ? null : path, cx);
    cx.notify();
  }

  // The row the person touched last (clicked, right-clicked, made, renamed or moved) is the
  // highlighted one. New entries go into it when it is a folder, else beside it.
  select(path, dir) {
    this.selected = path;
    this.target = dir ? path : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  }

  startCreate(kind, cx) {
    this.creating = kind; this.createError = null; this.deleting = null; this.treeNote = null;
    this.nameInput.set_value("");
    this.nameInput.focus();
    cx.notify();
  }

  startRename(path, cx) {
    const name = path.split("/").pop(), dot = name.lastIndexOf(".");
    this.creating = "rename"; this.renaming = path; this.createError = null; this.deleting = null; this.treeNote = null;
    this.nameInput.set_value(name);
    // The name without its extension is selected, as editors do.
    this.nameInput.set_selected_range({ start: 0, end: dot > 0 ? dot : name.length });
    this.nameInput.focus();
    cx.notify();
  }

  // Runs a program where the folder is; a failure is an Error with the program's own words.
  async sh(cmd, args) {
    const r = await exec(cmd, args, { on: this.on });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `${cmd} failed`);
    return r;
  }

  async exists(abs) {
    return (await exec("test", ["-e", abs], { on: this.on })).code === 0;
  }

  // After something moved or went away: forget folders that are no longer there and list again.
  reloadTree(cx, gone) {
    if (gone) for (const f of [...this.folders]) if (f === gone || f.startsWith(gone + "/")) { this.folders.delete(f); this.entries.delete(f); }
    if (gone && (this.target === gone || this.target.startsWith(gone + "/"))) this.target = "";
    if (gone && this.selected && (this.selected === gone || this.selected.startsWith(gone + "/"))) this.selected = null;
    this.loading = false; this.refresh(cx);
  }

  // The naming bar's Enter: makes the file or folder inside the folder clicked last (the root
  // before any click), or renames. Parents in "a/b/name" are made too; nothing existing is replaced.
  create(cx) {
    const kind = this.creating, name = this.nameInput.value().trim().replace(/^\.\//, "");
    if (!kind || !name) return;
    const context = this.context;
    if (kind === "rename") {
      const from = this.renaming, parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
      if (name.includes("/") || name === "." || name === "..") { this.createError = "A name can't contain / (drag the row to move it)"; cx.notify(); return; }
      const to = parent ? `${parent}/${name}` : name;
      if (to === from) { this.creating = null; cx.notify(); return; }
      cx.spawn(async cx => {
        try {
          if (await this.exists(`${this.root}/${to}`)) throw new Error(`${name} already exists`);
          await this.sh("mv", [`${this.root}/${from}`, `${this.root}/${to}`]);
          if (!this.current(context)) return;
          this.creating = null; this.createError = null;
          const wasDir = this.folders.has(from) || (this.entries.get(parent) ?? []).some(e => e.name === from.split("/").pop() && e.dir);
          this.reloadTree(cx, from);
          this.select(to, wasDir);
        } catch (e) { this.createError = String(e.message || e); }
        finally { cx.notify(); }
      });
      return;
    }
    if (name.startsWith("/") || name.split("/").some(part => part === ".." || part === "")) { this.createError = "Use a name or a relative path, without .."; cx.notify(); return; }
    const rel = this.target ? `${this.target}/${name}` : name, abs = `${this.root}/${rel}`;
    cx.spawn(async cx => {
      try {
        if (await this.exists(abs)) throw new Error(`${name} already exists`);
        await this.sh("mkdir", ["-p", kind === "folder" ? abs : abs.slice(0, abs.lastIndexOf("/"))]);
        if (kind === "file") await this.sh("touch", [abs]);
        if (!this.current(context)) return;
        // Unfold down to the new entry so it is on screen.
        const parts = rel.split("/"), upTo = kind === "folder" ? parts.length : parts.length - 1;
        for (let n = 1; n <= upTo; n++) this.folders.add(parts.slice(0, n).join("/"));
        this.creating = null; this.createError = null;
        if (kind === "file") this.show(rel, cx);
        this.reloadTree(cx);
        this.select(rel, kind === "folder");
      } catch (e) { this.createError = String(e.message || e); }
      finally { cx.notify(); }
    });
  }

  // Deletes after the confirmation bar. On this Mac the entry goes to the Trash, where it can
  // be put back; elsewhere (another machine, no `trash` program) it is removed for good.
  remove(cx) {
    const { path } = this.deleting ?? {}, context = this.context;
    if (!path) return;
    cx.spawn(async cx => {
      try {
        const abs = `${this.root}/${path}`;
        if (this.trashes()) await this.sh("trash", [abs]); else await this.sh("rm", ["-rf", "--", abs]);
        if (!this.current(context)) return;
        this.deleting = null; this.treeNote = { text: `${this.trashes() ? "Moved to the Trash" : "Deleted"}: ${path}`, ok: true };
        this.reloadTree(cx, path);
      } catch (e) { this.deleting = null; this.treeNote = { text: `Could not delete: ${e.message || e}`, ok: false }; }
      finally { cx.notify(); }
    });
  }

  trashes() {
    return !this.on && window()?.platform === "macos";
  }

  // A drop: moves `from` into the folder `dest` ("" is the root). Never onto itself, into its
  // own subtree, or over an entry of the same name.
  move(from, dest, cx) {
    const name = from.split("/").pop(), parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    if (dest === parent || dest === from || dest.startsWith(from + "/")) return;
    const to = dest ? `${dest}/${name}` : name, context = this.context;
    cx.spawn(async cx => {
      try {
        if (await this.exists(`${this.root}/${to}`)) throw new Error(`${dest || "the root"} already has ${name}`);
        await this.sh("mv", [`${this.root}/${from}`, `${this.root}/${to}`]);
        if (!this.current(context)) return;
        if (dest) this.folders.add(dest);
        // A slip of the hand is one click away from undone.
        this.treeNote = { text: `Moved ${name} to ${dest || this.root.split("/").pop()}/`, ok: true, undo: { from: to, dest: parent } };
        const wasDir = this.folders.has(from) || (this.entries.get(parent) ?? []).some(e => e.name === name && e.dir);
        this.reloadTree(cx, from);
        // The moved entry keeps the highlight, in its new place.
        this.select(to, wasDir);
      } catch (e) { this.treeNote = { text: `Could not move: ${e.message || e}`, ok: false }; }
      finally { cx.notify(); }
    });
  }

  menu(path, entry) {
    this.select(path, entry.dir);
    openOverlay({ mod: "cockpit-file-menu", kind: "popup", frame: "none", width: 210, height: 186,
      props: { path, abs: `${this.root}/${path}`, name: entry.name, dir: entry.dir } });
  }

  // A choice from the right-click menu (shared "cockpit-files.action"), handled once.
  act(a, cx) {
    if (a.action === "rename") this.startRename(a.path, cx);
    else if (a.action === "delete") { this.deleting = { path: a.path, dir: a.dir }; this.creating = null; this.treeNote = null; }
    else if (a.action === "new-file" || a.action === "new-folder") {
      this.select(a.path, a.dir);
      this.startCreate(a.action === "new-file" ? "file" : "folder", cx);
    }
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      // A folder with changes inside takes their color: green when all are new, amber otherwise.
      let mark = this.marks[`${this.root}/${path}`];
      if (!mark && entry.dir) {
        const inside = Object.entries(this.marks).filter(([k]) => k.startsWith(`${this.root}/${path}/`)).map(([, m]) => m);
        if (inside.length) mark = inside.every((m) => m === "A") ? "A•" : "•";
      }
      // A drop lands in the row's folder: the folder itself, or the one a file is in.
      const dest = entry.dir ? path : prefix, dragging = this.drag && this.over !== null;
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(3).cursor_pointer().hover(s => s.bg(t.hover))
        .when(this.selected === path, el => el.bg(t.selected))
        .when(dragging && entry.dir && this.over === path, el => el.bg(t.selected).border_1().border_color(t.accent))
        .when(dragging && this.drag.path === path, el => el.opacity(0.45))
        .on_mouse_down("right", () => this.menu(path, entry))
        .on_mouse_down("left", () => { this.drag = { path }; this.over = null; })
        .on_mouse_move((_e, cx) => {
          if (!this.drag) return;
          cx.stop_propagation();
          const over = this.drag.path === path ? this.over : dest;
          if (over !== this.over) { this.over = over; cx.notify(); }
        })
        .on_mouse_up("left", (_e, cx) => {
          const drag = this.drag, over = this.over;
          this.drag = null; this.over = null;
          if (drag && over !== null && drag.path !== path) this.move(drag.path, over, cx);
          cx.notify();
        })
        .on_click((_e, cx) => { this.select(path, entry.dir); if (entry.dir) this.toggle(path, cx); else this.show(path, cx); })
        .child(entry.dir ? svg(`mods/cockpit-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/cockpit-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().when(Boolean(mark), el => el.text_color(markColor(gitColors(), mark))).child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).font_semibold().text_color(markColor(gitColors(), mark)).child(mark.endsWith("•") ? "•" : mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), local = Boolean(this.root);
    const action = shared("cockpit-files.action");
    if (action?.id && action.id !== this.lastAction) { this.lastAction = action.id; if (this.root && !this.file) this.act(action, cx); }
    const iconButton = (id, icon, tip, action) => div().id(id).flex_none().p(3).rounded(3).cursor_pointer().text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(action).child(svg(`mods/cockpit-files/${icon}.svg`).size(15));
    const textButton = (id, text, primary, action) => div().id(id).flex_none().h(22).px(8).flex().items_center().rounded(3).text_size(11.5).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover(s => s.opacity(0.85)).on_click(action).child(text);
    const where = this.target ? `${this.target}/` : `${this.root?.split(/[\\/]/).pop() ?? ""}/`;
    return v_flex().id("files").size_full().min_h(0).rounded(3).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if ((e.modifiers.platform || e.modifiers.control) && e.key === "s" && this.file) { this.save(cx); cx.stop_propagation(); }
        else if (e.key === "escape" && this.creating) { this.creating = null; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground)).on_click((_e, cx) => this.close(cx)).child("←")))
        .child(div().flex_none().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(this.dirty ? t.foreground : t.dim)
          .child(this.file ? `${this.dirty ? "● " : ""}${this.file}` : this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(this.file) && this.editable, el => el.child(textButton("files-save", this.saving ? "Saving…" : this.note?.ok && !this.dirty ? "Saved" : "Save", this.dirty, (_e, cx) => this.save(cx)).when(!this.dirty, b => b.opacity(0.5)).tooltip("Save (cmd+s / ctrl+s)")))
        .when(!this.file && local, el => el
          .child(iconButton("files-new-file", "file-plus", `New file in ${where}`, (_e, cx) => this.startCreate("file", cx)))
          .child(iconButton("files-new-folder", "folder-plus", `New folder in ${where}`, (_e, cx) => this.startCreate("folder", cx)))))
      // Unsaved edits, when leaving the file: nothing is dropped without a click.
      .when(Boolean(this.file) && this.leaving, el => el.child(h_flex().flex_none().px(14).py(8).gap(8).items_center().border_b(1).border_color(t.border).bg(t.raised).text_size(12)
        .child(div().flex_1().min_w(0).truncate().child("Unsaved changes"))
        .child(textButton("files-leave-save", "Save", true, (_e, cx) => this.save(cx)))
        .child(textButton("files-leave-discard", "Discard", false, (_e, cx) => this.discard(cx)))
        .child(textButton("files-leave-cancel", "Keep editing", false, (_e, cx) => { this.leaving = false; cx.notify(); }))))
      .when(Boolean(this.file) && Boolean(this.note) && !this.note.ok, el => el.child(h_flex().flex_none().px(14).py(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_1().min_w(0).text_color(gitColors().del).child(this.note.text))
        .child(textButton("files-note-discard", "Discard", false, (_e, cx) => { this.leaving = false; this.discard(cx); }))))
      // Naming a new file or folder: Enter creates it, Escape gives up.
      .when(!this.file && Boolean(this.creating), el => el.child(v_flex().flex_none().px(14).py(8).gap(6).border_b(1).border_color(t.border).bg(t.raised)
        .child(div().text_size(11.5).text_color(t.muted).child(this.creating === "rename" ? `Rename ${this.renaming}` : `New ${this.creating} in ${where}`))
        .child(h_flex().gap(8).items_center()
          .child(div().id("files-name").flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(3).border_1().border_color(t.accent).bg(t.background).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.nameInput)))
          .child(textButton("files-create", this.creating === "rename" ? "Rename" : "Create", true, (_e, cx) => this.create(cx)))
          .child(textButton("files-create-cancel", "Cancel", false, (_e, cx) => { this.creating = null; cx.notify(); })))
        .when(Boolean(this.createError), e => e.child(div().text_size(11.5).text_color(gitColors().del).child(this.createError)))))
      // Deleting asks first, and says where the entry goes.
      .when(!this.file && Boolean(this.deleting), el => el.child(h_flex().flex_none().px(14).py(8).gap(8).items_center().border_b(1).border_color(t.border).bg(t.raised).text_size(12)
        .child(div().flex_1().min_w(0).child(`${this.trashes() ? "Move to the Trash" : "Delete for good"}: ${this.deleting.path}${this.deleting.dir ? "/ and everything in it" : ""}?`))
        .child(textButton("files-delete", this.trashes() ? "Move to Trash" : "Delete", true, (_e, cx) => this.remove(cx)))
        .child(textButton("files-delete-cancel", "Cancel", false, (_e, cx) => { this.deleting = null; cx.notify(); }))))
      .when(!this.file && Boolean(this.treeNote), el => el.child(h_flex().flex_none().px(14).py(6).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(this.treeNote.ok ? t.muted : gitColors().del).child(this.treeNote.text))
        .when(Boolean(this.treeNote.undo), e => e.child(textButton("files-note-undo", "Undo", false, (_e, cx) => { const u = this.treeNote.undo; this.treeNote = null; this.move(u.from, u.dest, cx); })))
        .child(div().id("files-note-close").flex_none().px(4).cursor_pointer().text_color(t.dim).hover(s => s.text_color(t.foreground)).on_click((_e, cx) => { this.treeNote = null; cx.notify(); }).child("×"))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        // Below the rows a drop goes to the root; leaving the panel gives the drag up.
        .when(Boolean(this.drag) && this.over === "", tree => tree.border_1().border_color(t.accent))
        .on_mouse_move((_e, cx) => { if (this.drag && this.over !== "") { this.over = ""; cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => {
          const drag = this.drag, over = this.over;
          this.drag = null; this.over = null;
          if (drag && over === "") this.move(drag.path, "", cx);
          cx.notify();
        })
        .on_hover((inside, cx) => { if (!inside && this.drag) { this.drag = null; this.over = null; cx.notify(); } })
        .children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")))
      .when(Boolean(this.file) && Boolean(this.code) && !this.editable, el => el.child(div().flex_none().px(14).py(5).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(this.on ? "Read-only: files on another machine can't be edited here" : "Read-only: the file is too large to edit here")));
  }
}
