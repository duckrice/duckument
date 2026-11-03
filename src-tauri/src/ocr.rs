//! Text in pictures (scanned pages), read by Windows' own OCR in the languages the user has
//! in Windows. Nothing is sent anywhere, and nothing extra is installed.

use tauri::ipc::{InvokeBody, Request};

/// A word found: its text and its box in the picture, in pixels (x, y, width, height).
type Word = (String, f32, f32, f32, f32);

/// The words in a PNG picture, top to bottom, line by line.
#[tauri::command]
pub async fn ocr_image(request: Request<'_>) -> Result<Vec<Word>, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("ocr_image expects a binary body".into());
    };
    let png = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || read(&png))
        .await
        .map_err(|err| err.to_string())?
}

#[cfg(windows)]
fn read(png: &[u8]) -> Result<Vec<Word>, String> {
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
    let run = || -> windows::core::Result<Vec<Word>> {
        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream)?;
        writer.WriteBytes(png)?;
        writer.StoreAsync()?.join()?;
        writer.FlushAsync()?.join()?;
        writer.DetachStream()?;
        stream.Seek(0)?;
        let bitmap = BitmapDecoder::CreateAsync(&stream)?.join()?.GetSoftwareBitmapAsync()?.join()?;
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
        let result = engine.RecognizeAsync(&bitmap)?.join()?;
        let mut words = Vec::new();
        for line in result.Lines()? {
            for word in line.Words()? {
                let r = word.BoundingRect()?;
                words.push((word.Text()?.to_string(), r.X, r.Y, r.Width, r.Height));
            }
        }
        Ok(words)
    };
    run().map_err(|err| format!("Windows couldn't read the text: {}", err.message()))
}

/// Elsewhere (Linux): the free Tesseract program, in the user's language (LANG) and English,
/// as far as their language data is installed (on Arch: pacman -S tesseract tesseract-data-eng).
#[cfg(not(windows))]
fn read(png: &[u8]) -> Result<Vec<Word>, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let missing = |_| "Reading text in scans needs Tesseract (on Arch: sudo pacman -S tesseract tesseract-data-eng).".to_string();
    let listed = Command::new("tesseract").arg("--list-langs").output().map_err(missing)?;
    let installed: Vec<String> = String::from_utf8_lossy(&listed.stdout).lines().skip(1).map(|l| l.trim().to_string()).collect();
    let locale = std::env::var("LANG").unwrap_or_default();
    let langs = languages(&installed, &locale);
    if langs.is_empty() {
        return Err("Tesseract has no language data (on Arch: sudo pacman -S tesseract-data-eng).".into());
    }
    let mut child = Command::new("tesseract")
        .args(["stdin", "stdout", "-l", &langs.join("+"), "tsv"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(missing)?;
    child.stdin.take().unwrap().write_all(png).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("Tesseract couldn't read the text.".into());
    }
    Ok(words(&String::from_utf8_lossy(&out.stdout)))
}

/// Tesseract's names for the user's language and English, those that are installed.
#[cfg(any(not(windows), test))]
fn languages(installed: &[String], locale: &str) -> Vec<String> {
    let own = match locale.get(..2).unwrap_or("") {
        "nb" | "nn" | "no" => "nor",
        "de" => "deu",
        "sv" => "swe",
        "da" => "dan",
        "fr" => "fra",
        "es" => "spa",
        _ => "eng",
    };
    let mut out: Vec<String> = [own, "eng"].iter().filter(|l| installed.iter().any(|i| i == *l)).map(|l| l.to_string()).collect();
    out.dedup();
    out
}

/// The words in Tesseract's TSV output (level 5 rows: left, top, width, height, …, text).
#[cfg(any(not(windows), test))]
fn words(tsv: &str) -> Vec<Word> {
    tsv.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() < 12 || f[0] != "5" || f[11].trim().is_empty() {
                return None;
            }
            let n = |i: usize| f[i].parse::<f32>().ok();
            Some((f[11].to_string(), n(6)?, n(7)?, n(8)?, n(9)?))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tesseract_words() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
                   4\t1\t1\t1\t1\t0\t10\t20\t200\t30\t-1\t\n\
                   5\t1\t1\t1\t1\t1\t10\t20\t80\t30\t96.5\tBlåbær\n\
                   5\t1\t1\t1\t1\t2\t100\t20\t110\t30\t91\tsyltetøy\n";
        assert_eq!(words(tsv), vec![("Blåbær".to_string(), 10.0, 20.0, 80.0, 30.0), ("syltetøy".to_string(), 100.0, 20.0, 110.0, 30.0)]);
        let installed = ["eng".to_string(), "nor".to_string(), "osd".to_string()];
        assert_eq!(languages(&installed, "nb_NO.UTF-8"), ["nor", "eng"]);
        assert_eq!(languages(&installed, "C"), ["eng"]);
        assert!(languages(&["osd".to_string()], "de_DE").is_empty());
    }
}
