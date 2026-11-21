//! Shell command history for the ⌘R search: reads the shells' own history files (nothing is recorded by the app).

/// Commands from one history file, oldest first. Handles zsh's extended format (`: 1700000000:0;cmd`),
/// zsh's backslash-continued multi-line entries, and bash's `#1700000000` timestamp lines.
pub fn parse(bytes: &[u8]) -> Vec<String> {
    // zsh stores bytes >= 0x83 "metafied": 0x83 followed by the byte XOR 0x20
    let mut raw = Vec::with_capacity(bytes.len());
    let mut it = bytes.iter();
    while let Some(&b) = it.next() {
        raw.push(if b == 0x83 { it.next().map_or(b, |n| n ^ 0x20) } else { b });
    }
    let text = String::from_utf8_lossy(&raw);
    let mut out = Vec::new();
    let mut pending: Option<String> = None;
    for line in text.lines() {
        let line = match pending.take() {
            Some(p) => format!("{p}\n{line}"),
            None => {
                let l = line.strip_prefix(": ").and_then(|r| r.split_once(';')).map_or(line, |(_, cmd)| cmd);
                if l.starts_with('#') && l[1..].bytes().all(|b| b.is_ascii_digit()) { continue }
                l.to_string()
            }
        };
        match line.strip_suffix('\\') {
            Some(more) => pending = Some(more.to_string()),
            None if !line.trim().is_empty() => out.push(line),
            None => {}
        }
    }
    out.extend(pending);
    out
}

/// Every command found, newest first, without repeats.
#[tauri::command]
pub fn shell_history() -> Vec<String> {
    let home = crate::expand_home("~");
    let mut files = vec![
        format!("{home}/.zsh_history"),
        format!("{home}/.bash_history"),
        format!("{home}/.local/share/powershell/PSReadLine/ConsoleHost_history.txt"),
    ];
    files.extend(std::env::var("HISTFILE"));
    if let Ok(appdata) = std::env::var("APPDATA") {
        files.push(format!("{appdata}\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt"));
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    // ponytail: files are concatenated, not merged by time (bash/PowerShell keep no timestamps by default)
    for f in files.iter().filter(|f| seen.insert(f.to_string())) {
        if let Ok(bytes) = std::fs::read(f) {
            out.extend(parse(&bytes).into_iter().rev());
        }
    }
    let mut dup = std::collections::HashSet::new();
    out.retain(|c| dup.insert(c.clone()));
    out.truncate(20_000);
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_zsh_and_bash() {
        let h = b": 1700000000:0;ssh staging\nls -la\n#1700000001\ngit status\n: 1700000002:0;echo a\\\nb\n: 1:0;caf\xc3\x83\x89\n";
        assert_eq!(super::parse(h), ["ssh staging", "ls -la", "git status", "echo a\nb", "café"]);
    }
}
