use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::{PairwiseError, Result};

const STATE_PREFIX: &str = "ndr-pairwise-state-v1-";
const STATE_SUFFIX: &str = ".json";
const TEMP_PREFIX: &str = ".ndr-pairwise-state-v1-";
const TEMP_SUFFIX: &str = ".tmp";
const LOCK_FILE_NAME: &str = ".ndr-pairwise-state-v1.lock";
/// Absolute payload ceiling enforced by [`FileStore`] before allocation or write.
pub const MAX_FILE_STORE_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TestFault {
    Write,
    Publish,
    DirectorySync,
    Cleanup,
    ShortRead,
    GrowingRead,
}

pub trait PairwiseStore: Send + Sync {
    fn load(&self) -> Result<Option<Vec<u8>>>;
    /// Atomically commits `generation` only when the durable generation is one lower.
    fn commit(&self, generation: u64, payload: &[u8]) -> Result<()>;
    fn cleanup(&self, _generation: u64) {}
}

#[derive(Default)]
pub struct MemoryStore {
    value: Mutex<MemoryValue>,
}

#[derive(Default)]
struct MemoryValue {
    generation: u64,
    payload: Option<Vec<u8>>,
}

impl PairwiseStore for MemoryStore {
    fn load(&self) -> Result<Option<Vec<u8>>> {
        self.value
            .lock()
            .map(|value| value.payload.clone())
            .map_err(|_| PairwiseError::Storage("memory store mutex poisoned".to_string()))
    }

    fn commit(&self, generation: u64, payload: &[u8]) -> Result<()> {
        let expected = previous_generation(generation)?;
        let mut value = self
            .value
            .lock()
            .map_err(|_| PairwiseError::Storage("memory store mutex poisoned".to_string()))?;
        ensure_current_generation(generation, expected, value.generation)?;
        value.payload = Some(payload.to_vec());
        value.generation = generation;
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
        let store = Self {
            directory,
            #[cfg(test)]
            fault: None,
        };
        let _lock = store.acquire_lock()?;
        sync_directory(&store.directory)?;
        store.recover_stale_temporaries_locked()?;
        Ok(store)
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn acquire_lock(&self) -> Result<File> {
        let path = self.lock_path();
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true);
        set_private_file_mode(&mut options);
        let file = options
            .open(&path)
            .map_err(|error| storage_error("open state lock", error))?;
        set_private_file_permissions(&path)?;
        file.lock()
            .map_err(|error| storage_error("lock state directory", error))?;
        Ok(file)
    }

