// run: node tests/util.test.mjs
import assert from "node:assert/strict";
import { shellQuote, parseTheme } from "../src/lib/util.ts";

assert.equal(shellQuote("/Users/me/a.png"), "/Users/me/a.png");
assert.equal(shellQuote("/Users/me/My File.png"), "'/Users/me/My File.png'");
assert.equal(shellQuote("/tmp/it's"), `'/tmp/it'\\''s'`);

const entry = (k, r, g, b) =>
  `<key>${k}</key><dict><key>Blue Component</key><real>${b}</real><key>Color Space</key><string>sRGB</string>` +
  `<key>Green Component</key><real>${g}</real><key>Red Component</key><real>${r}</real></dict>`;
const xml = `<plist><dict>${entry("Ansi 0 Color", 0, 0, 0)}${entry("Ansi 9 Color", 1, 0, 0)}${entry("Background Color", 0.1176, 0.1216, 0.1333)}${entry("Foreground Color", 1, 1, 1)}${entry("Bogus", 1, 1, 1)}</dict></plist>`;
assert.deepEqual(parseTheme(xml), { black: "#000000", brightRed: "#ff0000", background: "#1e1f22", foreground: "#ffffff" });
assert.throws(() => parseTheme("<plist/>"));

// other terminals
const want = { background: "#1e1f22", foreground: "#ffffff", red: "#ff0000", brightBlue: "#0000ff", cursor: "#aabbcc" };
assert.deepEqual(parseTheme("# ghostty\nbackground = 1e1f22\nforeground = #FFFFFF\npalette = 1=#ff0000\npalette = 12=#0000ff\ncursor-color = #aabbcc\nfont-size = 14"), want);
assert.deepEqual(parseTheme("background #1e1f22\nforeground #ffffff\ncolor1 #ff0000\ncolor12 #0000ff\ncursor #aabbcc\nfont_size 13.0"), want);
assert.deepEqual(
  parseTheme('[colors.primary]\nbackground = "#1e1f22"\nforeground = "0xffffff"\n[colors.normal]\nred = "#ff0000"\n[colors.bright]\nblue = "#0000ff"\n[colors.cursor]\ncursor = "#aabbcc"\n[font]\nsize = 12'),
  want,
);
const scheme = { name: "Mine", background: "#1E1F22", foreground: "#FFFFFF", red: "#FF0000", brightBlue: "#0000FF", cursorColor: "#AABBCC" };
assert.deepEqual(parseTheme(JSON.stringify(scheme)), want);
assert.deepEqual(parseTheme(`{\n// comment\n"profiles":{"defaults":{"colorScheme":"Mine"}},"schemes":[{"name":"Other","background":"#000000","foreground":"#111111"},${JSON.stringify(scheme)}]}`), want);
const nscolor = (k, rgb) => `<key>${k}</key><data>${btoa(`bplist00\u0001NSRGB\u0002${rgb}\u0000NSColorSpace`)}</data>`;
assert.deepEqual(
  parseTheme(`<plist><dict>${nscolor("BackgroundColor", "0.1176 0.1216 0.1333 0.95")}<key>TextColor</key><data>${btoa("bplist00\u0001NSWhite\u00021\u0000")}</data>${nscolor("ANSIRedColor", "1 0 0")}${nscolor("ANSIBrightBlueColor", "0 0 1")}<key>name</key><string>X</string></dict></plist>`),
  { background: "#1e1f22", foreground: "#ffffff", red: "#ff0000", brightBlue: "#0000ff" },
);
assert.throws(() => parseTheme("theme = Dracula\nfont-size = 14"));
console.log("ok");

const { detectAgent, resumeFor } = await import("../src/lib/util.ts");
const agents = [
  { name: "Claude Code", programs: ["claude", "claude-code"], resume: "claude --continue" },
  { name: "Codex", programs: ["codex"], resume: "codex resume --last" },
  { name: "Kimi", programs: ["kimi", "kimi-cli"], resume: "kimi --continue" },
];
const agentOf = (args) => detectAgent(args, agents)?.name ?? null;
assert.equal(agentOf("claude"), "Claude Code");
assert.equal(agentOf("/Users/me/.local/bin/claude --model opus"), "Claude Code");
assert.equal(agentOf("node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js"), "Claude Code");
assert.equal(agentOf("node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"), "Codex");
assert.equal(agentOf("/Users/me/.local/share/uv/tools/kimi-cli/bin/python3 /Users/me/.local/bin/kimi"), "Kimi");
assert.equal(agentOf("vim claude.md"), null); // file argument, not the program
assert.equal(agentOf("vim claude"), null);
assert.equal(agentOf("node /Users/me/work/claude/server.js"), null); // plain folder named claude
assert.equal(agentOf("ssh prod"), null);
const resume = (args) => resumeFor(args, agents);
assert.equal(resume("claude --dangerously-skip-permissions"), "claude --continue --dangerously-skip-permissions");
assert.equal(resume("claude --model opus --dangerously-skip-permissions"), "claude --continue --dangerously-skip-permissions"); // value flag dropped
assert.equal(resume("claude --verbose fix the bug"), "claude --continue"); // can't tell a prompt from a value: dropped
assert.equal(resume("claude --model=opus -c"), "claude --continue"); // =value and clashing flags dropped
assert.equal(resume("claude --continue --yolo --yolo"), "claude --continue --yolo"); // no duplicates
assert.equal(resume("claude -- --not-a-flag"), "claude --continue");
assert.equal(resume("claude --x$(rm) --ok"), "claude --continue --ok"); // only plain flag shapes reach the shell
assert.equal(resume("node /opt/node_modules/@openai/codex/bin/codex.js --search"), "codex resume --last --search"); // interpreter path not kept
assert.equal(resumeFor("claude --yolo", agents, false), "claude --continue");
assert.equal(resume("vim claude"), null);
// Windows: real argv (paths with spaces, backslashes, .exe)
assert.equal(agentOf(["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js", "--dangerously-skip-permissions"]), "Claude Code");
assert.equal(agentOf(["C:\\Users\\me\\.local\\bin\\Claude.exe"]), "Claude Code");
assert.equal(resume(["C:\\tools\\codex.exe", "--search", "--model", "o3"]), "codex resume --last --search");
assert.equal(agentOf(["C:\\Windows\\notepad.exe", "claude.md"]), null);
assert.equal(shellQuote("C:\\My Files\\a.png", true), '"C:\\My Files\\a.png"');
assert.equal(shellQuote("C:\\x\\a.png", true), "C:\\x\\a.png");
assert.equal(shellQuote("C:\\$it's\\a.png", true), "'C:\\$it''s\\a.png'");
assert.equal(shellQuote("/Users/me/My Files/a.png", false), "'/Users/me/My Files/a.png'");
console.log("agents ok");
