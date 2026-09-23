// Copyright 2020 The Evcxr Authors.
//
// Licensed under the Apache License, Version 2.0 <LICENSE or
// https://www.apache.org/licenses/LICENSE-2.0> or the MIT license <LICENSE
// or https://opensource.org/licenses/MIT>, at your option. This file may not be
// copied, modified, or distributed except according to those terms.

use crate::errors::Error;
use crate::errors::bail;
use std::io;
use std::marker::PhantomData;
use std::rc::Rc;
use std::{self};

pub(crate) const EVCXR_IS_RUNTIME_VAR: &str = "EVCXR_IS_RUNTIME";
pub(crate) const EVCXR_EXECUTION_STARTED: &str = "EVCXR_EXECUTION_STARTED";
pub(crate) const EVCXR_EXECUTION_COMPLETE: &str = "EVCXR_EXECUTION_COMPLETE";
pub(crate) const EVCXR_STDERR_COMPLETE: &str = "EVCXR_STDERR_COMPLETE";
pub(crate) const WRAP_RUSTC_ENV: &str = "EVCXR_RUSTC_WRAPPER";
pub(crate) const FORCE_DYLIB_ENV: &str = "EVCXR_FORCE_DYLIB";

/// Binaries can call this just after staring. If we detect that we're actually running as a
/// subprocess, control will not return. There are two kinds of subprocesses that we may be acting
/// as (1) the process that loads and runs the user code and (2) a wrapper around rustc.
pub fn runtime_hook() {
    if std::env::var(EVCXR_IS_RUNTIME_VAR).is_ok() {
        Runtime::new().run_loop();
    }
    if std::env::var(WRAP_RUSTC_ENV).is_ok() {
        crate::module::wrap_rustc();
    }
}

struct Runtime {
    shared_objects: Vec<libloading::Library>,
    variable_store_ptr: *mut std::os::raw::c_void,
    // Our variable store is permitted to contain non-Send types (e.g. Rc), therefore we need to be
    // non-Send as well.
    _phantom_rc: PhantomData<Rc<()>>,
}

impl Runtime {
    fn new() -> Runtime {
        Runtime {
            shared_objects: Vec::new(),
            variable_store_ptr: std::ptr::null_mut(),
            _phantom_rc: PhantomData,
        }
    }

    fn run_loop(&mut self) -> ! {
        use std::io::BufRead;

        self.install_crash_handlers();

        let stdin = std::io::stdin();
        let mut lines = stdin.lock().lines();
        while let Some(line) = lines.next() {
            if let Err(error) = self.handle_line(&line, &mut lines) {
                eprintln!("While processing instruction `{line:?}`, got error: {error:?}",);
                std::process::exit(99);
            }
        }
        std::process::exit(0);
    }

    fn handle_line(
        &mut self,
        line: &io::Result<String>,
        lines: &mut std::io::Lines<std::io::StdinLock<'_>>,
    ) -> Result<(), Error> {
        let line = line.as_ref()?;
        let (command, so_path, fn_name, token): (String, String, String, String) =
            serde_json::from_str(line)
                .map_err(|error| anyhow::anyhow!("Invalid runtime command: {error}"))?;
        if command != "LOAD_AND_RUN"
            || token.len() != 64
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            bail!("Unrecognised line: {}", line);
        }
        self.load_and_run(&so_path, &fn_name, &token, lines)
    }

    fn load_and_run(
        &mut self,
        so_path: &str,
        fn_name: &str,
        token: &str,
        lines: &mut std::io::Lines<std::io::StdinLock<'_>>,
    ) -> Result<(), Error> {
        use std::io::Write;
        use std::os::raw::c_void;
        let shared_object = unsafe { libloading::Library::new(so_path) }?;
        println!("{EVCXR_EXECUTION_STARTED} {token}");
        std::io::stdout().flush()?;
        let run_line = lines
            .next()
            .ok_or_else(|| anyhow::anyhow!("Runtime input closed before RUN acknowledgement"))??;
        let (command, acknowledged_token): (String, String) = serde_json::from_str(&run_line)
            .map_err(|error| anyhow::anyhow!("Invalid RUN acknowledgement: {error}"))?;
        if command != "RUN" || acknowledged_token != token {
            bail!("Invalid RUN acknowledgement: {}", run_line);
        }
        unsafe {
            let user_fn =
                shared_object.get::<extern "C" fn(*mut c_void, *const u8, usize) -> *mut c_void>(
                    fn_name.as_bytes(),
                )?;
            self.variable_store_ptr = user_fn(self.variable_store_ptr, token.as_ptr(), token.len());
        }
        eprintln!("{EVCXR_STDERR_COMPLETE} {token}");
        std::io::stderr().flush()?;
        println!("{EVCXR_EXECUTION_COMPLETE} {token}");
        self.shared_objects.push(shared_object);
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "freebsd")))]
    pub fn install_crash_handlers(&self) {
        use backtrace::Backtrace;
        use sig::ffi::Sig;
        extern "C" fn segfault_handler(signal: i32) {
            eprintln!(
                "{}",
                match signal {
                    Sig::SEGV => "Segmentation fault.",
                    Sig::ILL => "Illegal instruction.",
                    Sig::BUS => "Bus error.",
                    _ => "Unexpected signal.",
                }
            );
            eprintln!("{:?}", Backtrace::new());
            std::process::abort();
        }

        signal!(Sig::SEGV, segfault_handler);
        signal!(Sig::ILL, segfault_handler);
        signal!(Sig::BUS, segfault_handler);
    }

    #[cfg(not(all(unix, not(target_os = "freebsd"))))]
    pub fn install_crash_handlers(&self) {}
}

impl Drop for Runtime {
    fn drop(&mut self) {
        // We never actually unload libraries. This is to prevent segfault on shutdown due to TLS
        // destructors being run that have been unloaded. See ``tests::tls_implementing_drop`. There
        // was some discussion of a similar issue on Mac OS at
        // https://github.com/rust-lang/rust/issues/28794. Other possible options that might be
        // worthwhile investigating are to (A) unregister atexit on unload and leak (B) unregister
        // atexit on unload and run destructor (C) when registering atexit hooks, dlopen the shared
        // object so as to increment its refcount. (D) start a new thread and make sure it
        // terminates before we unload anything. (A) and (B) might be complicated by there not being
        // an API to unregister atexit hooks. This could possibly be solved by building a layer on
        // top of atexit. That extra layer then would need to not be unloaded, but the code that
        // used it could be.
        for shared_object in self.shared_objects.drain(..) {
            std::mem::forget(shared_object);
        }
    }
}
