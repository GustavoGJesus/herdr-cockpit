// Line-by-line syntax coloring for the diff. Not a parser: it colors the common shapes
// (comments, strings, numbers, keywords, calls, types) well enough to read a change.

const KEYWORDS = new Set(("as async await break case catch class const continue def default defer del do done elif else esac " +
  "enum except export extends fi finally fn for from func function if impl import in interface is lambda let local match mod " +
  "module new not of or and package pass pub raise return static struct super switch then throw trait try type typeof use var " +
  "void while with yield echo exit set unset source readonly declare").split(" "));
const CONSTANTS = new Set("true false null undefined nil None True False this self NaN Infinity".split(" "));
const HASH = new Set("py rb sh bash zsh fish yaml yml toml conf ini env rules tf nix r pl mk dockerfile gitignore".split(" "));
const DASHES = new Set("sql lua hs elm".split(" "));

// The comment marker for a file, from its name: "#", "--" or "//".
export function commentMarker(path) {
  const name = (path ?? "").split("/").pop().toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : name;
  if (HASH.has(ext) || /^(makefile|dockerfile|brewfile|\.?zshrc|\.?zprofile|\.?bashrc|config)$/.test(name)) return "#";
  return DASHES.has(ext) ? "--" : "//";
}

// One line as [{ text, kind }], kind in keyword, string, comment, function, type, number,
// constant or null (plain). Whitespace travels at the start of the token after it, so no
// token is only spaces or ends in them.
export function tokenize(line, marker = "//") {
  const out = [];
  let space = "";
  const push = (text, kind) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind && !space) last.text += text;
    else out.push({ text: space + text, kind });
    space = "";
  };
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i), c = line[i];
    if (c === " ") { space += c; i += 1; continue; }
    const hashOk = marker !== "#" || i === 0 || /\s/.test(line[i - 1]);
    if ((rest.startsWith(marker) && hashOk) || (marker === "//" && rest.startsWith("/*")) || (marker === "//" && out.length === 0 && c === "*")) {
      push(rest, "comment"); break;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      push(line.slice(i, j + 1), "string"); i = j + 1; continue;
    }
    const num = /^(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)/.exec(rest);
    if (num && !/[\w$]/.test(line[i - 1] ?? "")) { push(num[0], "number"); i += num[0].length; continue; }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const w = word[0];
      const kind = KEYWORDS.has(w) ? "keyword" : CONSTANTS.has(w) ? "constant" : /^[A-Z][a-z]/.test(w) ? "type"
        : line[i + w.length] === "(" ? "function" : null;
      push(w, kind); i += w.length; continue;
    }
    push(c, null); i += 1;
  }
  if (space) out.push({ text: space, kind: null });
  return out;
}
