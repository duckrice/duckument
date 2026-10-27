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

#[cfg(not(windows))]
fn read(_png: &[u8]) -> Result<Vec<Word>, String> {
    Err("Reading text in pictures needs Windows.".into())
}
