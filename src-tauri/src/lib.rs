use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Score {
    Green,
    Amber,
    Red,
}

impl Score {
    fn as_str(&self) -> &'static str {
        match self {
            Score::Green => "green",
            Score::Amber => "amber",
            Score::Red => "red",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub folder: String,
    /// When Some, only these filenames are part of the session (CLI file-list mode).
    /// When None, all PDFs in the folder are included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Vec<String>>,
    /// filename -> score (None = unscored)
    pub scores: BTreeMap<String, Option<Score>>,
    /// filename -> note text (absent = no note)
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub notes: BTreeMap<String, String>,
    /// Scores and notes from the state file for files outside this session (not listed on
    /// the command line, or no longer in the folder). Not shown, but written back on save so
    /// that they are never lost.
    #[serde(skip)]
    retained_scores: BTreeMap<String, Option<Score>>,
    #[serde(skip)]
    retained_notes: BTreeMap<String, String>,
    /// Problem met while loading that the user should be told about, e.g. an unparseable
    /// state file that was moved aside. Reported once, when the session is opened.
    #[serde(skip)]
    load_warning: Option<String>,
}

/// Contents of a state file, as read back by `Session::load_saved`.
#[derive(Default)]
struct Saved {
    scores: BTreeMap<String, Option<Score>>,
    notes: BTreeMap<String, String>,
    warning: Option<String>,
}

impl Session {
    fn state_path(folder: &Path) -> PathBuf {
        folder.join("quick-score-pdf.json")
    }

    /// Read the saved scores and notes. A missing file gives empty maps. An unparseable file
    /// is moved aside rather than silently replaced by the next save; an unreadable one
    /// (e.g. a cloud file that cannot be fetched) is an error, so nothing overwrites it.
    fn load_saved(path: &Path) -> Result<Saved, String> {
        let data = match fs::read_to_string(path) {
            Ok(data) => data,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
            Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
        };
        match serde_json::from_str::<Session>(&data) {
            Ok(s) => Ok(Saved { scores: s.scores, notes: s.notes, warning: None }),
            Err(e) => {
                let secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let backup = path.with_extension(format!("json.unreadable-{secs}"));
                fs::rename(path, &backup).map_err(|e| e.to_string())?;
                let warning = format!(
                    "The saved scores could not be read ({e}), so this folder starts unscored. \
                     The unreadable file was moved to {}.",
                    backup.display()
                );
                Ok(Saved { warning: Some(warning), ..Default::default() })
            }
        }
    }

    /// `filter` is `Some(filenames)` for CLI file-list mode, `None` for full-folder mode.
    fn load_or_create(folder: &Path, filter: Option<Vec<String>>) -> Result<Session, String> {
        let path = Self::state_path(folder);
        let folder_str = folder.to_string_lossy().to_string();

        // Determine the file list for this session
        let mut pdf_files: Vec<String> = match &filter {
            Some(names) => names.clone(),
            None => fs::read_dir(folder)
                .map_err(|e| e.to_string())?
                .filter_map(|entry| {
                    let entry = entry.ok()?;
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.to_lowercase().ends_with(".pdf") { Some(name) } else { None }
                })
                .collect(),
        };
        pdf_files.sort();
        pdf_files.dedup();

        // Carry over any existing scores and notes from the state file
        let Saved { scores: mut saved_scores, notes: mut saved_notes, warning } = Self::load_saved(&path)?;

        let scores = pdf_files
            .iter()
            .map(|name| (name.clone(), saved_scores.remove(name).flatten()))
            .collect();

        let notes = pdf_files
            .iter()
            .filter_map(|name| saved_notes.remove(name).map(|n| (name.clone(), n)))
            .collect();

        saved_scores.retain(|_, score| score.is_some());

        Ok(Session {
            folder: folder_str,
            filter,
            scores,
            notes,
            retained_scores: saved_scores,
            retained_notes: saved_notes,
            load_warning: warning,
        })
    }

