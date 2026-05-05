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
}

impl Session {
    fn state_path(folder: &Path) -> PathBuf {
        folder.join("quickscore.json")
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

        // Carry over any existing scores and notes from the state file
        let (mut saved_scores, saved_notes): (BTreeMap<String, Option<Score>>, BTreeMap<String, String>) =
            if path.exists() {
                fs::read_to_string(&path)
                    .ok()
                    .and_then(|data| serde_json::from_str::<Session>(&data).ok())
                    .map(|s| (s.scores, s.notes))
                    .unwrap_or_default()
            } else {
                Default::default()
            };

        let scores = pdf_files
            .iter()
            .map(|name| (name.clone(), saved_scores.remove(name).flatten()))
            .collect();

        let notes = pdf_files
            .iter()
            .filter_map(|name| saved_notes.get(name).cloned().map(|n| (name.clone(), n)))
            .collect();

        Ok(Session { folder: folder_str, filter, scores, notes })
    }

    fn save(&self) -> Result<(), String> {
        let path = Self::state_path(Path::new(&self.folder));
        let data = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(path, data).map_err(|e| e.to_string())
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
        }
    }
}

// ── CLI argument handling ──────────────────────────────────────────────────────

enum CliInput {
    Dir(PathBuf),
    Files { dir: PathBuf, names: Vec<String> },
}

fn parse_cli_input() -> Option<CliInput> {
    let args: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .collect();

    if args.is_empty() { return None; }

    // Single directory argument
    let first = PathBuf::from(&args[0]);
    if first.is_dir() {
        return Some(CliInput::Dir(first));
    }

    // One or more PDF file arguments
    let pdfs: Vec<PathBuf> = args.iter()
        .map(PathBuf::from)
        .filter(|p| {
            p.extension().map(|e| e.eq_ignore_ascii_case("pdf")).unwrap_or(false) && p.exists()
        })
        .collect();

    if pdfs.is_empty() { return None; }

    // Resolve all paths to their canonical form and use the parent of the first
    let dir = pdfs[0].parent()?.to_path_buf();
    let names = pdfs.iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .collect();

    Some(CliInput::Files { dir, names })
}

#[tauri::command]
async fn get_cli_session(app: tauri::AppHandle) -> Result<Option<SessionView>, String> {
    let Some(input) = parse_cli_input() else { return Ok(None); };

    let (dir, filter) = match input {
        CliInput::Dir(dir)            => (dir, None),
        CliInput::Files { dir, names } => (dir, Some(names)),
    };

    let session = Session::load_or_create(&dir, filter)?;
    session.save()?;
    *app.state::<std::sync::Mutex<Option<Session>>>().lock().unwrap() = Some(session.clone());
    Ok(Some(SessionView::from(&session)))
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
    let session = Session::load_or_create(&path, None)?;
    session.save()?;

    *app.state::<std::sync::Mutex<Option<Session>>>().lock().unwrap() = Some(session.clone());
    Ok(SessionView::from(&session))
}

#[tauri::command]
async fn get_session(app: tauri::AppHandle) -> Result<Option<SessionView>, String> {
    let state = app.state::<std::sync::Mutex<Option<Session>>>();
    let guard = state.lock().unwrap();
    Ok(guard.as_ref().map(SessionView::from))
}

#[tauri::command]
async fn set_score(app: tauri::AppHandle, filename: String, score: Option<Score>) -> Result<SessionView, String> {
    let state = app.state::<std::sync::Mutex<Option<Session>>>();
    let mut guard = state.lock().unwrap();
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
    let mut guard = state.lock().unwrap();
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
    let guard = state.lock().unwrap();
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
    let guard = state.lock().unwrap();
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
