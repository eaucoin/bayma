//! Stable helpers shared by generated EVcxR crates.
//!
//! The checkpoint slot remains an ordinary EVcxR variable. Callers pass it
//! explicitly so a newly loaded dynamic library never hides durable state in
//! a library-local global.

pub use serde;
pub use serde_json;
pub use serde_json::Value;

const CHECKPOINT_PATH_ENV: &str = "BAYMA_RUST_CHECKPOINT_PATH";

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
}
