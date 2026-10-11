use aes_kw::{KeyInit, KwAes128};
use aes_gcm::{Aes128Gcm, Nonce, aead::{Aead, Payload}};
use base64::{
    Engine as _,
    engine::general_purpose::URL_SAFE_NO_PAD,
};
use hkdf::Hkdf;
use pbkdf2::pbkdf2_hmac;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use super::{CryptoError, is_ecmascript_whitespace};

const PROTOCOL_SALT: &[u8] = b"kurobako/v4";
const PBKDF2_ITERATIONS: u32 = 600_000;

const NAMESPACE_KEY_INFO: &[u8] =
    b"kurobako/v4/namespace";

const WRITE_KEY_INFO: &[u8] =
    b"kurobako/v4/write";

pub fn derive_from_namespace(
    namespace: &str,
) -> Result<NamespaceKeys, CryptoError> {
    let secret = namespace
        .strip_prefix("e#")
        .ok_or(
            CryptoError::InvalidNamespaceName
        )?;

    derive_namespace_keys(secret)
}

#[derive(Debug, Clone)]
pub struct NamespaceKeys {
    pub secret: [u8; 32],

    pub id: [u8; 16],

    pub namespace_key: [u8; 16],

    pub write_key: [u8; 16],
}

impl NamespaceKeys {
    /// Seals one item key for a shared view, never exposing the namespace key.
    pub fn seal_view_entry(
        &self,
        view_id: &str,
        item_key: &[u8; 16],
    ) -> Result<String, CryptoError> {
        if URL_SAFE_NO_PAD.decode(view_id)?.len() != 16 {
            return Err(CryptoError::InvalidViewId);
        }
        let hkdf = Hkdf::<Sha256>::new(Some(&[]), &self.secret);
        let mut view_key = [0u8; 16];
        hkdf.expand(format!("kurobako/v6/view/{view_id}").as_bytes(), &mut view_key)
            .map_err(|_| CryptoError::Authentication)?;
        let cipher = Aes128Gcm::new_from_slice(&view_key)
            .map_err(|_| CryptoError::Authentication)?;
        let mut iv = [0u8; 12];
        rand::fill(&mut iv);
        let aad = format!("kurobako/v6/view-entry/{view_id}");
        let sealed = cipher.encrypt(
            &Nonce::from(iv),
            Payload { msg: item_key, aad: aad.as_bytes() },
        ).map_err(|_| CryptoError::Authentication)?;
        let mut envelope = Vec::with_capacity(iv.len() + sealed.len());
        envelope.extend_from_slice(&iv);
        envelope.extend_from_slice(&sealed);
        Ok(URL_SAFE_NO_PAD.encode(envelope))
    }

    pub fn id_text(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.id)
    }

    pub fn write_key_text(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.write_key)
    }

    #[cfg(test)]
    pub fn read_token(&self) -> String {
        let mut token = [0u8; 32];

        token[..16]
            .copy_from_slice(&self.id);

        token[16..]
            .copy_from_slice(&self.namespace_key);

        URL_SAFE_NO_PAD.encode(token)
    }

    pub fn wrap_item_key(
        &self,
        item_key: &[u8; 16],
    ) -> Result<[u8; 24], CryptoError> {
        let kw = KwAes128::new(
            &self.namespace_key.into()
        );

        let mut wrapped = [0u8; 24];

        kw.wrap_key(
            item_key,
            &mut wrapped,
        )
        .map_err(|_| CryptoError::InvalidWrappedKey)?;

        Ok(wrapped)
    }

    pub fn unwrap_item_key(
        &self,
        wrapped: &[u8; 24],
    ) -> Result<[u8; 16], CryptoError> {
        let kw = KwAes128::new(
            &self.namespace_key.into()
        );

        let mut item_key = [0u8; 16];

        kw.unwrap_key(
            wrapped,
            &mut item_key,
        )
        .map_err(|_| CryptoError::InvalidWrappedKey)?;

        Ok(item_key)
    }
}

pub fn normalize_secret_name(
    name: &str,
) -> String {
    name
        .nfc()
        .collect::<String>()
        .trim_matches(is_ecmascript_whitespace)
        .to_owned()
}

pub fn derive_namespace_keys(
    name: &str,
) -> Result<NamespaceKeys, CryptoError> {
    let name = normalize_secret_name(name);

    if name.is_empty() || name.contains('/') {
        return Err(
            CryptoError::InvalidNamespaceName
        );
    }

    /*
     * K:
     *
     * PBKDF2-HMAC-SHA256
     * password = normalized secret name
     * salt     = "kurobako/v4"
     * rounds   = 600000
     * output   = 32 bytes
     */
    let mut secret = [0u8; 32];

    pbkdf2_hmac::<Sha256>(
        name.as_bytes(),
        PROTOCOL_SALT,
        PBKDF2_ITERATIONS,
        &mut secret,
    );

    /*
     * The JS reference uses an empty HKDF salt.
     */
    let hkdf =
        Hkdf::<Sha256>::new(
            Some(&[]),
            &secret,
        );

    let mut id = [0u8; 16];
    let mut namespace_key = [0u8; 16];
    let mut write_key = [0u8; 16];

    hkdf.expand(
        NAMESPACE_KEY_INFO,
        &mut namespace_key,
    )
    .expect("16-byte HKDF output is valid");

    hkdf.expand(
        WRITE_KEY_INFO,
        &mut write_key,
    )
    .expect("16-byte HKDF output is valid");

    let verifier = Sha256::digest(URL_SAFE_NO_PAD.encode(write_key).as_bytes());
    id.copy_from_slice(&verifier[..16]);

    Ok(NamespaceKeys {
        secret,
        id,
        namespace_key,
        write_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn protocol_v6_namespace_vector() {
        let keys = derive_namespace_keys(
            "\u{3000}\u{FEFF} Koma never leaves くろは\u{3099}こ 🐈\u{200D}⬛📦 ﾑｹﾞﾝ♾\u{FE0F}\u{0085} \t"
        )
        .unwrap();

        assert_eq!(
            hex(&keys.secret),
            "76c6180cb6affa091c516d141d27109a8fc2e8e7b2f1a0051aee960c5107a15d"
        );

        assert_eq!(
            keys.id_text(),
            "PSQbmOAAKv22JHSTgC4bTQ"
        );

        assert_eq!(
            hex(&keys.namespace_key),
            "4709c7de00a34cd9bb823a9a5711b544"
        );

        assert_eq!(
            keys.write_key_text(),
            "dt58FtvGKfYf65PBO3ZGow"
        );

        assert_eq!(
            keys.read_token(),
            "PSQbmOAAKv22JHSTgC4bTUcJx94Ao0zZu4I6mlcRtUQ"
        );
    }

    #[test]
    fn secret_name_whitespace_matches_javascript() {
        assert_eq!(
            normalize_secret_name("\u{FEFF} café \u{FEFF}"),
            "café"
        );
        assert_eq!(
            normalize_secret_name("\u{0085}café\u{0085}"),
            "\u{0085}café\u{0085}"
        );
    }
}
