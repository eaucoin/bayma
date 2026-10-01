//! Stable helpers shared by generated EVcxR crates.
//!
//! The checkpoint slot remains an ordinary EVcxR variable. Callers pass it
//! explicitly so a newly loaded dynamic library never hides durable state in
//! a library-local global.

pub use serde;
pub use serde_json;
pub use serde_json::Value;

use std::io::Write;
use std::path::Path;

const CHECKPOINT_PATH_ENV: &str = "BAYMA_RUST_CHECKPOINT_PATH";
const IMAGE_DIR_ENV: &str = "BAYMA_RUST_IMAGE_DIR";

#[derive(Debug)]
pub enum CheckpointWriteError {
    Serialize(serde_json::Error),
    Persist(std::io::Error),
}

impl std::fmt::Display for CheckpointWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Serialize(error) => write!(formatter, "failed to serialize checkpoint: {error}"),
            Self::Persist(error) => write!(formatter, "failed to persist checkpoint: {error}"),
        }
    }
}

impl std::error::Error for CheckpointWriteError {}

pub fn decode_checkpoint(encoded: &str) -> Result<Option<Value>, serde_json::Error> {
    serde_json::from_str(encoded)
}

pub fn encode_checkpoint(value: &Option<Value>) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(value)
}

pub fn read_checkpoint<T>(slot: &Option<Value>) -> Result<Option<T>, serde_json::Error>
where
    T: serde::de::DeserializeOwned,
{
    slot.clone().map(serde_json::from_value).transpose()
}

pub fn write_checkpoint<T>(slot: &mut Option<Value>, value: &T) -> Result<(), CheckpointWriteError>
where
    T: serde::Serialize,
{
    *slot = Some(serde_json::to_value(value).map_err(CheckpointWriteError::Serialize)?);
    if let Some(path) = std::env::var_os(CHECKPOINT_PATH_ENV) {
        let encoded = encode_checkpoint(slot).map_err(CheckpointWriteError::Serialize)?;
        std::fs::write(path, encoded).map_err(CheckpointWriteError::Persist)?;
    }
    Ok(())
}

/// Shows the model `image`, the bytes of a PNG, JPEG, GIF, or WebP file,
/// when the cell ends.
pub fn display_image(image: impl AsRef<[u8]>) -> std::io::Result<()> {
    let directory = std::env::var_os(IMAGE_DIR_ENV).ok_or_else(|| {
        std::io::Error::other("display_image shows images only in a bayma session")
    })?;
    show_image(Path::new(&directory), image.as_ref())
}

/// Shows the model the image in the file at `path`, when the cell ends.
pub fn display_image_file(path: impl AsRef<Path>) -> std::io::Result<()> {
    display_image(std::fs::read(path)?)
}

/// Leaves `image` in `directory` for the host, numbered after those already
/// there, so their names sort in the order they were shown; a count kept on
/// disk holds however EVcxR loads this crate from cell to cell.
fn show_image(directory: &Path, image: &[u8]) -> std::io::Result<()> {
    let mut number = std::fs::read_dir(directory)?.count();
    loop {
        number += 1;
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join(format!("{number:08}")))
        {
            Ok(mut file) => return file.write_all(image),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct State {
        count: u64,
        label: String,
    }

    #[test]
    fn typed_checkpoint_round_trips() {
        let expected = State {
            count: 42,
            label: "héllo".to_owned(),
        };
        let mut slot = None;
        write_checkpoint(&mut slot, &expected).unwrap();
        let encoded = encode_checkpoint(&slot).unwrap();
        let decoded = decode_checkpoint(std::str::from_utf8(&encoded).unwrap()).unwrap();
        assert_eq!(read_checkpoint::<State>(&decoded).unwrap(), Some(expected));
    }

    #[test]
    fn images_are_numbered_in_the_order_they_are_shown() {
        let directory = std::env::temp_dir().join(format!("bayma-images-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        show_image(&directory, b"first").unwrap();
        show_image(&directory, b"second").unwrap();
        let mut names: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        names.sort();
        let images: Vec<_> = names.iter().map(|path| std::fs::read(path).unwrap()).collect();
        std::fs::remove_dir_all(&directory).unwrap();
        assert_eq!(images, [b"first".to_vec(), b"second".to_vec()]);
    }
}
