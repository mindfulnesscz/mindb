const SERVICE_NAME: &str = "com.sotto.desktop.oauth";

fn entry(account: &str) -> Result<keyring::Entry, String> {
    if account.trim().is_empty() {
        return Err("Keychain account must not be empty".into());
    }
    keyring::Entry::new(SERVICE_NAME, account)
        .map_err(|error| format!("Could not open the OS keychain: {error}"))
}

#[tauri::command]
pub fn keychain_set_secret(account: String, secret: String) -> Result<(), String> {
    entry(&account)?
        .set_password(&secret)
        .map_err(|error| format!("Could not save credentials in the OS keychain: {error}"))
}

#[tauri::command]
pub fn keychain_get_secret(account: String) -> Result<Option<String>, String> {
    match entry(&account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Could not read credentials from the OS keychain: {error}")),
    }
}

#[tauri::command]
pub fn keychain_delete_secret(account: String) -> Result<(), String> {
    match entry(&account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Could not delete credentials from the OS keychain: {error}")),
    }
}
