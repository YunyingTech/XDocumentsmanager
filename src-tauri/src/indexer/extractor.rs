// PDF text extraction — will use pdfium-render in Phase 2
// For Phase 1, this is a placeholder that extracts basic file metadata.

use std::path::Path;

/// Extract metadata and a text preview from a PDF file.
/// Phase 1: returns file system metadata only (no text extraction).
/// Phase 2: will use pdfium-render for full text extraction.
pub struct PdfMetadata {
    pub page_count: Option<i32>,
    pub text_content: String,
    pub text_preview: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
}

pub fn extract_pdf_metadata(path: &Path) -> Result<PdfMetadata, String> {
    // Phase 1: Placeholder — read first few KB to check if it's a valid PDF
    let content = std::fs::read(path)
        .map_err(|e| format!("Cannot read file: {}", e))?;

    // Check PDF header
    if content.len() < 5 || &content[0..5] != b"%PDF-" {
        return Err("Not a valid PDF file".to_string());
    }

    // Basic text preview: extract readable ASCII from first 8KB
    let preview = content.iter()
        .take(8192)
        .filter(|&&b| b.is_ascii_graphic() || b == b' ' || b == b'\n')
        .map(|&b| b as char)
        .collect::<String>()
        .chars()
        .take(500)
        .collect::<String>();

    Ok(PdfMetadata {
        page_count: None, // Will be populated when pdfium-render is integrated
        text_content: String::new(),
        text_preview: if preview.is_empty() { "PDF content (text extraction coming in Phase 2)".to_string() } else { preview },
        title: None,
        author: None,
        subject: None,
        keywords: None,
    })
}
