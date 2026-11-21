mod git;
mod history;
mod hooks;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::ipc::{Channel, InvokeResponseBody};
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>, // the shell
}

#[derive(Default)]
struct Sessions(Mutex<HashMap<String, Session>>);

#[derive(Clone, serde::Serialize)]
struct Exit {
    id: String,
    code: Option<u32>,
}

fn expand_home(path: &str) -> String {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| "/".into());
    match path.trim() {
        "" | "~" => home,
        p if p.starts_with("~/") || p.starts_with("~\\") => format!("{home}{}", &p[1..]),
        p => p.to_string(),
    }
}

/// The shell to run: the one chosen in Settings, else the user's login shell / PowerShell.
fn shell_command(chosen: &str) -> CommandBuilder {
    let program = match chosen.trim() {
        "" if cfg!(windows) => if on_path("pwsh.exe") { "pwsh.exe".into() } else { "powershell.exe".into() },
        "" => std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()),
        p => expand_home(p),
    };
    let mut cmd = CommandBuilder::new(&program);
    let name = std::path::Path::new(&program).file_stem().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
    match name.as_str() {
        // Report the folder from the prompt (OSC 9;9, as Windows Terminal does) — PowerShell's `cd`
        // doesn't change the process's working directory, so it can't be read from the OS.
        "pwsh" | "powershell" => {
            cmd.args(["-NoLogo", "-NoExit", "-Command", PWSH_PROMPT_HOOK]);
        }
        "cmd" => {
            cmd.env("PROMPT", "$e]9;9;$P$e\\$P$G");
        }
        _ if cfg!(unix) => {
            cmd.arg("-l"); // login shell: apps launched from Finder get a bare PATH otherwise
        }
        _ => {}
    }
    cmd
}

const PWSH_PROMPT_HOOK: &str = r#"$__tvPrompt = $function:prompt; function global:prompt { $l = $executionContext.SessionState.Path.CurrentLocation; if ($l.Provider.Name -eq 'FileSystem') { [Console]::Write("$([char]27)]9;9;$($l.ProviderPath)$([char]27)\") }; & $__tvPrompt }"#;

fn on_path(exe: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(exe).is_file()))
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    sessions: State<Sessions>,
    id: String,
    cwd: String,
    command: String,
    shell: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = shell_command(&shell);
    let dir = expand_home(&cwd);
    cmd.cwd(if std::path::Path::new(&dir).is_dir() {
        dir
    } else {
        expand_home("~")
    });
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(base) = hooks::base() {
        cmd.env("TERMINVOX_NOTIFY", format!("{base}/{id}"));
    }
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave); // so the reader sees EOF when the shell exits

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    if !command.trim().is_empty() {
        writer
            .write_all(format!("{}\r", command.trim()).as_bytes())
            .map_err(|e| e.to_string())?;
    }

    sessions.0.lock().unwrap().insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            killer: child.clone_killer(),
            pid: child.process_id(),
        },
    );

    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0
                || on_data
                    .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                    .is_err()
            {
                break;
            }
        }
        let code = child.wait().ok().map(|s| s.exit_code());
        app.state::<Sessions>().0.lock().unwrap().remove(&id);
        let _ = app.emit("pty-exit", Exit { id, code });
    });
    Ok(())
}

