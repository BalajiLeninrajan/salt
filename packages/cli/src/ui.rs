//! Terminal output.
//!
//! Two modes, chosen by whether **stderr** is a terminal. The split of streams
//! is a contract, not decoration: the published link and its expiry go to
//! **stdout**, because scripts pipe this and expect the link there, while
//! progress and status go to stderr where they can be discarded.

use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub struct Ui {
    tty: bool,
}

pub fn new() -> Ui {
    Ui {
        tty: std::io::stderr().is_terminal(),
    }
}

impl Ui {
    pub fn intro(&self, msg: &str) {
        // A banner is noise in a pipe.
        if self.tty {
            eprintln!("\x1b[2m┌\x1b[0m  {msg}");
        }
    }

    pub fn log(&self, msg: &str) {
        if self.tty {
            eprintln!("\x1b[2m│\x1b[0m\n\x1b[34m●\x1b[0m  {msg}");
        } else {
            eprintln!("{msg}");
        }
    }

    /// The link and its expiry. Always stdout — this is the output of the tool.
    pub fn outro(&self, msg: &str) {
        if self.tty {
            println!("\x1b[2m│\x1b[0m\n\x1b[2m└\x1b[0m  {msg}\n");
        } else {
            println!("{msg}");
        }
    }

    pub fn spinner(&self) -> Spinner {
        Spinner::new(self.tty)
    }
}

/// A progress indicator that animates on a terminal and stays silent in a pipe.
pub struct Spinner {
    tty: bool,
    /// Shared rather than a channel so the scan can report progress from any
    /// worker thread: `Sender` is `Send` but not `Sync`.
    label: Arc<Mutex<String>>,
    done: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Spinner {
    fn new(tty: bool) -> Spinner {
        Spinner {
            tty,
            label: Arc::new(Mutex::new(String::new())),
            done: Arc::new(AtomicBool::new(false)),
            handle: None,
        }
    }

    pub fn begin(&mut self, msg: &str) {
        if !self.tty {
            eprintln!("{msg}");
            return;
        }
        let done = Arc::clone(&self.done);
        let label = Arc::clone(&self.label);
        if let Ok(mut l) = label.lock() {
            *l = msg.to_string();
        }
        self.handle = Some(thread::spawn(move || {
            const FRAMES: [char; 4] = ['◒', '◐', '◓', '◑'];
            let mut frame = 0;
            while !done.load(Ordering::Relaxed) {
                let current = label.lock().map(|l| l.clone()).unwrap_or_default();
                let mut err = std::io::stderr();
                let _ = write!(err, "\r\x1b[2K\x1b[35m{}\x1b[0m  {current}", FRAMES[frame]);
                let _ = err.flush();
                frame = (frame + 1) % FRAMES.len();
                thread::sleep(Duration::from_millis(80));
            }
        }));
    }

    /// Updates the label. Dropped in a pipe: a progress line per file would
    /// bury whatever the caller actually wanted.
    pub fn message(&self, msg: &str) {
        // No animation thread means nothing reads the label — in a pipe this
        // is every call.
        if self.handle.is_none() {
            return;
        }
        if let Ok(mut l) = self.label.lock() {
            l.clear();
            l.push_str(msg);
        }
    }

    pub fn stop(mut self, msg: &str) {
        self.finish();
        if self.tty {
            eprintln!("\r\x1b[2K\x1b[32m◇\x1b[0m  {msg}");
        } else {
            eprintln!("{msg}");
        }
    }

    fn finish(&mut self) {
        self.done.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for Spinner {
    fn drop(&mut self) {
        // An early return or a `?` further up must not leave the animation
        // thread running and the cursor hidden mid-line.
        self.finish();
    }
}
