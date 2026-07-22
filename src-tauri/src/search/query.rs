use serde::Deserialize;
use serde_json::json;

use crate::db::Database;
use crate::models::{OpenAiConfig, OpenAiConnectionInfo, SearchQueryAnalysis};
use crate::utils::crypto::{decrypt_credential, encrypt_credential};

const DEFAULT_ENDPOINT: &str = "https://api.openai.com/v1";
const DEFAULT_MODEL: &str = "gpt-4.1-mini";

#[derive(Debug, Deserialize)]
struct QueryTerms {
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    phrases: Vec<String>,
}

pub fn load_config(db: &Database) -> OpenAiConfig {
    OpenAiConfig {
        endpoint: setting(db, "openai_endpoint", DEFAULT_ENDPOINT),
        model: setting(db, "openai_model", DEFAULT_MODEL),
        api_key_configured: !setting(db, "openai_api_key_protected", "").is_empty(),
        smart_search_enabled: setting(db, "smart_search_enabled", "true") == "true",
    }
}

pub fn save_config(
    db: &Database,
    endpoint: String,
    model: String,
    api_key: Option<String>,
    smart_search_enabled: bool,
) -> Result<OpenAiConfig, String> {
    set_setting(db, "openai_endpoint", endpoint.trim().trim_end_matches('/'))?;
    set_setting(db, "openai_model", model.trim())?;
    set_setting(
        db,
        "smart_search_enabled",
        if smart_search_enabled {
            "true"
        } else {
            "false"
        },
    )?;
    if let Some(key) = api_key {
        if key.is_empty() {
            set_setting(db, "openai_api_key_protected", "")?;
        } else {
            set_setting(
                db,
                "openai_api_key_protected",
                &encrypt_credential(key.trim())?,
            )?;
        }
    }
    Ok(load_config(db))
}

pub async fn analyze_query(db: &Database, query: &str) -> Result<SearchQueryAnalysis, String> {
    let config = load_config(db);
    if !config.smart_search_enabled {
        return Err("Smart search is disabled in settings".to_string());
    }
    if !config.api_key_configured {
        return Err("API key is not configured".to_string());
    }
    let started = std::time::Instant::now();
    let terms = request_terms(db, &config, query).await?;
    let mut all_terms = terms.phrases;
    all_terms.extend(terms.keywords);
    let all_terms = normalize_terms(all_terms);
    if all_terms.is_empty() {
        return Err("The model returned no search terms".to_string());
    }
    Ok(SearchQueryAnalysis {
        terms: all_terms,
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        model: config.model,
    })
}

fn normalize_terms(terms: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for term in terms {
        let term = term.trim().replace(['\"', '\\'], "");
        let key = term.to_lowercase();
        if !term.is_empty() && seen.insert(key) {
            normalized.push(term);
        }
        if normalized.len() == 16 {
            break;
        }
    }
    normalized
}

pub async fn test_connection(db: &Database) -> Result<OpenAiConnectionInfo, String> {
    let config = load_config(db);
    if !config.api_key_configured {
        return Ok(OpenAiConnectionInfo {
            connected: false,
            message: "API key is not configured".to_string(),
        });
    }
    match request_terms(db, &config, "quarterly compliance report").await {
        Ok(_) => Ok(OpenAiConnectionInfo {
            connected: true,
            message: format!("Connected to {}", config.model),
        }),
        Err(error) => Ok(OpenAiConnectionInfo {
            connected: false,
            message: error,
        }),
    }
}

async fn request_terms(
    db: &Database,
    config: &OpenAiConfig,
    query: &str,
) -> Result<QueryTerms, String> {
    let protected = setting(db, "openai_api_key_protected", "");
    let api_key = decrypt_credential(&protected)?;
    let endpoint = chat_completions_url(&config.endpoint);
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;
    let payload = json!({
        "model": config.model,
        "temperature": 0,
        "max_tokens": 250,
        "response_format": { "type": "json_object" },
        "messages": [
            {
                "role": "system",
                "content": "You prepare search terms for a Chinese and English PDF policy archive. Return only JSON with arrays named keywords and phrases. Extract named entities and core concepts, then add useful aliases, full names, synonyms, and closely related policy or incident-response terminology. Produce 6 to 12 concise candidates in the user's language. Preserve names, identifiers, dates, and quoted wording. Do not answer the request and do not include generic filler words."
            },
            { "role": "user", "content": query }
        ]
    });
    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let value: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let message = value
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .unwrap_or("OpenAI-compatible endpoint rejected the request");
        return Err(format!("{}: {}", status, message));
    }
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Response has no choices[0].message.content".to_string())?;
    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(cleaned).map_err(|e| format!("Invalid structured query response: {}", e))
}

fn chat_completions_url(endpoint: &str) -> String {
    let endpoint = endpoint.trim().trim_end_matches('/');
    if endpoint.ends_with("/chat/completions") {
        endpoint.to_string()
    } else if endpoint.ends_with("/v1") {
        format!("{}/chat/completions", endpoint)
    } else {
        format!("{}/v1/chat/completions", endpoint)
    }
}

fn setting(db: &Database, key: &str, default: &str) -> String {
    let conn = db.get_connection();
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .unwrap_or_else(|_| default.to_string())
}

fn set_setting(db: &Database, key: &str, value: &str) -> Result<(), String> {
    let conn = db.get_connection();
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        rusqlite::params![key, value],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{chat_completions_url, normalize_terms};

    #[test]
    fn normalizes_compatible_endpoints() {
        assert_eq!(
            chat_completions_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://localhost:11434"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://host/v1/chat/completions"),
            "http://host/v1/chat/completions"
        );
    }

    #[test]
    fn normalizes_and_deduplicates_suggested_terms() {
        assert_eq!(
            normalize_terms(vec![
                " 中科院 ".to_string(),
                "中科院".to_string(),
                "中国科学院".to_string(),
                "\\\"网络安全\\\"".to_string(),
                "".to_string(),
            ]),
            vec!["中科院", "中国科学院", "网络安全"]
        );
    }
}
