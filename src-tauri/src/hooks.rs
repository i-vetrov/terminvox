//! Exact "waiting for you" status: agents report their own events instead of us guessing from output.
//!
//! Each PTY gets `TERMINVOX_NOTIFY=http://127.0.0.1:<port>/<token>/<run id>`. Hooks installed into
//! Claude Code / Codex call `curl "$TERMINVOX_NOTIFY/<event>"`; outside TerminVox the variable is
//! unset and the hook does nothing. The random token keeps other local processes and web pages out.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

static BASE: OnceLock<String> = OnceLock::new();

/// URL prefix for this app run (`None` if the listener couldn't start).
pub fn base() -> Option<&'static String> {
    BASE.get()
}

fn random_hex() -> String {
    let r = |n: u64| {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(n);
        h.finish()
    };
    format!("{:016x}{:016x}", r(1), r(2))
}

#[derive(Clone, Serialize)]
struct AgentEvent {
    id: String,
    event: String,
}

/// `GET /<token>/<run>/<event>` -> Some((run, event)) when the token matches.
fn parse(request_line: &str, token: &str) -> Option<(String, String)> {
    let path = request_line.split_whitespace().nth(1)?;
    let mut parts = path.trim_start_matches('/').split('/');
    let (t, run, event) = (parts.next()?, parts.next()?, parts.next()?);
    let ok = |s: &str| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    (t == token && ok(run) && ok(event) && parts.next().is_none()).then(|| (run.into(), event.into()))
}

pub fn start(app: AppHandle) {
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else { return };
    let Ok(addr) = listener.local_addr() else { return };
    let token = random_hex();
    let _ = BASE.set(format!("http://127.0.0.1:{}/{}", addr.port(), token));
    std::thread::spawn(move || {
        for mut conn in listener.incoming().flatten() {
            let _ = conn.set_read_timeout(Some(std::time::Duration::from_millis(500)));
            let mut buf = [0u8; 1024];
            let n = conn.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let first = req.lines().next().unwrap_or("");
            let found = parse(first, &token);
            let status = if found.is_some() { "204 No Content" } else { "404 Not Found" };
            let _ = conn.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
            if let Some((id, event)) = found {
                let _ = app.emit("agent-event", AgentEvent { id, event });
            }
        }
    });
}

// ---- installing the hooks into the agents' own config ----

const MARK: &str = "TERMINVOX_NOTIFY";

fn hook_cmd(event: &str) -> String {
    // must print nothing (Claude adds UserPromptSubmit stdout to the conversation) and never fail
    format!(r#"[ -n "${MARK}" ] && curl -s -m 1 "${MARK}/{event}" >/dev/null 2>&1; true"#)
}

const CLAUDE_EVENTS: [(&str, &str); 3] = [("UserPromptSubmit", "prompt"), ("Stop", "stop"), ("Notification", "notify")];

fn home() -> PathBuf {
    PathBuf::from(crate::expand_home("~"))
}
fn claude_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".claude"))
}
fn codex_dir() -> PathBuf {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".codex"))
}

/// Remove our entries from Claude settings, then add them back if `install`.
fn claude_apply(settings: &mut Value, install: bool) {
    if !settings.is_object() {
        *settings = json!({});
    }
    let hooks = settings.as_object_mut().unwrap().entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let map = hooks.as_object_mut().unwrap();
    for (event, ours) in CLAUDE_EVENTS {
        let list = map.entry(event).or_insert_with(|| json!([]));
        if let Some(arr) = list.as_array_mut() {
            arr.retain(|entry| !entry.to_string().contains(MARK));
            if install {
                arr.push(json!({ "hooks": [{ "type": "command", "command": hook_cmd(ours) }] }));
            }
        }
        if list.as_array().is_some_and(|a| a.is_empty()) {
            map.remove(event);
        }
    }
    if map.is_empty() {
        settings.as_object_mut().unwrap().remove("hooks");
    }
}

fn claude_installed(settings: &Value) -> bool {
    CLAUDE_EVENTS.iter().all(|(e, _)| settings.pointer(&format!("/hooks/{e}")).is_some_and(|v| v.to_string().contains(MARK)))
}

/// Top-level `notify = …` line in config.toml (keys after the first `[table]` belong to that table).
fn codex_notify_line(toml: &str) -> Option<&str> {
    toml.lines()
        .take_while(|l| !l.trim_start().starts_with('['))
        .find(|l| l.trim_start().strip_prefix("notify").is_some_and(|r| r.trim_start().starts_with('=')))
}

fn toml_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Codex runs `notify` directly (no shell) and appends the event JSON — which includes the agent's
/// last message — as one more argument. It must arrive as inert data: with `sh -c` it lands in $1;
/// on Windows a script run with `-File` gets it in $args. (A `cmd /c` or `powershell -Command`
/// one-liner would splice that text into the command itself.)
fn codex_argv() -> Vec<String> {
    if cfg!(windows) {
        let script = codex_dir().join(WIN_SCRIPT).to_string_lossy().into_owned();
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &script].map(String::from).to_vec()
    } else {
        vec!["sh".into(), "-c".into(), hook_cmd("done"), "terminvox".into()]
    }
}

