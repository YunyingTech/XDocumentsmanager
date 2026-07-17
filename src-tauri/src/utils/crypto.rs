// AES-GCM encryption for SMB credentials — Phase 2
// For Phase 1, credentials are stored as-is (no encryption).
// Phase 2 will use aes-gcm crate with a randomly generated key stored
// in the OS credential manager via Tauri's stronghold plugin.

pub fn encrypt_credential(_plaintext: &str) -> String {
    // Phase 1: pass-through
    _plaintext.to_string()
}

pub fn decrypt_credential(_ciphertext: &str) -> String {
    // Phase 1: pass-through
    _ciphertext.to_string()
}