    fn save(&self) -> Result<(), String> {
        let path = Self::state_path(Path::new(&self.folder));
        let mut on_disk = self.clone();
        on_disk.scores.extend(self.retained_scores.clone());
        on_disk.notes.extend(self.retained_notes.clone());
        let data = serde_json::to_string_pretty(&on_disk).map_err(|e| e.to_string())?;
        // Write then rename, so a crash or sync conflict mid-write cannot leave a truncated file
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, data).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }
}

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub score: Option<Score>,
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SessionView {
    pub folder: String,
    pub files: Vec<FileEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

impl From<&Session> for SessionView {
    fn from(s: &Session) -> Self {
        SessionView {
            folder: s.folder.clone(),
            files: s
                .scores
                .iter()
                .map(|(name, score)| FileEntry {
                    name: name.clone(),
                    score: score.clone(),
                    note: s.notes.get(name).cloned(),
                })
                .collect(),
            warning: None,
        }
    }
}

// ── CLI argument handling ──────────────────────────────────────────────────────

enum CliInput {
    Dir(PathBuf),
    Files { dir: PathBuf, names: Vec<String> },
}

/// `args` excludes the program name. `Ok(None)` means there were no arguments.
fn parse_cli_input(args: impl IntoIterator<Item = String>) -> Result<Option<CliInput>, String> {
    let args: Vec<String> = args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .collect();

    if args.is_empty() { return Ok(None); }

    // Single directory argument
    let first = PathBuf::from(&args[0]);
    if first.is_dir() {
        return Ok(Some(CliInput::Dir(first.canonicalize().unwrap_or(first))));
    }

    // One or more PDF file arguments, resolved to canonical paths
    let pdfs: Vec<PathBuf> = args.iter()
        .map(|a| {
            let p = PathBuf::from(a);
            let is_pdf = p.extension().map(|e| e.eq_ignore_ascii_case("pdf")).unwrap_or(false);
            match p.canonicalize() {
                Ok(c) if is_pdf && c.is_file() => Ok(c),
                _ => Err(format!("Not a folder or an existing PDF file: {a}")),
            }
        })
        .collect::<Result<_, _>>()?;

    // The session is keyed by filename within one folder, so every file must share it:
    // otherwise b/y.pdf would be looked up as a/y.pdf
    let dir = pdfs[0].parent().ok_or("PDF file has no parent folder")?.to_path_buf();
    if let Some(other) = pdfs.iter().find(|p| p.parent() != Some(dir.as_path())) {
        return Err(format!(
            "All PDF files must be in the same folder: {} is not in {}",
            other.display(),
            dir.display()
        ));
    }
    let names = pdfs.iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .collect();

    Ok(Some(CliInput::Files { dir, names }))
}

#[tauri::command]
async fn get_cli_session(app: tauri::AppHandle) -> Result<Option<SessionView>, String> {
    let Some(input) = parse_cli_input(std::env::args().skip(1))? else { return Ok(None); };

    let (dir, filter) = match input {
        CliInput::Dir(dir)            => (dir, None),
        CliInput::Files { dir, names } => (dir, Some(names)),
    };

    open_session(&app, Session::load_or_create(&dir, filter)?).map(Some)
}

/// Save a newly loaded session, make it current, and return its view with any load warning.
fn open_session(app: &tauri::AppHandle, mut session: Session) -> Result<SessionView, String> {
    session.save()?;
    let warning = session.load_warning.take();
    let view = SessionView { warning, ..SessionView::from(&session) };
    *app.state::<std::sync::Mutex<Option<Session>>>().lock().unwrap_or_else(|e| e.into_inner()) = Some(session);
    Ok(view)
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[tauri::command]
async fn select_folder(app: tauri::AppHandle) -> Result<SessionView, String> {
    use tauri_plugin_dialog::DialogExt;

    let folder = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .ok_or_else(|| "cancelled".to_string())?;

    let path = folder.as_path().ok_or("invalid path")?.to_path_buf();
    open_session(&app, Session::load_or_create(&path, None)?)
}

#[tauri::command]
async fn get_session(app: tauri::AppHandle) -> Result<Option<SessionView>, String> {
    let state = app.state::<std::sync::Mutex<Option<Session>>>();
    let guard = state.lock().unwrap_or_else(|e| e.into_inner());
    Ok(guard.as_ref().map(SessionView::from))
}

#[tauri::command]
async fn set_score(app: tauri::AppHandle, filename: String, score: Option<Score>) -> Result<SessionView, String> {
    let state = app.state::<std::sync::Mutex<Option<Session>>>();
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    let session = guard.as_mut().ok_or("no session")?;
    if session.scores.contains_key(&filename) {
        session.scores.insert(filename, score);
        session.save()?;
        Ok(SessionView::from(&*session))
    } else {
        Err(format!("unknown file: {filename}"))
    }
}

#[tauri::command]
async fn set_note(app: tauri::AppHandle, filename: String, note: String) -> Result<(), String> {
    let state = app.state::<std::sync::Mutex<Option<Session>>>();
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    let session = guard.as_mut().ok_or("no session")?;
    if !session.scores.contains_key(&filename) {
        return Err(format!("unknown file: {filename}"));
    }
    if note.is_empty() {
        session.notes.remove(&filename);
    } else {
        session.notes.insert(filename, note);
    }
    session.save()
}

#[tauri::command]
async fn get_pdf_url(app: tauri::AppHandle, filename: String) -> Result<String, String> {
    let state = app.state::<std::sync::Mutex<Option<Session>>>();
    let guard = state.lock().unwrap_or_else(|e| e.into_inner());
    let session = guard.as_ref().ok_or("no session")?;
    let path = Path::new(&session.folder).join(&filename);
    if path.exists() {
        Ok(path.to_string_lossy().to_string())
    } else {
        Err(format!("file not found: {filename}"))
    }
}

#[tauri::command]
async fn export_csv(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let state = app.state::<std::sync::Mutex<Option<Session>>>();
    let guard = state.lock().unwrap_or_else(|e| e.into_inner());
    let session = guard.as_ref().ok_or("no session")?;
    let rows: Vec<(String, String, String)> = session
        .scores
        .iter()
        .map(|(name, score)| {
            let score_str = score.as_ref().map(Score::as_str).unwrap_or("unscored").to_string();
            let note_str = session.notes.get(name).cloned().unwrap_or_default();
            (name.clone(), score_str, note_str)
        })
        .collect();
    drop(guard);

    let save_path = app
        .dialog()
        .file()
        .add_filter("CSV", &["csv"])
        .set_file_name("scores.csv")
        .blocking_save_file()
        .ok_or_else(|| "cancelled".to_string())?;

    let path = save_path.as_path().ok_or("invalid path")?.to_path_buf();
    let mut wtr = csv::Writer::from_path(&path).map_err(|e| e.to_string())?;
    wtr.write_record(["filename", "score", "note"]).map_err(|e| e.to_string())?;
    for (name, score, note) in rows {
        wtr.write_record([&name, &score, &note]).map_err(|e| e.to_string())?;
    }
    wtr.flush().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// ── App entry point ────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(std::sync::Mutex::new(None::<Session>))
        .invoke_handler(tauri::generate_handler![
            select_folder,
            get_session,
            get_cli_session,
            set_score,
            set_note,
            get_pdf_url,
            export_csv,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh, empty directory under the system temp dir.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qsp-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(dir: &Path, names: &[&str]) {
        for n in names { fs::write(dir.join(n), b"%PDF-1.4\n").unwrap(); }
    }

    fn read_state(dir: &Path) -> Session {
        serde_json::from_str(&fs::read_to_string(Session::state_path(dir)).unwrap()).unwrap()
    }

    #[test]
    fn file_list_session_keeps_scores_of_unlisted_files() {
        let dir = temp_dir("retain");
        touch(&dir, &["a.pdf", "b.pdf"]);
        let mut full = Session::load_or_create(&dir, None).unwrap();
        full.scores.insert("a.pdf".into(), Some(Score::Green));
        full.scores.insert("b.pdf".into(), Some(Score::Red));
        full.notes.insert("b.pdf".into(), "keep me".into());
        full.save().unwrap();

        let mut partial = Session::load_or_create(&dir, Some(vec!["a.pdf".into()])).unwrap();
        assert_eq!(partial.scores.keys().collect::<Vec<_>>(), ["a.pdf"]);
        partial.scores.insert("a.pdf".into(), Some(Score::Amber));
        partial.save().unwrap();

        let on_disk = read_state(&dir);
        assert_eq!(on_disk.scores["a.pdf"], Some(Score::Amber));
        assert_eq!(on_disk.scores["b.pdf"], Some(Score::Red));
        assert_eq!(on_disk.notes["b.pdf"], "keep me");
        assert!(!Session::state_path(&dir).with_extension("json.tmp").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unparseable_state_file_is_moved_aside_not_overwritten() {
        let dir = temp_dir("corrupt");
        touch(&dir, &["a.pdf"]);
        fs::write(Session::state_path(&dir), "{ truncated").unwrap();

        let session = Session::load_or_create(&dir, None).unwrap();
        assert!(session.load_warning.as_deref().unwrap_or("").contains("unreadable-"));
        session.save().unwrap();

        let backups: Vec<_> = fs::read_dir(&dir).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("quick-score-pdf.json.unreadable-"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(dir.join(&backups[0])).unwrap(), "{ truncated");
        assert_eq!(read_state(&dir).scores["a.pdf"], None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cli_files_must_share_a_folder() {
        let dir = temp_dir("cli");
        fs::create_dir_all(dir.join("x")).unwrap();
        fs::create_dir_all(dir.join("y")).unwrap();
        touch(&dir.join("x"), &["a.pdf", "b.pdf"]);
        touch(&dir.join("y"), &["b.pdf"]);
        let arg = |p: &str| dir.join(p).to_string_lossy().to_string();

        match parse_cli_input([arg("x/a.pdf"), arg("x/b.pdf")]) {
            Ok(Some(CliInput::Files { dir: d, names })) => {
                assert_eq!(d, dir.join("x").canonicalize().unwrap());
                assert_eq!(names, ["a.pdf", "b.pdf"]);
            }
            _ => panic!("expected a file list"),
        }
        let err = |args: Vec<String>| parse_cli_input(args).err().unwrap_or_default();
        assert!(err(vec![arg("x/a.pdf"), arg("y/b.pdf")]).contains("same folder"));
        assert!(err(vec![arg("x/a.pdf"), arg("x/missing.pdf")]).contains("missing.pdf"));
        assert!(matches!(parse_cli_input(Vec::<String>::new()), Ok(None)));
        fs::remove_dir_all(&dir).unwrap();
    }
}
