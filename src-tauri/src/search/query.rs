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
    match request_connection_probe(db, &config).await {
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

async fn request_connection_probe(db: &Database, config: &OpenAiConfig) -> Result<(), String> {
    let payload = json!({
        "model": config.model,
        "max_tokens": 64,
        "stream": false,
        "messages": [
            { "role": "user", "content": "Reply with OK." }
        ]
    });
    let value = send_chat_completion(db, config, payload).await?;
    if value.pointer("/choices/0").is_none() {
        return Err("Response has no choices[0]".to_string());
    }
    Ok(())
}

async fn request_terms(
    db: &Database,
    config: &OpenAiConfig,
    query: &str,
) -> Result<QueryTerms, String> {
    let payload = json!({
        "model": config.model,
        "temperature": 0,
        "max_tokens": 1024,
        "stream": false,
        "response_format": { "type": "json_object" },
        "messages": [
            {
                "role": "system",
                "content": "You prepare search terms for a Chinese and English PDF policy archive. Return only JSON with arrays named keywords and phrases. Extract named entities and core concepts, then add useful aliases, full names, synonyms, and closely related policy or incident-response terminology. Produce 6 to 12 concise candidates in the user's language. Preserve names, identifiers, dates, and quoted wording. Do not answer the request and do not include generic filler words."
            },
            { "role": "user", "content": query }
        ]
    });
    let value = send_chat_completion(db, config, payload).await?;
    parse_query_terms(&value)
}

async fn send_chat_completion(
    db: &Database,
    config: &OpenAiConfig,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let protected = setting(db, "openai_api_key_protected", "");
    let api_key = decrypt_credential(&protected)?;
    let endpoint = chat_completions_url(&config.endpoint);
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(&endpoint)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if body.trim().is_empty() {
        return Err(format!("{} returned an empty response", endpoint));
    }
    if !status.is_success() {
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .and_then(|message| message.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| truncate(&body, 2_000));
        return Err(format!("{status}: {message}"));
    }
    serde_json::from_str(&body).map_err(|error| {
        format!(
            "{} returned invalid JSON: {}. Response: {}",
            endpoint,
            error,
            truncate(&body, 500)
        )
    })
}

fn parse_query_terms(value: &serde_json::Value) -> Result<QueryTerms, String> {
    let finish_reason = value
        .pointer("/choices/0/finish_reason")
        .and_then(|reason| reason.as_str())
        .unwrap_or("unknown");
    let content = message_content(value)
        .ok_or_else(|| "Response has no choices[0].message.content".to_string())?;
    let cleaned = content.trim();
    if cleaned.is_empty() {
        return Err(format!(
            "The model returned an empty message (finish_reason: {finish_reason}). It may have exhausted its output tokens; retry or choose a non-reasoning model."
        ));
    }

    let unfenced = cleaned
        .strip_prefix("```json")
        .or_else(|| cleaned.strip_prefix("```JSON"))
        .or_else(|| cleaned.strip_prefix("```"))
        .unwrap_or(cleaned);
    let unfenced = unfenced.strip_suffix("```").unwrap_or(unfenced).trim();
    if let Ok(terms) = serde_json::from_str(unfenced) {
        return Ok(terms);
    }
    if let (Some(start), Some(end)) = (unfenced.find('{'), unfenced.rfind('}')) {
        if start < end {
            if let Ok(terms) = serde_json::from_str(&unfenced[start..=end]) {
                return Ok(terms);
            }
        }
    }
    serde_json::from_str(unfenced).map_err(|error| {
        format!(
            "Invalid structured query response: {}. Response: {}",
            error,
            truncate(unfenced, 500)
        )
    })
}

fn message_content(value: &serde_json::Value) -> Option<String> {
    if let Some(content) = value.pointer("/choices/0/message/content") {
        if let Some(text) = content.as_str() {
            return Some(text.to_string());
        }
        if let Some(parts) = content.as_array() {
            return Some(
                parts
                    .iter()
                    .filter_map(|part| {
                        part.as_str().or_else(|| {
                            part.get("text").and_then(|text| text.as_str()).or_else(|| {
                                part.pointer("/text/value").and_then(|text| text.as_str())
                            })
                        })
                    })
                    .collect::<Vec<_>>()
                    .join(""),
            );
        }
    }
    value
        .pointer("/choices/0/message/tool_calls/0/function/arguments")
        .and_then(|arguments| arguments.as_str())
        .or_else(|| {
            value
                .pointer("/choices/0/text")
                .and_then(|text| text.as_str())
        })
        .map(str::to_string)
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
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
    use super::{chat_completions_url, message_content, normalize_terms, parse_query_terms};

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

    #[test]
    fn parses_fenced_and_part_based_query_responses() {
        let value = serde_json::json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "content": [
                        { "type": "text", "text": "```json\n" },
                        { "type": "text", "text": "{\"keywords\":[\"网络安全\"],\"phrases\":[]}" },
                        { "type": "text", "text": "\n```" }
                    ]
                }
            }]
        });
        assert!(message_content(&value).unwrap().contains("网络安全"));
        assert_eq!(
            parse_query_terms(&value).unwrap().keywords,
            vec!["网络安全"]
        );
    }

    #[test]
    fn explains_empty_model_messages() {
        let value = serde_json::json!({
            "choices": [{
                "finish_reason": "length",
                "message": { "content": "" }
            }]
        });
        let error = parse_query_terms(&value).unwrap_err();
        assert!(error.contains("empty message"));
        assert!(error.contains("length"));
    }

    #[test]
    fn parses_tool_call_arguments_and_embedded_json() {
        let tool_call = serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "arguments": "{\"keywords\":[\"audit\"],\"phrases\":[\"risk report\"]}"
                        }
                    }]
                }
            }]
        });
        assert_eq!(
            parse_query_terms(&tool_call).unwrap().phrases,
            vec!["risk report"]
        );

        let wrapped = serde_json::json!({
            "choices": [{
                "message": {
                    "content": "Here is the result: {\"keywords\":[\"security\"],\"phrases\":[]} done"
                }
            }]
        });
        assert_eq!(
            parse_query_terms(&wrapped).unwrap().keywords,
            vec!["security"]
        );
    }

    #[test]
    fn invalid_structured_responses_include_a_bounded_preview() {
        let value = serde_json::json!({
            "choices": [{
                "message": { "content": "x".repeat(800) }
            }]
        });
        let error = parse_query_terms(&value).unwrap_err();
        assert!(error.contains("Invalid structured query response"));
        assert!(error.chars().count() < 700);
    }
}
