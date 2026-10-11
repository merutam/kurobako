use aes_gcm::{
    Aes128Gcm,
    Nonce,
    aead::{
        Aead,
        KeyInit,
        Payload,
    },
};

use base64::{
    Engine as _,
    engine::general_purpose::URL_SAFE_NO_PAD,
};

use hkdf::Hkdf;
use serde::{
    Deserialize,
    Serialize,
};
use sha2::Sha256;

use super::{
    CryptoError,
    NamespaceKeys,
};

pub const SEGMENT_BYTES: usize = 65_536;

const TAG_BYTES: usize = 16;
const IV_BYTES: usize = 12;

const METADATA_LABEL: &[u8] =
    b"kurobako/v4/metadata";

const BODY_INFO: &str =
    "kurobako/v4/body/";

const OCTET_STREAM: &str =
    "application/octet-stream";


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemMetadata {
    Text {
        title: String,
        rev: u64,
        body_id: Option<String>,
    },

    File {
        filename: String,
        mime: String,
        rev: u64,
        body_id: Option<String>,
    },
}

impl ItemMetadata {
    pub fn rev(&self) -> u64 {
        match self {
            Self::Text { rev, .. }
            | Self::File { rev, .. } => *rev,
        }
    }

    pub fn body_id(&self) -> Option<&str> {
        match self {
            Self::Text { body_id, .. }
            | Self::File { body_id, .. } => body_id.as_deref(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PackedMetadata {
    #[serde(
        skip_serializing_if = "Option::is_none"
    )]
    title: Option<String>,

    #[serde(
        skip_serializing_if = "Option::is_none"
    )]
    filename: Option<String>,

    #[serde(
        skip_serializing_if = "Option::is_none"
    )]
    mime: Option<String>,

    #[serde(
        default,
        skip_serializing_if = "is_zero"
    )]
    rev: u64,

    #[serde(rename = "bodyId", skip_serializing_if = "Option::is_none")]
    body_id: Option<String>,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}


impl From<&ItemMetadata> for PackedMetadata {
    fn from(
        metadata: &ItemMetadata,
    ) -> Self {
        match metadata {
            ItemMetadata::Text {
                title,
                rev,
                body_id,
            } => Self {
                title: (!title.is_empty())
                    .then(|| title.clone()),

                filename: None,
                mime: None,
                rev: *rev,
                body_id: body_id.clone(),
            },

            ItemMetadata::File {
                filename,
                mime,
                rev,
                body_id,
            } => Self {
                title: None,

                filename: Some(
                    filename.clone()
                ),

                mime: (
                    mime != OCTET_STREAM
                )
                .then(|| mime.clone()),

                rev: *rev,
                body_id: body_id.clone(),
            },
        }
    }
}


impl From<PackedMetadata> for ItemMetadata {
    fn from(
        metadata: PackedMetadata,
    ) -> Self {
        if let Some(filename) =
            metadata.filename
        {
            Self::File {
                filename,

                mime: metadata.mime
                    .unwrap_or_else(|| {
                        OCTET_STREAM.into()
                    }),

                rev: metadata.rev,
                body_id: metadata.body_id,
            }
        } else {
            Self::Text {
                title: metadata.title
                    .unwrap_or_default(),

                rev: metadata.rev,
                body_id: metadata.body_id,
            }
        }
    }
}

pub fn sealed_size(
    size: usize,
) -> usize {
    size
        + TAG_BYTES
            * size.div_ceil(SEGMENT_BYTES)
}

pub fn content_size(
    sealed: usize,
) -> usize {
    sealed.saturating_sub(
        TAG_BYTES
            * sealed.div_ceil(
                SEGMENT_BYTES + TAG_BYTES
            )
    )
}


