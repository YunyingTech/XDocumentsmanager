use base64::{engine::general_purpose::STANDARD, Engine};

#[cfg(windows)]
pub fn encrypt_credential(plaintext: &str) -> Result<String, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };
    use windows_sys::Win32::Foundation::LocalFree;

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
    let ok = unsafe {
        CryptProtectData(
            &mut input,
            null(),
            null(),
            null_mut(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let encoded = STANDARD.encode(bytes);
    unsafe { LocalFree(output.pbData as _) };
    Ok(encoded)
}

#[cfg(windows)]
pub fn decrypt_credential(ciphertext: &str) -> Result<String, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };
    use windows_sys::Win32::Foundation::LocalFree;

    let mut encrypted = STANDARD.decode(ciphertext).map_err(|e| e.to_string())?;
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            null_mut(),
            null(),
            null_mut(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let value = String::from_utf8(bytes.to_vec()).map_err(|e| e.to_string())?;
    unsafe { LocalFree(output.pbData as _) };
    Ok(value)
}

#[cfg(not(windows))]
pub fn encrypt_credential(plaintext: &str) -> Result<String, String> {
    Ok(STANDARD.encode(plaintext.as_bytes()))
}

#[cfg(not(windows))]
pub fn decrypt_credential(ciphertext: &str) -> Result<String, String> {
    let bytes = STANDARD.decode(ciphertext).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}
