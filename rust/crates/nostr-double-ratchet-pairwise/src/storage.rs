use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::{PairwiseError, Result};

const STATE_PREFIX: &str = "ndr-pairwise-state-v1-";
const STATE_SUFFIX: &str = ".json";

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TestFault {
    Write,
    Rename,
}

pub trait PairwiseStore: Send + Sync {
    fn load(&self) -> Result<Option<Vec<u8>>>;
    fn commit(&self, generation: u64, payload: &[u8]) -> Result<()>;
    fn cleanup(&self, _generation: u64) {}
}

#[derive(Default)]
pub struct MemoryStore {
    value: Mutex<Option<Vec<u8>>>,
}

impl PairwiseStore for MemoryStore {
    fn load(&self) -> Result<Option<Vec<u8>>> {
        self.value
            .lock()
            .map(|value| value.clone())
            .map_err(|_| PairwiseError::Storage("memory store mutex poisoned".to_string()))
    }

    fn commit(&self, _generation: u64, payload: &[u8]) -> Result<()> {
        *self
            .value
            .lock()
            .map_err(|_| PairwiseError::Storage("memory store mutex poisoned".to_string()))? =
            Some(payload.to_vec());
        Ok(())
    }
}

pub struct FileStore {
    directory: PathBuf,
    #[cfg(test)]
    fault: Option<TestFault>,
}