fn body_key(
    item_key: &[u8; 16],
    rev: u64,
    body_id: Option<&str>,
) -> Result<[u8; 16], CryptoError> {
    let valid_id = body_id.is_some_and(|id| {
        URL_SAFE_NO_PAD.decode(id).is_ok_and(|bytes| {
            bytes.len() == 16 && URL_SAFE_NO_PAD.encode(bytes) == id
        })
    });
    if (rev == 0 && body_id.is_some()) || (rev > 0 && !valid_id) {
        return Err(CryptoError::InvalidBody);
    }
    let hkdf =
        Hkdf::<Sha256>::new(
            Some(&[]),
            item_key,
        );

    let info = if let Some(id) = body_id {
        format!("{BODY_INFO}{rev}/{id}")
    } else {
        format!("{BODY_INFO}{rev}")
    };

    let mut key = [0u8; 16];

    hkdf.expand(
        info.as_bytes(),
        &mut key,
    )
    .expect(
        "16-byte HKDF output is valid"
    );

    Ok(key)
}

fn segment_nonce(
    index: usize,
    last: bool,
) -> [u8; 12] {
    let mut nonce = [0u8; 12];

    let index_bytes =
        (index as u128).to_be_bytes();

    // Últimos 11 bytes do índice big-endian.
    nonce[..11]
        .copy_from_slice(
            &index_bytes[5..16]
        );

    nonce[11] =
        u8::from(last);

    nonce
}

pub fn seal_body(
    item_key: &[u8; 16],
    rev: u64,
    body_id: Option<&str>,
    contents: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if contents.is_empty() {
        return Err(
            CryptoError::EmptyContent
        );
    }

    let key =
        body_key(item_key, rev, body_id)?;

    let cipher =
        Aes128Gcm::new_from_slice(&key)
            .map_err(|_| {
                CryptoError::Authentication
            })?;

    let count =
        contents.len()
            .div_ceil(SEGMENT_BYTES);

    let mut body =
        Vec::with_capacity(
            sealed_size(contents.len())
        );

    for (index, piece) in
        contents
            .chunks(SEGMENT_BYTES)
            .enumerate()
    {
        let nonce =
            segment_nonce(
                index,
                index == count - 1,
            );

        let sealed = cipher
            .encrypt(
                &Nonce::from(nonce),
                piece,
            )
            .map_err(|_| {
                CryptoError::Authentication
            })?;

        body.extend_from_slice(
            &sealed
        );
    }

    Ok(body)
}


pub fn open_body(
    item_key: &[u8; 16],
    rev: u64,
    body_id: Option<&str>,
    body: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if body.is_empty() {
        return Err(
            CryptoError::InvalidBody
        );
    }

    let key =
        body_key(item_key, rev, body_id)?;

    let cipher =
        Aes128Gcm::new_from_slice(&key)
            .map_err(|_| {
                CryptoError::Authentication
            })?;

    let step =
        SEGMENT_BYTES + TAG_BYTES;

    let count =
        body.len().div_ceil(step);

    let mut contents =
        Vec::with_capacity(
            content_size(body.len())
        );

    for (index, sealed) in
        body.chunks(step).enumerate()
    {
        if sealed.len() <= TAG_BYTES {
            return Err(
                CryptoError::InvalidBody
            );
        }

        let nonce =
            segment_nonce(
                index,
                index == count - 1,
            );

        let opened = cipher
            .decrypt(
                &Nonce::from(nonce),
                sealed,
            )
            .map_err(|_| {
                CryptoError::Authentication
            })?;

        contents.extend_from_slice(
            &opened
        );
    }

    Ok(contents)
}


fn seal_metadata_with_iv(
    item_key: &[u8; 16],
    metadata: &ItemMetadata,
    iv: [u8; 12],
) -> Result<Vec<u8>, CryptoError> {
    let cipher =
        Aes128Gcm::new_from_slice(
            item_key
        )
        .map_err(|_| {
            CryptoError::Authentication
        })?;

    let json =
        serde_json::to_vec(
            &PackedMetadata::from(metadata)
        )?;

    let encrypted = cipher
        .encrypt(
            &Nonce::from(iv),
            Payload {
                msg: &json,
                aad: METADATA_LABEL,
            },
        )
        .map_err(|_| {
            CryptoError::Authentication
        })?;

    let mut sealed =
        Vec::with_capacity(
            IV_BYTES + encrypted.len()
        );

    sealed.extend_from_slice(&iv);
    sealed.extend_from_slice(
        &encrypted
    );

    Ok(sealed)
}