#[tauri::command]
fn pty_write(sessions: State<Sessions>, id: String, data: String) -> Result<(), String> {
    if let Some(s) = sessions.0.lock().unwrap().get_mut(&id) {
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(sessions: State<Sessions>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    if let Some(s) = sessions.0.lock().unwrap().get(&id) {
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_kill(sessions: State<Sessions>, id: String) {
    if let Some(mut s) = sessions.0.lock().unwrap().remove(&id) {
        let _ = s.killer.kill();
    }
}

/// Kill every session. Called when the page starts: if the page was reloaded (dev hot-reload,
/// web view crash), the old page's shells would otherwise keep running unseen.
#[tauri::command]
fn pty_kill_all(sessions: State<Sessions>) {
    for (_, mut s) in sessions.0.lock().unwrap().drain() {
        let _ = s.killer.kill();
    }
}

/// settings.json -> config dir (~/.config/<id> on Linux), layout.json -> data dir (~/.local/share/<id>).
/// On macOS both are ~/Library/Application Support/<id>, on Windows %APPDATA%\<id>.
fn json_file(app: &AppHandle, kind: &str) -> Result<std::path::PathBuf, String> {
    let p = app.path();
    let (dir, name) = match kind {
        "settings" => (p.app_config_dir(), "settings.json"),
        "layout" => (p.app_data_dir(), "layout.json"),
        "legacy" => (p.app_data_dir(), "state.json"), // pre-split file, read once for migration
        _ => return Err(format!("unknown file kind: {kind}")),
    };
    let dir = dir.map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

fn read_valid(path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()?;
    Some(text)
}

#[tauri::command]
fn load_json(app: AppHandle, kind: String) -> Result<String, String> {
    let path = json_file(&app, &kind)?;
    if let Some(text) = read_valid(&path) {
        return Ok(text);
    }
    if path.exists() {
        // keep the broken file for inspection; the next save would otherwise overwrite it
        let _ = std::fs::copy(&path, path.with_extension("json.corrupt"));
    }
    // last good version, then the pre-split state.json, then nothing (defaults)
    Ok(read_valid(&path.with_extension("json.bak"))
        .or_else(|| read_valid(&json_file(&app, "legacy").ok()?))
        .unwrap_or_default())
}

#[tauri::command]
fn save_json(app: AppHandle, kind: String, json: String) -> Result<(), String> {
    if kind == "legacy" {
        return Err("legacy file is read-only".into());
    }
    let path = json_file(&app, &kind)?;
    // previous good version -> .bak, then write-then-rename so a crash mid-write can't wipe the file
    if read_valid(&path).is_some() {
        let _ = std::fs::copy(&path, path.with_extension("json.bak"));
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, &path).map_err(|e| e.to_string())?;
    // migration done once both new files exist
    let (settings, layout) = (json_file(&app, "settings")?, json_file(&app, "layout")?);
    if settings.exists() && layout.exists() {
        let _ = std::fs::remove_file(json_file(&app, "legacy")?);
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct Running {
    id: String,
    program: String,
}

/// Sessions whose shell is running something in the foreground (claude, npm run dev, ...).
#[tauri::command]
fn pty_running(sessions: State<Sessions>) -> Vec<Running> {
    shells(&sessions)
        .into_iter()
        .filter_map(|(id, shell, leader)| {
            let pid = proc::foreground(shell?, leader)?;
            let name = proc::name(pid).filter(|n| !n.is_empty()).unwrap_or_else(|| "a program".into());
            Some(Running { id, program: name })
        })
        .collect()
}

/// (run id, shell pid, foreground process-group leader) — collected under the lock; the slow
/// process queries happen after it's released so typing never waits on them.
fn shells(sessions: &State<Sessions>) -> Vec<(String, Option<u32>, Option<u32>)> {
    let sessions = sessions.0.lock().unwrap();
    sessions.iter().map(|(id, s)| (id.clone(), s.pid, leader(s))).collect()
}

#[cfg(unix)]
fn leader(s: &Session) -> Option<u32> {
    s.master.process_group_leader().map(|p| p as u32)
}
#[cfg(not(unix))]
fn leader(_: &Session) -> Option<u32> {
    None
}

#[cfg(unix)]
mod proc {
    /// What the shell is running in the foreground: the terminal's process group, unless that's the
    /// shell itself (idle prompt).
    pub fn foreground(shell: u32, leader: Option<u32>) -> Option<u32> {
        leader.filter(|&l| l != shell)
    }

    /// One `ps` column for a pid ("comm" = executable, "args" = full command line).
    fn ps(pid: u32, field: &str) -> Option<String> {
        let out = std::process::Command::new("ps")
            .args(["-o", &format!("{field}="), "-p", &pid.to_string()])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    pub fn name(pid: u32) -> Option<String> {
        ps(pid, "comm").map(|c| c.rsplit('/').next().unwrap_or("").to_string())
    }

    /// ponytail: `ps` joins argv with spaces, so an argument containing spaces splits; fine for
    /// agent detection (program names + simple flags).
    pub fn args(pid: u32) -> Option<Vec<String>> {
        ps(pid, "args").map(|a| a.split_whitespace().map(String::from).collect())
    }

    /// Current folder of a process. We ask about the *shell*, so whatever runs inside it (ssh to
    /// another machine, a TUI that changes its own dir) can't change what we save: after `ssh`,
    /// it's still the local folder ssh was started from.
    #[cfg(target_os = "macos")]
    pub fn cwd(pid: u32) -> Option<String> {
        let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
        let ptr = &mut info as *mut libc::proc_vnodepathinfo as *mut libc::c_void;
        if unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDVNODEPATHINFO, 0, ptr, size) } != size {
            return None;
        }
        let path = &info.pvi_cdir.vip_path; // [[c_char; 32]; 32] = MAXPATHLEN bytes, NUL-terminated
        let bytes: Vec<u8> = path.iter().flatten().map(|&c| c as u8).take_while(|&b| b != 0).collect();
        String::from_utf8(bytes).ok().filter(|p| !p.is_empty())
    }

    #[cfg(not(target_os = "macos"))]
    pub fn cwd(pid: u32) -> Option<String> {
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok()?.to_str().map(Into::into)
    }
}

#[cfg(windows)]
mod proc {
    use std::sync::{Mutex, MutexGuard};
    use std::time::{Duration, Instant};
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    /// One process table shared by all queries, refreshed at most every 500ms
    /// (a full refresh costs tens of ms; a snapshot asks about every terminal).
    fn table() -> MutexGuard<'static, Option<(System, Instant)>> {
        static T: Mutex<Option<(System, Instant)>> = Mutex::new(None);
        let mut t = T.lock().unwrap();
        if t.as_ref().is_none_or(|(_, at)| at.elapsed() > Duration::from_millis(500)) {
            if let Ok(mut sys) = System::new() {
                let kind = ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always);
                sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
                *t = Some((sys, Instant::now()));
            }
        }
        t
    }

    fn base(name: &std::ffi::OsStr) -> String {
        name.to_string_lossy().to_lowercase()
    }

    /// Windows has no foreground process group, so: the shell's newest child (ignoring the console
    /// host), stepping through `cmd /c` wrappers like npm's `claude.cmd` shim to what they launched.
    /// ponytail: newest-child heuristic; a background job started after the agent would win.
    pub fn foreground(shell: u32, _: Option<u32>) -> Option<u32> {
        let guard = table();
        let sys = &guard.as_ref()?.0;
        let newest_child = |parent: Pid| {
            sys.processes()
                .iter()
                .filter(|(_, p)| p.parent() == Some(parent) && !matches!(base(p.name()).as_str(), "conhost.exe" | "openconsole.exe"))
                .max_by_key(|(_, p)| p.start_time())
                .map(|(pid, p)| (*pid, base(p.name())))
        };
        let (mut pid, mut name) = newest_child(Pid::from_u32(shell))?;
        while name == "cmd.exe" {
            match newest_child(pid) {
                Some(next) => (pid, name) = next,
                None => break,
            }
        }
        Some(pid.as_u32())
    }

    pub fn name(pid: u32) -> Option<String> {
        let guard = table();
        let p = guard.as_ref()?.0.process(Pid::from_u32(pid))?;
        Some(p.name().to_string_lossy().trim_end_matches(".exe").to_string())
    }

    pub fn args(pid: u32) -> Option<Vec<String>> {
        let guard = table();
        let p = guard.as_ref()?.0.process(Pid::from_u32(pid))?;
        Some(p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect())
    }

    /// PowerShell's `cd` doesn't move the process's working directory, so the OS can't tell us
    /// where it is; the shell reports it itself instead (OSC 9;9 from the prompt, see pty_spawn).
    pub fn cwd(_: u32) -> Option<String> {
        None
    }
}

#[derive(serde::Serialize)]
struct Snapshot {
    id: String,
    cwd: Option<String>,
    program: Option<Vec<String>>, // argv of the foreground program
}

/// Where each terminal's shell is and what it's running, so a restart can put it back.
#[tauri::command]
fn pty_snapshot(sessions: State<Sessions>) -> Vec<Snapshot> {
    shells(&sessions)
        .into_iter()
        .map(|(id, shell, leader)| Snapshot {
            id,
            cwd: shell.and_then(proc::cwd),
            program: shell.and_then(|s| proc::foreground(s, leader)).and_then(proc::args),
        })
        .collect()
}

/// ⌘Q / window close: let the page warn about running programs. A second request within 3s
/// quits regardless, so a broken page can never trap you in the app.
fn request_quit(app: &AppHandle) {
    static LAST: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap();
    if last.is_some_and(|t| t.elapsed().as_secs() < 3) {
        app.exit(0);
    }
    *last = Some(std::time::Instant::now());
    let _ = app.emit("quit-requested", ());
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Installed font family names (the frontend filters to monospace by measuring them).
#[tauri::command]
async fn list_fonts() -> Vec<String> {
    let mut families = font_kit::source::SystemSource::new()
        .all_families()
        .unwrap_or_default();
    families.retain(|f| !f.starts_with('.')); // hidden system fonts
    families.sort_by_key(|f| f.to_lowercase());
    families.dedup();
    families
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Sessions::default())
        .setup(|app| {
            hooks::start(app.handle().clone());
            // Earlier identifiers, newest first: move their settings/layout folders over once.
            for dir in [app.path().app_config_dir(), app.path().app_data_dir()].into_iter().flatten() {
                for old in ["app.terminvox", "dev.consolemanager.app"] {
                    let old = dir.with_file_name(old);
                    if !dir.exists() && old.exists() {
                        let _ = std::fs::rename(&old, &dir);
                    }
                }
            }

            // macOS: custom menu without File > Close Window, so ⌘W/⌘T reach the page as tab shortcuts.
            // Windows/Linux: no menu bar at all. Settings has its own button and Ctrl+, in the page.
            #[cfg(target_os = "macos")]
            {
                let settings = MenuItemBuilder::with_id("settings", "Settings…")
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?;
                let app_menu = SubmenuBuilder::new(app, "TerminVox")
                    .about(None)
                    .separator()
                    .item(&settings)
                    .separator()
                    .hide()
                    .hide_others()
                    .separator()
                    .item(
                        // custom Quit so ⌘Q can warn about running programs (see quit-requested)
                        &MenuItemBuilder::with_id("quit", "Quit TerminVox")
                            .accelerator("CmdOrCtrl+Q")
                            .build(app)?,
                    )
                    .build()?;
                let edit = SubmenuBuilder::new(app, "Edit")
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .fullscreen()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit, &window])
                    .build()?;
                app.set_menu(menu)?;
            }
            app.on_menu_event(|app, event| {
                if event.id() == "settings" {
                    let _ = app.emit("open-settings", ());
                }
                if event.id() == "quit" {
                    request_quit(app);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // closing the window quits the app, so route it through the same check
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                request_quit(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_fonts,
            pty_spawn, pty_write, pty_resize, pty_kill, load_json, save_json, pty_running, pty_snapshot, pty_kill_all, quit, hooks::hooks_status, hooks::hooks_set, history::shell_history, git::git_changes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(unix)]
    fn process_cwd_reads_own_folder() {
        let me = std::env::current_dir().unwrap().canonicalize().unwrap();
        let got = super::proc::cwd(std::process::id()).expect("cwd");
        assert_eq!(std::path::Path::new(&got).canonicalize().unwrap(), me);
    }
}