const WIN_SCRIPT: &str = "terminvox-notify.ps1";
const WIN_SCRIPT_BODY: &str = "# Added by TerminVox: tells it a Codex turn finished. Does nothing outside TerminVox.\r\n\
if ($env:TERMINVOX_NOTIFY) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri \"$env:TERMINVOX_NOTIFY/done\" | Out-Null } catch {} }\r\n";

fn codex_line() -> String {
    let argv: Vec<String> = codex_argv().iter().map(|a| toml_str(a)).collect();
    format!("notify = [{}] # added by TerminVox", argv.join(", "))
}

/// Our notify line (also recognizes the Windows variant, whose text doesn't mention the env var).
fn is_ours(line: &str) -> bool {
    line.contains(MARK) || line.contains(WIN_SCRIPT)
}

fn backup_and_write(path: &PathBuf, text: &str) -> Result<(), String> {
    if path.exists() {
        std::fs::copy(path, path.with_extension(format!("{}.terminvox.bak", path.extension().and_then(|e| e.to_str()).unwrap_or("")))).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("terminvox-tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct HookStatus {
    claude: &'static str, // on | off | missing (agent not installed)
    codex: &'static str,  // on | off | missing | conflict (you already have your own notify)
}

fn read_claude() -> Result<Value, String> {
    let p = claude_dir().join("settings.json");
    match std::fs::read_to_string(&p) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s).map_err(|e| format!("{}: {e}", p.display())),
        _ => Ok(json!({})),
    }
}

#[tauri::command]
pub fn hooks_status() -> HookStatus {
    let claude = if !claude_dir().is_dir() {
        "missing"
    } else if read_claude().is_ok_and(|v| claude_installed(&v)) {
        "on"
    } else {
        "off"
    };
    let codex = if !codex_dir().is_dir() {
        "missing"
    } else {
        let toml = std::fs::read_to_string(codex_dir().join("config.toml")).unwrap_or_default();
        match codex_notify_line(&toml) {
            Some(l) if is_ours(l) => "on",
            Some(_) => "conflict",
            None => "off",
        }
    };
    HookStatus { claude, codex }
}

#[tauri::command]
pub fn hooks_set(agent: String, install: bool) -> Result<HookStatus, String> {
    match agent.as_str() {
        "claude" => {
            let mut v = read_claude()?;
            claude_apply(&mut v, install);
            let text = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())? + "\n";
            backup_and_write(&claude_dir().join("settings.json"), &text)?;
        }
        "codex" => {
            let path = codex_dir().join("config.toml");
            let toml = std::fs::read_to_string(&path).unwrap_or_default();
            let existing = codex_notify_line(&toml);
            if existing.is_some_and(|l| !is_ours(l)) {
                return Err("config.toml already has its own `notify` command — left untouched".into());
            }
            let mut lines: Vec<String> = toml.lines().filter(|l| Some(*l) != existing).map(String::from).collect();
            if install {
                lines.insert(0, codex_line()); // root keys must come before any [table]
            }
            // script first, so the config never points at a missing file
            if cfg!(windows) {
                let script = codex_dir().join(WIN_SCRIPT);
                if install {
                    std::fs::write(&script, WIN_SCRIPT_BODY).map_err(|e| e.to_string())?;
                } else {
                    let _ = std::fs::remove_file(&script);
                }
            }
            backup_and_write(&path, &(lines.join("\n") + "\n"))?;
        }
        _ => return Err(format!("unknown agent {agent}")),
    }
    Ok(hooks_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_matching_token() {
        assert_eq!(parse("GET /tok/run-1/stop HTTP/1.1", "tok"), Some(("run-1".into(), "stop".into())));
        assert_eq!(parse("GET /bad/run-1/stop HTTP/1.1", "tok"), None);
        assert_eq!(parse("GET /tok/run-1/stop/x HTTP/1.1", "tok"), None);
        assert_eq!(parse("GET /tok/../stop HTTP/1.1", "tok"), None);
    }

    #[test]
    fn claude_install_keeps_user_hooks_and_is_idempotent() {
        let mut v = json!({ "model": "opus", "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] } });
        claude_apply(&mut v, true);
        claude_apply(&mut v, true);
        assert!(claude_installed(&v));
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 2);
        claude_apply(&mut v, false);
        assert_eq!(v, json!({ "model": "opus", "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] } }));
    }

    #[test]
    fn codex_notify_detection() {
        assert!(codex_notify_line("model = \"x\"\nnotify = [\"a\"]\n").is_some());
        assert!(codex_notify_line("[tui]\nnotify = true\n").is_none());
        assert!(codex_notify_line("notifications = 1\n").is_none());
        // the line we write is valid TOML-ish: one array with the script as the third element
        assert!(codex_line().starts_with("notify = [\"sh\", \"-c\", \"[ -n \\\"$TERMINVOX_NOTIFY\\\" ]"));
    }
}