fn seal_metadata(
    item_key: &[u8; 16],
    metadata: &ItemMetadata,
) -> Result<Vec<u8>, CryptoError> {
    let mut iv = [0u8; 12];

    rand::fill(&mut iv);

    seal_metadata_with_iv(
        item_key,
        metadata,
        iv,
    )
}

fn open_metadata(
    item_key: &[u8; 16],
    sealed: &[u8],
) -> Result<ItemMetadata, CryptoError> {
    if sealed.len()
        < IV_BYTES + TAG_BYTES
    {
        return Err(
            CryptoError::InvalidHeader
        );
    }

    let cipher =
        Aes128Gcm::new_from_slice(
            item_key
        )
        .map_err(|_| {
            CryptoError::Authentication
        })?;

    let opened = cipher
        .decrypt(
            &Nonce::try_from(&sealed[..IV_BYTES]).map_err(|_| CryptoError::InvalidHeader)?,
            Payload {
                msg: &sealed[IV_BYTES..],
                aad: METADATA_LABEL,
            },
        )
        .map_err(|_| {
            CryptoError::Authentication
        })?;

    Ok(
        serde_json::from_slice::<
            PackedMetadata
        >(&opened)?
        .into()
    )
}

#[derive(Debug)]
pub struct SealedItem {
    pub header: String,
    pub body: Vec<u8>,
    pub item_key: [u8; 16],
}

/// An item's header, opened: what it is, before its body is fetched.
#[derive(Debug)]
pub struct OpenedHeader {
    pub metadata: ItemMetadata,
    item_key: [u8; 16],
}

impl OpenedHeader {
    pub fn open_contents(
        &self,
        body: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        open_body(
            &self.item_key,
            self.metadata.rev(),
            self.metadata.body_id(),
            body,
        )
    }
}

pub fn seal_item(
    namespace: &NamespaceKeys,
    contents: &[u8],
    metadata: ItemMetadata,
) -> Result<SealedItem, CryptoError> {
    if metadata.rev() != 0 || metadata.body_id().is_some() {
        return Err(CryptoError::InvalidBody);
    }
    let mut item_key = [0u8; 16];

    rand::fill(&mut item_key);

    let wrapped =
        namespace
            .wrap_item_key(&item_key)?;

    let sealed_metadata =
        seal_metadata(
            &item_key,
            &metadata,
        )?;

    let body =
        seal_body(
            &item_key,
            metadata.rev(),
            metadata.body_id(),
            contents,
        )?;

    let header = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(wrapped),
        URL_SAFE_NO_PAD.encode(
            sealed_metadata
        ),
    );

    Ok(SealedItem {
        header,
        body,
        item_key,
    })
}

pub fn open_header(
    namespace: &NamespaceKeys,
    header: &str,
) -> Result<OpenedHeader, CryptoError> {
    let (
        wrapped,
        sealed_metadata,
    ) = header
        .split_once('.')
        .ok_or(
            CryptoError::InvalidHeader
        )?;

    let wrapped =
        URL_SAFE_NO_PAD.decode(
            wrapped
        )?;

    let wrapped: [u8; 24] =
        wrapped
            .try_into()
            .map_err(|_| {
                CryptoError::InvalidWrappedKey
            })?;

    let item_key =
        namespace
            .unwrap_item_key(
                &wrapped
            )?;

    let sealed_metadata =
        URL_SAFE_NO_PAD.decode(
            sealed_metadata
        )?;

    let metadata =
        open_metadata(
            &item_key,
            &sealed_metadata,
        )?;

    Ok(OpenedHeader { metadata, item_key })
}


#[cfg(test)]
mod tests {
    use super::*;

    use crate::crypto::namespace::derive_namespace_keys;

    fn decode_hex<const N: usize>(
        hex: &str,
    ) -> [u8; N] {
        let mut out = [0u8; N];

        for i in 0..N {
            out[i] =
                u8::from_str_radix(
                    &hex[
                        i * 2
                        ..
                        i * 2 + 2
                    ],
                    16,
                )
                .unwrap();
        }

        out
    }