    fn visit_generations_locked(
        &self,
        mut visitor: impl FnMut(u64, PathBuf) -> Result<()>,
    ) -> Result<()> {
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
            let Some(name) = name.to_str() else {
                continue;
            };
            let Some(generation) = parse_generation_filename(name)? else {
                continue;
            };
            visitor(generation, entry.path())?;
        }
        Ok(())
    }

    fn highest_generation_locked(&self) -> Result<Option<(u64, PathBuf)>> {
        let mut highest = None;
        self.visit_generations_locked(|generation, path| {
            if highest
                .as_ref()
                .is_none_or(|(current, _)| generation > *current)
            {
                highest = Some((generation, path));
            }
            Ok(())
        })?;
        Ok(highest)
    }

    #[cfg(test)]
    fn generations(&self) -> Result<Vec<(u64, PathBuf)>> {
        let _lock = self.acquire_lock()?;
        self.recover_stale_temporaries_locked()?;
        let mut generations = Vec::new();
        self.visit_generations_locked(|generation, path| {
            generations.push((generation, path));
            Ok(())
        })?;
        generations.sort_by_key(|(generation, _)| *generation);
        Ok(generations)
    }

    fn state_path(&self, generation: u64) -> PathBuf {
        self.directory
            .join(format!("{STATE_PREFIX}{generation:020}{STATE_SUFFIX}"))
    }

    fn temporary_path(&self, generation: u64, nonce: uuid::Uuid) -> PathBuf {
        self.directory.join(format!(
            "{TEMP_PREFIX}{generation:020}.{nonce}{TEMP_SUFFIX}"
        ))
    }

    fn lock_path(&self) -> PathBuf {
        self.directory.join(LOCK_FILE_NAME)
    }

    fn recover_stale_temporaries_locked(&self) -> Result<()> {
        let entries = fs::read_dir(&self.directory)
            .map_err(|error| storage_error("read state directory for temp recovery", error))?;
        let mut removed = false;
        let mut first_error = None;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    first_error.get_or_insert_with(|| {
                        storage_error("read state entry for temp recovery", error)
                    });
                    continue;
                }
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !is_private_temporary_filename(name) {
                continue;
            }
            match fs::remove_file(entry.path()) {
                Ok(()) => removed = true,
                Err(error) => {
                    first_error.get_or_insert_with(|| {
                        storage_error("remove stale temporary state", error)
                    });
                }
            }
        }
        if removed {
            if let Err(error) = sync_directory(&self.directory) {
                first_error.get_or_insert(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn read_state_locked(&self, path: &Path) -> Result<Vec<u8>> {
        let mut file =
            File::open(path).map_err(|error| storage_error("open pairwise state", error))?;
        let length = file
            .metadata()
            .map_err(|error| storage_error("read pairwise state metadata", error))?
            .len();
        if length == 0 {
            return Err(PairwiseError::CorruptState(
                "pairwise state file is empty".to_string(),
            ));
        }
        ensure_file_payload_size(length)?;
        #[cfg(test)]
        match self.fault {
            Some(TestFault::ShortRead) => {
                OpenOptions::new()
                    .write(true)
                    .open(path)
                    .map_err(|error| storage_error("inject shorter state read", error))?
                    .set_len(length - 1)
                    .map_err(|error| storage_error("inject shorter state length", error))?;
            }
            Some(TestFault::GrowingRead) => {
                OpenOptions::new()
                    .append(true)
                    .open(path)
                    .map_err(|error| storage_error("inject growing state read", error))?
                    .write_all(b"x")
                    .map_err(|error| storage_error("inject growing state length", error))?;
            }
            _ => {}
        }
        let length = usize::try_from(length).map_err(|_| PairwiseError::InputTooLarge {
            input: "pairwise state",
            limit: MAX_FILE_STORE_PAYLOAD_BYTES,
        })?;
        let mut payload = Vec::new();
        payload.try_reserve_exact(length).map_err(|error| {
            PairwiseError::Storage(format!("allocate pairwise state buffer: {error}"))
        })?;
        payload.resize(length, 0);
        if let Err(error) = file.read_exact(&mut payload) {
            if error.kind() == ErrorKind::UnexpectedEof {
                return Err(PairwiseError::CorruptState(
                    "pairwise state file became shorter while reading".to_string(),
                ));
            }
            return Err(storage_error("read pairwise state", error));
        }
        let mut extra = [0_u8; 1];
        let extra_length = file
            .read(&mut extra)
            .map_err(|error| storage_error("check pairwise state length", error))?;
        let final_length = file
            .metadata()
            .map_err(|error| storage_error("recheck pairwise state metadata", error))?
            .len();
        if extra_length != 0 || final_length != length as u64 {
            return Err(PairwiseError::CorruptState(
                "pairwise state file changed size while reading".to_string(),
            ));
        }
        Ok(payload)
    }

    fn discard_temporary_locked(&self, temporary: &Path) -> Result<()> {
        match fs::remove_file(temporary) {
            Ok(()) => sync_directory(&self.directory),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(storage_error("remove temporary state", error)),
        }
    }

    fn rollback_publish_locked(
        &self,
        temporary: &Path,
        destination: Option<&Path>,
        cause: PairwiseError,
    ) -> PairwiseError {
        let mut cleanup_errors = Vec::new();
        if let Some(destination) = destination {
            if let Err(error) = fs::remove_file(destination) {
                if error.kind() != ErrorKind::NotFound {
                    cleanup_errors.push(storage_error("roll back published state", error));
                }
            }
        }
        if let Err(error) = fs::remove_file(temporary) {
            if error.kind() != ErrorKind::NotFound {
                cleanup_errors.push(storage_error("roll back temporary state", error));
            }
        }
        if let Err(error) = sync_directory(&self.directory) {
            cleanup_errors.push(error);
        }
        if cleanup_errors.is_empty() {
            cause
        } else {
            PairwiseError::Storage(format!(
                "{cause}; rollback also failed: {}",
                cleanup_errors
                    .into_iter()
                    .map(|error| error.to_string())
                    .collect::<Vec<_>>()
                    .join("; ")
            ))
        }
    }

    fn remove_older_generations_locked(&self, generation: u64) -> Result<()> {
        let mut removed = false;
        let mut first_error = None;
        let visit_result = self.visit_generations_locked(|stored_generation, path| {
            if stored_generation >= generation {
                return Ok(());
            }
            match fs::remove_file(path) {
                Ok(()) => removed = true,
                Err(error) => {
                    first_error
                        .get_or_insert_with(|| storage_error("remove older pairwise state", error));
                }
            }
            Ok(())
        });
        if let Err(error) = visit_result {
            first_error.get_or_insert(error);
        }
        if removed {
            if let Err(error) = sync_directory(&self.directory) {
                first_error.get_or_insert(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn cleanup_after_durable_publish_locked(
        &self,
        temporary: &Path,
        generation: u64,
    ) -> Result<()> {
        #[cfg(test)]
        if self.fault == Some(TestFault::Cleanup) {
            return Err(PairwiseError::Storage(
                "injected post-durable cleanup failure".to_string(),
            ));
        }
        let temporary_result = self.discard_temporary_locked(temporary);
        let generations_result = self.remove_older_generations_locked(generation);
        temporary_result.and(generations_result)
    }
}

impl PairwiseStore for FileStore {
    fn load(&self) -> Result<Option<Vec<u8>>> {
        let _lock = self.acquire_lock()?;
        self.recover_stale_temporaries_locked()?;
        let Some((_, path)) = self.highest_generation_locked()? else {
            return Ok(None);
        };
        self.read_state_locked(&path).map(Some)
    }

    fn commit(&self, generation: u64, payload: &[u8]) -> Result<()> {
        ensure_file_payload_size(payload.len() as u64)?;
        let expected = previous_generation(generation)?;
        let _lock = self.acquire_lock()?;
        self.recover_stale_temporaries_locked()?;
        let current = self
            .highest_generation_locked()?
            .map_or(0, |(current, _)| current);
        ensure_current_generation(generation, expected, current)?;

        let destination = self.state_path(generation);
        let temporary = self.temporary_path(generation, uuid::Uuid::new_v4());
        #[cfg(test)]
        if self.fault == Some(TestFault::Write) {
            return Err(PairwiseError::Storage(
                "injected state write failure".to_string(),
            ));
        }
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        set_private_file_mode(&mut options);
        let write_result = (|| -> Result<()> {
            let mut file = options
                .open(&temporary)
                .map_err(|error| storage_error("create temporary state", error))?;
            file.write_all(payload)
                .map_err(|error| storage_error("write temporary state", error))?;
            file.flush()
                .map_err(|error| storage_error("flush temporary state", error))?;
            file.sync_all()
                .map_err(|error| storage_error("sync temporary state", error))
        })();
        if let Err(error) = write_result {
            return Err(self.rollback_publish_locked(&temporary, None, error));
        }

        #[cfg(test)]
        if self.fault == Some(TestFault::Publish) {
            let error = PairwiseError::Storage("injected state publish failure".to_string());
            return Err(self.rollback_publish_locked(&temporary, None, error));
        }
        if let Err(error) = fs::hard_link(&temporary, &destination) {
            let error = storage_error("publish pairwise state without replacement", error);
            return Err(self.rollback_publish_locked(&temporary, None, error));
        }
        #[cfg(test)]
        let durable_result = if self.fault == Some(TestFault::DirectorySync) {
            Err(PairwiseError::Storage(
                "injected state directory sync failure".to_string(),
            ))
        } else {
            sync_directory(&self.directory)
        };
        #[cfg(not(test))]
        let durable_result = sync_directory(&self.directory);
        if let Err(error) = durable_result {
            return Err(self.rollback_publish_locked(&temporary, Some(&destination), error));
        }

        // The destination is durable. Cleanup is recoverable and must not make callers
        // roll their in-memory state back behind the committed generation.
        let _ = self.cleanup_after_durable_publish_locked(&temporary, generation);
        Ok(())
    }

    fn cleanup(&self, generation: u64) {
        if let Ok(_lock) = self.acquire_lock() {
            let _ = self.remove_older_generations_locked(generation);
        }
    }
}

fn parse_generation_filename(name: &str) -> Result<Option<u64>> {
    if !name.starts_with(STATE_PREFIX) || !name.ends_with(STATE_SUFFIX) {
        return Ok(None);
    }
    let raw_generation = &name[STATE_PREFIX.len()..name.len() - STATE_SUFFIX.len()];
    if raw_generation.len() != 20 || !raw_generation.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(PairwiseError::CorruptState(format!(
            "invalid pairwise state filename `{name}`"
        )));
    }
    let generation = raw_generation.parse::<u64>().map_err(|_| {
        PairwiseError::CorruptState(format!("invalid pairwise state filename `{name}`"))
    })?;
    if format!("{generation:020}") != raw_generation {
        return Err(PairwiseError::CorruptState(format!(
            "invalid pairwise state filename `{name}`"
        )));
    }
    Ok(Some(generation))
}

fn is_private_temporary_filename(name: &str) -> bool {
    let Some(body) = name
        .strip_prefix(TEMP_PREFIX)
        .and_then(|name| name.strip_suffix(TEMP_SUFFIX))
    else {
        return false;
    };
    let Some((generation, nonce)) = body.split_once('.') else {
        return false;
    };
    if generation.len() != 20
        || !generation.bytes().all(|byte| byte.is_ascii_digit())
        || generation.parse::<u64>().is_err()
    {
        return false;
    }
    let Ok(parsed_nonce) = uuid::Uuid::parse_str(nonce) else {
        return false;
    };
    parsed_nonce.hyphenated().to_string() == nonce
}

fn previous_generation(generation: u64) -> Result<u64> {
    generation.checked_sub(1).ok_or_else(|| {
        PairwiseError::Storage("state generation zero cannot be committed".to_string())
    })
}

fn ensure_current_generation(generation: u64, expected: u64, current: u64) -> Result<()> {
    if current != expected {
        return Err(PairwiseError::Storage(format!(
            "stale state commit for generation {generation}: expected durable generation \
             {expected}, found {current}"
        )));
    }
    Ok(())
}

fn ensure_file_payload_size(length: u64) -> Result<()> {
    if length > MAX_FILE_STORE_PAYLOAD_BYTES as u64 {
        return Err(PairwiseError::InputTooLarge {
            input: "pairwise state",
            limit: MAX_FILE_STORE_PAYLOAD_BYTES,
        });
    }
    Ok(())
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
fn set_private_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| storage_error("set private file permissions", error))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<()> {
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
    use std::sync::{Arc, Barrier};
    use std::thread;

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
    fn memory_store_rejects_stale_and_same_generation_commits() {
        let store = MemoryStore::default();
        store.commit(1, b"first").expect("first commit");
        store.commit(2, b"second").expect("second commit");

        assert!(matches!(
            store.commit(2, b"same generation"),
            Err(PairwiseError::Storage(_))
        ));
        assert!(matches!(
            store.commit(1, b"stale generation"),
            Err(PairwiseError::Storage(_))
        ));
        assert_eq!(store.load().expect("load"), Some(b"second".to_vec()));
    }

    #[test]
    fn same_file_generation_has_exactly_one_winner() {
        let directory = tempfile::tempdir().expect("tempdir");
        let first = FileStore::new(directory.path()).expect("first store");
        let second = FileStore::new(directory.path()).expect("second store");
        let barrier = Arc::new(Barrier::new(3));

        let first_barrier = Arc::clone(&barrier);
        let first_thread = thread::spawn(move || {
            first_barrier.wait();
            first.commit(1, b"first")
        });
        let second_barrier = Arc::clone(&barrier);
        let second_thread = thread::spawn(move || {
            second_barrier.wait();
            second.commit(1, b"second")
        });
        barrier.wait();

        let results = [
            first_thread.join().expect("first thread"),
            second_thread.join().expect("second thread"),
        ];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
    }

    #[test]
    fn stale_temp_is_removed_on_reopen_without_harming_state_or_near_matches() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = FileStore::new(directory.path()).expect("store");
        store.commit(1, b"committed").expect("commit");
        let stale = store.temporary_path(2, uuid::Uuid::nil());
        fs::write(&stale, b"ratchet secret").expect("seed stale temp");
        let unrelated = directory
            .path()
            .join(".ndr-pairwise-state-v1-00000000000000000002.not-a-uuid.tmp");
        fs::write(&unrelated, b"unrelated").expect("seed near match");
        drop(store);

        let reopened = FileStore::new(directory.path()).expect("reopen");
        assert!(!stale.exists());
        assert!(unrelated.exists());
        assert_eq!(reopened.load().expect("load"), Some(b"committed".to_vec()));
    }

    #[test]
    fn cleanup_from_stale_reader_never_deletes_newer_generation() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = FileStore::new(directory.path()).expect("store");
        store.commit(1, b"first").expect("first commit");
        store.commit(2, b"second").expect("second commit");
        store.commit(3, b"third").expect("third commit");

        store.cleanup(2);

        assert!(store.state_path(3).exists());
        assert_eq!(store.load().expect("load"), Some(b"third".to_vec()));
    }

    #[test]
    fn oversized_state_is_rejected_before_read_allocation_or_write() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = FileStore::new(directory.path()).expect("store");
        File::create(store.state_path(1))
            .expect("oversized file")
            .set_len((MAX_FILE_STORE_PAYLOAD_BYTES as u64) + 1)
            .expect("make sparse file");
        assert!(matches!(
            store.load(),
            Err(PairwiseError::InputTooLarge { .. })
        ));

        fs::remove_file(store.state_path(1)).expect("remove sparse file");
        let oversized = vec![0; MAX_FILE_STORE_PAYLOAD_BYTES + 1];
        assert!(matches!(
            store.commit(1, &oversized),
            Err(PairwiseError::InputTooLarge { .. })
        ));
        assert!(!store.state_path(1).exists());
    }

    #[test]
    fn state_growth_and_short_reads_fail_closed() {
        for fault in [TestFault::ShortRead, TestFault::GrowingRead] {
            let directory = tempfile::tempdir().expect("tempdir");
            let mut store = FileStore::new(directory.path()).expect("store");
            store.commit(1, b"committed").expect("commit");
            store.fault = Some(fault);

            assert!(matches!(store.load(), Err(PairwiseError::CorruptState(_))));
        }
    }

    #[test]
    fn pre_durable_faults_preserve_last_committed_generation() {
        for fault in [
            TestFault::Write,
            TestFault::Publish,
            TestFault::DirectorySync,
        ] {
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

    #[test]
    fn cleanup_failure_after_durable_publish_still_reports_success() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut store = FileStore::new(directory.path()).expect("store");
        store.commit(1, b"first").expect("first commit");
        store.fault = Some(TestFault::Cleanup);

        store
            .commit(2, b"durable second")
            .expect("durable commit must not roll back");
        store.fault = None;
        assert_eq!(
            store.load().expect("load"),
            Some(b"durable second".to_vec())
        );
        store.cleanup(2);
        assert_eq!(
            store
                .generations()
                .expect("generations")
                .into_iter()
                .map(|(generation, _)| generation)
                .collect::<Vec<_>>(),
            vec![2]
        );
    }

    #[cfg(unix)]
    #[test]
    fn directory_lock_and_state_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("tempdir");
        let store = FileStore::new(directory.path()).expect("store");
        store.commit(1, b"secret").expect("commit");

        assert_eq!(
            fs::metadata(directory.path())
                .expect("directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        for path in [store.lock_path(), store.state_path(1)] {
            assert_eq!(
                fs::metadata(path)
                    .expect("private file metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
