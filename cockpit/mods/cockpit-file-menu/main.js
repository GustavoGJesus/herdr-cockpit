// The Files panel's right-click menu. Opened by cockpit-files as a popup with
// props { path, abs, name, dir }. A choice goes back through the shared key
// "cockpit-files.action" ({ id, action, path, dir }); cockpit-files acts on each id once.
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { props, closeOverlay, setShared, theme } from "herdr";

export default class FileMenu extends View {
  render() {
    const t = theme(), p = props() ?? {};
    const send = (action) => {
      closeOverlay(p.overlay);
      setShared("cockpit-files.action", { id: Date.now(), action, path: p.path, dir: Boolean(p.dir) });
    };
    const item = (id, label, action, danger = false) => div().id(`fm-${id}`).h(28).px(10).flex().items_center().rounded(3).cursor_pointer()
      .text_color(danger ? "#f85149" : t.foreground).hover((s) => s.bg(t.hover)).on_click(action).child(label);
    const line = () => div().h(1).my(4).bg(t.border);
    return v_flex().size_full().p(4).bg(t.popover).border_1().border_color(t.border).rounded(3).text_size(12.5)
      .child(div().px(10).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(p.name ?? ""))
      .child(item("rename", "Rename…", () => send("rename")))
      .child(item("new-file", p.dir ? "New file here…" : "New file beside it…", () => send("new-file")))
      .child(item("new-folder", p.dir ? "New folder here…" : "New folder beside it…", () => send("new-folder")))
      .child(item("copy", "Copy path", (_e, cx) => { cx.write_to_clipboard(p.abs ?? p.path ?? ""); closeOverlay(p.overlay); }))
      .child(line())
      .child(item("delete", "Delete…", () => send("delete"), true));
  }
}
