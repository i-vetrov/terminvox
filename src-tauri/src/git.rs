//! Read-only view of a folder's uncommitted changes, for the diff pane. Runs the user's own `git`.
use std::path::Path;
use std::process::Command;

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // what to compare with before the first commit
const MAX_NEW_FILE: u64 = 512 * 1024; // a new file above this is listed but its content isn't shown
const MAX_NEW_FILES: usize = 500;
const MAX_TOTAL: usize = 4 * 1024 * 1024; // the page renders every line; stop well before it chokes

#[derive(serde::Serialize)]
pub struct Changes {
    root: String,
    branch: String,
    /// Unified diff of everything uncommitted against the last commit; new untracked files are appended as all-added.
    diff: String,
    truncated: bool,
}

fn git(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(["-c", "core.quotepath=off"]).args(args);
    cmd.env("GIT_OPTIONAL_LOCKS", "0"); // only looking: never take the index lock from under a running agent
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    }
    let out = cmd.output().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "Git is not installed, or not on the PATH.".to_string(),
        _ => e.to_string(),
    })?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// A file git doesn't track yet, written the way `git diff` shows a new file.
fn new_file(root: &Path, path: &str) -> Option<String> {
    let full = root.join(path);
    let meta = std::fs::metadata(&full).ok()?;
    if !meta.is_file() {
        return None; // e.g. a nested repository, listed as a folder
    }
    let head = format!("diff --git a/{path} b/{path}\nnew file mode 100644\n");
    let binary = || format!("{head}Binary files /dev/null and b/{path} differ\n");
    if meta.len() > MAX_NEW_FILE {
        return Some(binary());
    }
    let bytes = std::fs::read(&full).ok()?;
    if bytes.contains(&0) {
        return Some(binary());
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut out = format!("{head}--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n", text.lines().count());
    for line in text.lines() {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    Some(out)
}

fn changes(dir: &Path) -> Result<Changes, String> {
    let text = |b: Vec<u8>| String::from_utf8_lossy(&b).trim().to_string();
    let root = text(git(dir, &["rev-parse", "--show-toplevel"])?);
    let rootp = Path::new(&root);
    let has_head = git(rootp, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok();
    let mut branch = text(git(rootp, &["branch", "--show-current"]).unwrap_or_default());
    if branch.is_empty() && has_head {
        branch = text(git(rootp, &["rev-parse", "--short", "HEAD"]).unwrap_or_default()); // detached
    }
    let base = if has_head { "HEAD" } else { EMPTY_TREE };
    let raw = git(rootp, &["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", base, "--"])?;
    let mut diff = String::from_utf8_lossy(&raw).into_owned();
    let mut truncated = false;
    if diff.len() > MAX_TOTAL {
        let mut end = MAX_TOTAL;
        while !diff.is_char_boundary(end) {
            end -= 1;
        }
        let cut = diff[..end].rfind("\ndiff --git ").map_or(end, |i| i + 1); // drop the file that got cut in half
        diff.truncate(cut);
        truncated = true;
    }
    let others = git(rootp, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    for (i, path) in String::from_utf8_lossy(&others).split('\0').filter(|p| !p.is_empty()).enumerate() {
        if truncated || i >= MAX_NEW_FILES || diff.len() > MAX_TOTAL {
            truncated = true;
            break;
        }
        if let Some(d) = new_file(rootp, path) {
            diff.push_str(&d);
        }
    }
    Ok(Changes { root, branch, diff, truncated })
}

#[tauri::command]
pub async fn git_changes(cwd: String) -> Result<Changes, String> {
    changes(Path::new(&crate::expand_home(&cwd)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shows_tracked_and_untracked_changes_before_and_after_the_first_commit() {
        let dir = std::env::temp_dir().join(format!("terminvox-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(dir.join("tracked.txt"), "one\n").unwrap();
        git(&dir, &["add", "tracked.txt"]).unwrap();
        std::fs::write(dir.join("sub/new file.txt"), "hello\nworld\n").unwrap();
        std::fs::write(dir.join("blob.bin"), [0u8, 1, 2]).unwrap();

        // no commit yet: everything counts as added; asking from a subfolder still covers the whole repository
        let c = changes(&dir.join("sub")).unwrap();
        assert_eq!(c.branch, "main");
        assert!(c.diff.contains("+++ b/tracked.txt\n@@ -0,0 +1 @@\n+one"), "{}", c.diff);
        assert!(c.diff.contains("+++ b/sub/new file.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n"), "{}", c.diff);
        assert!(c.diff.contains("Binary files /dev/null and b/blob.bin differ"), "{}", c.diff);

        git(&dir, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"]).unwrap();
        std::fs::write(dir.join("tracked.txt"), "one\ntwo\n").unwrap();
        let c = changes(&dir).unwrap();
        assert!(c.diff.contains("--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1,2 @@\n one\n+two"), "{}", c.diff);

        assert!(changes(&std::env::temp_dir()).is_err_and(|e| e.contains("not a git repository")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