    #[test]
    fn protocol_v4_item_vectors() {
        let namespace =
            derive_namespace_keys(
                "\u{3000}\u{FEFF} Koma never leaves くろは\u{3099}こ 🐈\u{200D}⬛📦 ﾑｹﾞﾝ♾\u{FE0F}\u{0085} \t"
            )
            .unwrap();

        let item_key =
            decode_hex::<16>(
                "101112131415161718191a1b1c1d1e1f"
            );

        let metadata =
            ItemMetadata::Text {
                title: "hello".into(),
                rev: 0,
                body_id: None,
            };

        let wrapped =
            namespace
                .wrap_item_key(
                    &item_key
                )
                .unwrap();

        assert_eq!(
            URL_SAFE_NO_PAD.encode(
                wrapped
            ),
            "okrvYnnD364imYZusqEExjLqv9kZzRR6"
        );

        let iv =
            decode_hex::<12>(
                "202122232425262728292a2b"
            );

        let sealed_metadata =
            seal_metadata_with_iv(
                &item_key,
                &metadata,
                iv,
            )
            .unwrap();

        assert_eq!(
            URL_SAFE_NO_PAD.encode(
                sealed_metadata
            ),
            "ICEiIyQlJicoKSor7_bxzuVEJyjMI_CIzoXb4Mzm9sMFHqYm95kentXjPtDX"
        );

        let body =
            seal_body(
                &item_key,
                0,
                None,
                b"hello",
            )
            .unwrap();

        assert_eq!(
            URL_SAFE_NO_PAD.encode(
                &body
            ),
            "danN8DU-C7Azi4CdPMpfr4kySstY"
        );

        assert_eq!(
            open_body(
                &item_key,
                0,
                None,
                &body,
            )
            .unwrap(),
            b"hello"
        );
    }

    #[test]
    fn concurrent_replacements_use_distinct_body_keys() {
        let item_key = [7u8; 16];
        let first = URL_SAFE_NO_PAD.encode([1u8; 16]);
        let second = URL_SAFE_NO_PAD.encode([2u8; 16]);
        let a = seal_body(&item_key, 1, Some(&first), b"same text").unwrap();
        let b = seal_body(&item_key, 1, Some(&second), b"same text").unwrap();
        assert_ne!(a, b);
        assert_eq!(open_body(&item_key, 1, Some(&first), &a).unwrap(), b"same text");
        assert_eq!(open_body(&item_key, 1, Some(&second), &b).unwrap(), b"same text");
        assert!(open_body(&item_key, 1, Some(&second), &a).is_err());
        assert!(seal_body(&item_key, 1, None, b"same text").is_err());

        let vector_key = decode_hex::<16>("101112131415161718191a1b1c1d1e1f");
        let vector_id = URL_SAFE_NO_PAD.encode([1u8; 16]);
        assert_eq!(vector_id, "AQEBAQEBAQEBAQEBAQEBAQ");
        assert_eq!(
            body_key(&vector_key, 1, Some(&vector_id)).unwrap(),
            decode_hex::<16>("c3cb2f91635ae5ba9bafa23fdf730b89")
        );
        let vector_body = seal_body(&vector_key, 1, Some(&vector_id), b"edited").unwrap();
        assert_eq!(URL_SAFE_NO_PAD.encode(vector_body), "1I8cJBZPMUG9Zsxo3Zmlfzk0TVlpBA");

        let metadata = ItemMetadata::Text {
            title: "edited".into(),
            rev: 1,
            body_id: Some(vector_id),
        };
        let sealed_metadata = seal_metadata_with_iv(
            &vector_key,
            &metadata,
            decode_hex::<12>("202122232425262728292a2b"),
        ).unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&sealed_metadata),
            "ICEiIyQlJicoKSor7_bxzuVEJyjMI_2Jy53RppMgQylYW6c2WgB-8yC7EL98hvCyccIMazVTjTcescnztHMmLhiCcfTX_yliE-_HqTphneocoAyD_PtP1Q"
        );
        assert_eq!(open_metadata(&vector_key, &sealed_metadata).unwrap(), metadata);
    }
}