impl FileStore {
    pub fn new(directory: impl Into<PathBuf>) -> Result<Self> {
        let directory = directory.into();
        fs::create_dir_all(&directory)
            .map_err(|error| storage_error("create state directory", error))?;
        set_private_directory_permissions(&directory)?;
        Ok(Self {
            directory,
            #[cfg(test)]
            fault: None,
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn generations(&self) -> Result<Vec<(u64, PathBuf)>> {
        let mut generations = Vec::new();
        for entry in fs::read_dir(&self.directory)
            .map_err(|error| storage_error("read state directory", error))?
        {
            let entry = entry.map_err(|error| storage_error("read state entry", error))?;
            let file_type = entry
                .file_type()
                .map_err(|error| storage_error("read state entry type", error))?;
            if !file_type.is_file() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(STATE_PREFIX) || !name.ends_with(STATE_SUFFIX) {
                continue;
            }
            let raw_generation = &name[STATE_PREFIX.len()..name.len() - STATE_SUFFIX.len()];
            let generation = raw_generation.parse::<u64>().map_err(|_| {
                PairwiseError::CorruptState(format!("invalid pairwise state filename `{name}`"))
            })?;
            generations.push((generation, entry.path()));
        }
        generations.sort_by_key(|(generation, _)| *generation);
        Ok(generations)
    }

    fn state_path(&self, generation: u64) -> PathBuf {
        self.directory
            .join(format!("{STATE_PREFIX}{generation:020}{STATE_SUFFIX}"))
    }
}

impl PairwiseStore for FileStore {
    fn load(&self) -> Result<Option<Vec<u8>>> {
        let Some((_, path)) = self.generations()?.into_iter().last() else {
            return Ok(None);
        };
        let mut file =
            File::open(&path).map_err(|error| storage_error("open pairwise state", error))?;
        let mut payload = Vec::new();
        file.read_to_end(&mut payload)
            .map_err(|error| storage_error("read pairwise state", error))?;
        if payload.is_empty() {
            return Err(PairwiseError::CorruptState(
                "pairwise state file is empty".to_string(),
            ));
        }
        Ok(Some(payload))
    }

    fn commit(&self, generation: u64, payload: &[u8]) -> Result<()> {
        let destination = self.state_path(generation);
        if destination.exists() {
            return Err(PairwiseError::Storage(format!(
                "state generation {generation} already exists"
            )));
        }
        let temporary = self.directory.join(format!(
            ".{STATE_PREFIX}{generation:020}.{}.tmp",
            uuid::Uuid::new_v4()
        ));
        let result = (|| -> Result<()> {
            #[cfg(test)]
            if self.fault == Some(TestFault::Write) {
                return Err(PairwiseError::Storage(
                    "injected state write failure".to_string(),
                ));
            }
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            set_private_file_mode(&mut options);
            let mut file = options
                .open(&temporary)
                .map_err(|error| storage_error("create temporary state", error))?;
            file.write_all(payload)
                .map_err(|error| storage_error("write temporary state", error))?;
            file.flush()
                .map_err(|error| storage_error("flush temporary state", error))?;
            file.sync_all()
                .map_err(|error| storage_error("sync temporary state", error))?;
            #[cfg(test)]
            if self.fault == Some(TestFault::Rename) {
                return Err(PairwiseError::Storage(
                    "injected state rename failure".to_string(),
                ));
            }
            fs::rename(&temporary, &destination)
                .map_err(|error| storage_error("commit pairwise state", error))?;
            if let Err(error) = sync_directory(&self.directory) {
                let _ = fs::remove_file(&destination);
                let _ = sync_directory(&self.directory);
                return Err(error);
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
            return result;
        }

        let generations = self.generations()?;
        for (stored_generation, path) in generations {
            if stored_generation != generation {
                let _ = fs::remove_file(path);
            }
        }
        let _ = sync_directory(&self.directory);
        Ok(())
    }

    fn cleanup(&self, generation: u64) {
        if let Ok(generations) = self.generations() {
            for (stored_generation, path) in generations {
                if stored_generation != generation {
                    let _ = fs::remove_file(path);
                }
            }
            let _ = sync_directory(&self.directory);
        }
    }
}

fn storage_error(operation: &str, error: std::io::Error) -> PairwiseError {
    PairwiseError::Storage(format!("{operation}: {error}"))
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> Result<()> {
    let file =
        File::open(directory).map_err(|error| storage_error("open state directory", error))?;
    file.sync_all()
        .map_err(|error| storage_error("sync state directory", error))
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| storage_error("set state directory permissions", error))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_mode(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_private_file_mode(_options: &mut OpenOptions) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_store_ignores_other_namespaces() {
        let directory = tempfile::tempdir().expect("tempdir");
        fs::write(
            directory.path().join("protocol_engine_state.json"),
            b"legacy",
        )
        .expect("legacy file");
        let store = FileStore::new(directory.path()).expect("store");
        assert_eq!(store.load().expect("load"), None);
    }

    #[test]
    fn file_store_rejects_malformed_pairwise_generation_name() {
        let directory = tempfile::tempdir().expect("tempdir");
        fs::write(
            directory
                .path()
                .join("ndr-pairwise-state-v1-not-a-generation.json"),
            b"corrupt",
        )
        .expect("corrupt file");
        let store = FileStore::new(directory.path()).expect("store");
        assert!(matches!(store.load(), Err(PairwiseError::CorruptState(_))));
    }

    #[test]
    fn successful_commit_erases_older_generations() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = FileStore::new(directory.path()).expect("store");
        store.commit(1, b"first").expect("first commit");
        store.commit(2, b"second").expect("second commit");

        let generations = store.generations().expect("generations");
        assert_eq!(generations.len(), 1);
        assert_eq!(generations[0].0, 2);
        assert_eq!(store.load().expect("load"), Some(b"second".to_vec()));
    }

    #[test]
    fn failed_write_or_rename_preserves_last_committed_generation() {
        for fault in [TestFault::Write, TestFault::Rename] {
            let directory = tempfile::tempdir().expect("tempdir");
            let mut store = FileStore::new(directory.path()).expect("store");
            store.commit(1, b"first").expect("first commit");
            store.fault = Some(fault);

            assert!(matches!(
                store.commit(2, b"second"),
                Err(PairwiseError::Storage(_))
            ));
            store.fault = None;
            assert_eq!(store.load().expect("load"), Some(b"first".to_vec()));
            assert_eq!(store.generations().expect("generations").len(), 1);
        }
    }
}
